"""Windows package entry: model-free probe, lazy backends."""
import multiprocessing

from voice_runtime.server import serve

if __name__ == '__main__':
    # Frozen children (multiprocessing) must not re-run serve() and print a second
    # ready line onto the JSON-RPC stdout.
    multiprocessing.freeze_support()
    serve()
