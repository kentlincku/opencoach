"""Package entry: stdlib/first-party lazy bootstrap, model-free probe."""
import multiprocessing
import sys

# mlx-whisper's timing.py imports numba and scipy.signal, used only for word timestamps,
# which this runtime never requests; both are excluded from the bundle (see packaged_stubs).
import packaged_stubs
packaged_stubs.install()

from voice_runtime.server import serve

if __name__ == '__main__':
    # Frozen binaries must route multiprocessing children (e.g. resource tracker
    # spawned by MLX/tokenizers) away from serve(); otherwise each child prints a
    # second "ready" line onto the JSON-RPC stdout.
    multiprocessing.freeze_support()
    serve()
