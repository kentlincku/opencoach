"""CUDA-first accelerator selection with an explicit CPU fallback.

Policy (VOICE_ACCELERATOR):
  auto            use CUDA when the probe passes, otherwise CPU
  cpu             never touch CUDA
  cuda            require CUDA; any CUDA failure is BackendUnavailableError(CUDA_REQUIRED)
Unset: ``auto`` in a development checkout, ``cpu`` in a frozen (packaged) runtime,
because installers are CPU-only and must not pick up a system CUDA by accident.
An explicit value always wins.

DLL trust: only the pip ``nvidia-*`` wheels under the interpreter's
site-packages (site.getsitepackages() + user site; for a frozen runtime only its
own ``_internal`` directory) are considered, and each DLL
is loaded by its full path inside those directories, never by bare name (which
could resolve to an unrelated copy in System32 or the app directory).

Windows trap: pip ``nvidia-*`` wheels put their DLLs in
``site-packages/nvidia/<lib>/bin``, which Windows does not search. If
ctranslate2 later fails to find cuDNN it aborts the whole process instead of
raising. So the probe adds those directories and preloads the required DLLs with
ctypes *before* any CUDA model is built; a missing DLL is a catchable OSError
here and becomes a CPU fallback, never a process abort later.
"""
from __future__ import annotations

import os
import site
import sys
from pathlib import Path

from .backends.base import BackendUnavailableError

POLICIES = ("auto", "cpu", "cuda")
WINDOWS_CUDA_DLLS = (("cublas", "cublas64_12.dll"), ("cublas", "cublasLt64_12.dll"),
                     ("cudnn", "cudnn64_9.dll"), ("cudnn", "cudnn_graph64_9.dll"))
_NVIDIA_LIBS = ("cublas", "cuda_nvrtc", "cudnn")

_dll_handles = []
_added_dirs = set()
_probe_cache = {}


def policy() -> str:
    default = "cpu" if getattr(sys, "frozen", False) else "auto"
    value = os.environ.get("VOICE_ACCELERATOR", "").strip().lower() or default
    if value not in POLICIES:
        raise BackendUnavailableError("runtime", None, "VOICE_ACCELERATOR_INVALID")
    return value


def _site_packages() -> list[str]:
    # Frozen (PyInstaller onedir) runtime: the nvidia wheels are collected under
    # the runtime's own _internal directory; only that directory is trusted.
    if getattr(sys, "frozen", False):
        return [str(Path(sys.executable).absolute().parent / "_internal")]
    paths = list(site.getsitepackages())
    user = site.getusersitepackages()
    if isinstance(user, str):
        paths.append(user)
    return paths


def nvidia_dll_dirs(search_paths=None) -> list[Path]:
    found = []
    for entry in (_site_packages() if search_paths is None else search_paths):
        if not entry:
            continue
        root = Path(entry) / "nvidia"
        for lib in _NVIDIA_LIBS:
            candidate = root / lib / "bin"
            if candidate.is_dir() and candidate not in found:
                found.append(candidate)
    return found


def _register_dll_dirs(dirs) -> None:
    for directory in dirs:
        key = str(directory)
        if key in _added_dirs:
            continue
        os.add_dll_directory(key)
        # ctranslate2 resolves cuDNN's own dependent DLLs through PATH, not the
        # add_dll_directory list; child processes inherit this PATH entry.
        os.environ["PATH"] = key + os.pathsep + os.environ.get("PATH", "")
        _added_dirs.add(key)


def _probe_windows_dlls(loader, dirs=None) -> tuple[bool, str]:
    dirs = nvidia_dll_dirs() if dirs is None else dirs
    by_lib = {d.parent.name: d for d in dirs}
    for lib, name in WINDOWS_CUDA_DLLS:
        path = by_lib.get(lib, Path()) / name
        if lib not in by_lib or not path.is_file():
            return False, "CUDA_DLL_MISSING:" + name
    _register_dll_dirs(dirs)
    for lib, name in WINDOWS_CUDA_DLLS:
        try:
            _dll_handles.append(loader(str(by_lib[lib] / name)))
        except OSError:
            return False, "CUDA_DLL_MISSING:" + name
    return True, ""


def _default_loader(name):
    import ctypes
    return ctypes.WinDLL(name)


def probe(kind: str, *, platform_name=None, loader=None, device_count=None, ort_providers=None,
          dll_dirs=None) -> tuple[bool, str]:
    """Return (cuda_usable, reason). Never raises for a missing GPU or DLL."""
    injected = any(v is not None for v in (platform_name, loader, device_count, ort_providers, dll_dirs))
    if not injected and kind in _probe_cache:
        return _probe_cache[kind]
    result = _probe(kind, platform_name=platform_name or sys.platform, loader=loader or _default_loader,
                    device_count=device_count, ort_providers=ort_providers, dll_dirs=dll_dirs)
    if not injected:
        _probe_cache[kind] = result
    return result


def _probe(kind, *, platform_name, loader, device_count, ort_providers, dll_dirs=None):
    if platform_name != "win32":
        return False, "CUDA_UNSUPPORTED_PLATFORM"
    ok, reason = _probe_windows_dlls(loader, dll_dirs)
    if not ok:
        return False, reason
    try:
        if kind == "stt":
            if device_count is None:
                import ctranslate2
                device_count = ctranslate2.get_cuda_device_count
            if device_count() < 1:
                return False, "CUDA_NO_DEVICE"
        elif kind == "tts":
            if ort_providers is None:
                import onnxruntime
                ort_providers = onnxruntime.get_available_providers
            if "CUDAExecutionProvider" not in ort_providers():
                # e.g. CPU onnxruntime installed over onnxruntime-gpu
                return False, "CUDA_PROVIDER_MISSING"
        else:
            raise ValueError(kind)
    except (ImportError, OSError, RuntimeError, AttributeError):
        return False, "CUDA_PROBE_FAILED"
    return True, ""


def use_cuda(kind: str, **probe_kwargs) -> bool:
    """Apply the policy: True = try CUDA first, False = CPU only."""
    mode = policy()
    if mode == "cpu":
        return False
    ok, reason = probe(kind, **probe_kwargs)
    if ok:
        return True
    if mode == "cuda":
        raise BackendUnavailableError(kind, None, "CUDA_REQUIRED:" + reason)
    return False


def reset_for_tests() -> None:
    _probe_cache.clear()
