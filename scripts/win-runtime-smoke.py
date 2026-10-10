#!/usr/bin/env python3
"""Standalone smoke of a built Windows voice-runtime: health, TTS -> STT round-trip.

Env mirrors the App's packaged allowlist (no PATH, no parent env, offline caches).
Usage: python scripts/win-runtime-smoke.py <voice-runtime.exe> <kokoro-dir> <faster-whisper-dir> [auto|cpu|cuda]
"""
import array, base64, io, json, os, subprocess, sys, tempfile, threading, time, wave

runtime, kokoro_dir, whisper_dir = (os.path.abspath(a) for a in sys.argv[1:4])
accel = sys.argv[4] if len(sys.argv) > 4 else 'auto'
tmp = tempfile.mkdtemp(prefix='vprt-')
audio, cache = os.path.join(tmp, 'audio'), os.path.join(tmp, 'cache')
os.mkdir(audio); os.mkdir(cache)
env = {'SYSTEMROOT': os.environ['SYSTEMROOT'], 'WINDIR': os.environ.get('WINDIR', os.environ['SYSTEMROOT']),
       'TEMP': audio, 'TMP': audio, 'VOICE_RUNTIME_TEMP_DIR': audio,
       'HF_HOME': cache, 'XDG_CACHE_HOME': cache, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
       'VOICE_STT_BACKEND': 'faster-whisper', 'VOICE_TTS_BACKEND': 'kokoro-onnx', 'VOICE_KOKORO_EXECUTION_PROVIDER': 'cpu',
       'VOICE_ACCELERATOR': accel, 'VOICE_RUNTIME_DEBUG': '1', 'VOICE_FASTER_WHISPER_MODEL': whisper_dir,
       'VOICE_KOKORO_ONNX_MODEL': os.path.join(kokoro_dir, os.environ.get('SMOKE_KOKORO_MODEL', 'kokoro-v1.0.onnx')),
       'VOICE_KOKORO_ONNX_VOICES': os.path.join(kokoro_dir, 'voices-v1.0.bin')}
t0 = time.time()
p = subprocess.Popen([runtime], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, encoding='utf-8')
errbuf = []  # drain stderr continuously: ORT warnings would otherwise fill the pipe and stall the runtime
threading.Thread(target=lambda: errbuf.extend(p.stderr), daemon=True).start()
print('boot', round(time.time() - t0, 2), p.stdout.readline().strip())


def call(i, m, params):
    t = time.time(); p.stdin.write(json.dumps({'id': i, 'method': m, 'params': params}) + '\n'); p.stdin.flush()
    return json.loads(p.stdout.readline()), round(time.time() - t, 2)


r, dt = call('h', 'runtime.health', {}); print('health', dt, json.dumps(r.get('result') or r)[:600])
ok = r['success'] and r['result']['ready']
texts = ['Hello, I would like to practice ordering coffee today.', 'Could I get a medium latte with oat milk, please?',
         'I have three questions about the meeting on Friday.']
for n, text in enumerate(texts):
    r, dt = call(f't{n}', 'tts.synthesize', {'text': text, 'voice': 'af_heart', 'speed': 1.0})
    if not r['success']: print('tts FAIL', r); ok = False; break
    w = wave.open(io.BytesIO(base64.b64decode(r['result']['audio'])))
    x = array.array('h', w.readframes(w.getnframes())); sr = w.getframerate()
    print('tts', dt, 's', r['result'].get('engine'), sr, 'Hz', round(len(x) / sr, 2), 's audio')
    step = sr / 16000; y = array.array('h', (x[min(int(i * step), len(x) - 1)] for i in range(int(len(x) / step))))
    path = os.path.join(audio, f'in{n}.wav'); o = wave.open(path, 'wb'); o.setnchannels(1); o.setsampwidth(2); o.setframerate(16000); o.writeframes(y.tobytes()); o.close()
    r, dt = call(f's{n}', 'stt.transcribe', {'audioPath': path, 'language': 'en'})
    print('stt', dt, 's', json.dumps(r.get('result') or r)[:200])
    norm = lambda s: ''.join(c for c in s.lower() if c.isalnum() or c == ' ').split()
    ok = ok and r['success'] and norm(r['result']['text']) == norm(text)
p.stdin.close(); p.wait(60); time.sleep(0.5)
err = ''.join(errbuf)
print('stderr tail:', err[-600:].strip() or '(empty)')
print('exit', p.returncode)
print('SMOKE', accel, 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
