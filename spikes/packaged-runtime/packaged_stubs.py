"""Import stubs for the packaged Darwin speech runtime (loaded by darwin-entry.py before any backend).

mlx-whisper's timing.py imports numba and scipy.signal at module import time, but only uses them
for word-level timestamps, which this runtime never requests. Both are excluded from the bundle:
  - numba: importing real numba initialises llvmlite, which maps executable memory without
    MAP_JIT and is killed under hardened runtime;
  - scipy (61 MB plus its own 21 MB OpenBLAS): pure size; nothing else on the runtime path imports it.
The stubs keep `import mlx_whisper` working and make any accidental use fail loudly.
"""
import importlib.machinery
import sys
import types

NUMBA_ERROR = 'NUMBA_UNAVAILABLE_IN_PACKAGED_RUNTIME'
SCIPY_ERROR = 'SCIPY_UNAVAILABLE_IN_PACKAGED_RUNTIME'


def _blocked(code):
    def blocked(*_args, **_kwargs):
        raise RuntimeError(code)
    return blocked


def _numba_unavailable(*_args, **_kwargs):
    def decorate(_function):
        return _blocked(NUMBA_ERROR)
    return decorate


def _scipy_attribute(name):
    if name.startswith('__'):
        raise AttributeError(name)
    raise RuntimeError(SCIPY_ERROR)


def install(modules=sys.modules):
    """Register the stubs unless a real module is already importable in this process."""
    numba = types.ModuleType('numba')
    numba.jit = numba.njit = _numba_unavailable
    numba.prange = range
    modules.setdefault('numba', numba)

    scipy = types.ModuleType('scipy')
    signal = types.ModuleType('scipy.signal')
    signal.medfilt = _blocked(SCIPY_ERROR)
    signal.__getattr__ = _scipy_attribute
    scipy.signal = signal
    scipy.__getattr__ = _scipy_attribute
    scipy.__path__ = []  # a package, so `from scipy import signal` resolves to the stub above
    # A real ModuleSpec keeps importlib.util.find_spec() from raising ValueError on the stub.
    for module in (numba, scipy, signal):
        module.__spec__ = importlib.machinery.ModuleSpec(module.__name__, None, is_package=module is scipy)
    modules.setdefault('scipy', scipy)
    modules.setdefault('scipy.signal', signal)
