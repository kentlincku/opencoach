import sys
import types

import voice_runtime
import voice_runtime.backend_registry
import voice_runtime.backends
import voice_runtime.backends.base

m_native = types.ModuleType('native')
m_python = types.ModuleType('native.python')
m_native.python = m_python
m_python.voice_runtime = voice_runtime

sys.modules['native'] = m_native
sys.modules['native.python'] = m_python
sys.modules['native.python.voice_runtime'] = voice_runtime
sys.modules['native.python.voice_runtime.backend_registry'] = voice_runtime.backend_registry
sys.modules['native.python.voice_runtime.backends'] = voice_runtime.backends
sys.modules['native.python.voice_runtime.backends.base'] = voice_runtime.backends.base
