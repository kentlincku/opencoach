"""Pure CPU-runtime policy for the Windows W1 runtime-only build (no I/O side effects).

Shared by scripts/win-build-local-runtime-cpu.py, scripts/win-stage-model-packs.py and
tests/test_windows_cpu_runtime.py. A CPU runtime must never carry CUDA/cuDNN/TensorRT
libraries: neither from pip wheels (onnxruntime-gpu, nvidia-*), nor from wheels that
bundle them (ctranslate2 ships cudnn64_9.dll), nor from a CUDA toolkit on PATH.
"""
import re

# Case-insensitive basename patterns refused anywhere in a CPU runtime tree.
FORBIDDEN_CUDA_PATTERNS = (
    r'cublas.*', r'cublaslt.*', r'cudnn.*', r'nvrtc.*', r'cudart.*', r'cufft.*', r'curand.*', r'cusparse.*',
    r'cusolver.*', r'nvjitlink.*', r'nvinfer.*', r'onnxruntime_providers_cuda.*', r'onnxruntime_providers_tensorrt.*',
)
_FORBIDDEN = re.compile('^(?:' + '|'.join(FORBIDDEN_CUDA_PATTERNS) + r')$', re.I)
# Distributions that must not be installed in the build interpreter.
FORBIDDEN_DISTRIBUTIONS = re.compile(r'^(?:onnxruntime[-_]gpu|onnxruntime[-_]directml|nvidia[-_].*|tensorrt.*|torch)$', re.I)
REQUIRED_DISTRIBUTIONS = {'onnxruntime': '1.30.0', 'ctranslate2': '4.8.2', 'faster-whisper': '1.2.1'}
# Known wheel-bundled CUDA payloads that the CPU build drops (and records) before freezing.
WHEEL_CUDA_DROPS = {('ctranslate2', 'cudnn64_9.dll')}


def forbidden_cuda_files(paths):
    """Return sorted relative paths whose basename is a CUDA/cuDNN/TensorRT library."""
    hits = []
    for rel in paths:
        name = rel.replace('\\', '/').rsplit('/', 1)[-1]
        if _FORBIDDEN.match(name):
            hits.append(rel.replace('\\', '/'))
    return sorted(hits)


def check_distributions(installed):
    """installed: {normalized name: version}. Raise ValueError on any GPU package or wrong pin."""
    norm = {re.sub(r'[-_.]+', '-', k).lower(): v for k, v in installed.items()}
    bad = sorted(k for k in norm if FORBIDDEN_DISTRIBUTIONS.match(k))
    if bad:
        raise ValueError('WIN_CPU_BUILD_GPU_DISTRIBUTION: ' + ','.join(bad))
    for name, version in REQUIRED_DISTRIBUTIONS.items():
        if norm.get(name) != version:
            raise ValueError(f'WIN_CPU_BUILD_PIN: {name}=={version} required, found {norm.get(name)}')
    return True


def sanitized_build_path(system_root):
    """PATH for the PyInstaller subprocess: only %SystemRoot%\\System32 and %SystemRoot%.

    PyInstaller's binary dependency analysis resolves DLLs through PATH; a CUDA toolkit
    on the developer PATH previously leaked cublas64_13.dll/cublasLt64_13.dll into the tree.
    """
    if not isinstance(system_root, str) or not re.fullmatch(r'[A-Za-z]:\\[^;]+', system_root):
        raise ValueError('WIN_CPU_BUILD_SYSTEMROOT')
    root = system_root.rstrip('\\')
    return root + '\\System32;' + root


def filter_binaries(binaries):
    """Drop known wheel-bundled CUDA DLLs from PyInstaller's TOC; return (kept, dropped)."""
    kept, dropped = [], []
    for entry in binaries:
        dest = str(entry[0]).replace('\\', '/')
        name = dest.rsplit('/', 1)[-1].lower()
        if _FORBIDDEN.match(name):
            dropped.append(dest)
        else:
            kept.append(entry)
    return kept, sorted(dropped)


def receipt_gate(files):
    """Final runtime-tree gate. files: iterable of relative paths. Raises on any CUDA payload."""
    hits = forbidden_cuda_files(files)
    if hits:
        raise ValueError('WIN_CPU_RUNTIME_CUDA_PAYLOAD: ' + ','.join(hits))
    return {'cudaPayload': [], 'forbiddenPatterns': list(FORBIDDEN_CUDA_PATTERNS)}
