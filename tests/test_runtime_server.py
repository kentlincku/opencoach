import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "native" / "python" / "voice_runtime" / "server.py"
os.environ.setdefault("VOICE_RUNTIME_TEMP_DIR", tempfile.gettempdir())
from native.python.voice_runtime import server


class PureRuntimeProbeTest(unittest.TestCase):
    def test_actual_probe_producer_maps_platform_arch_and_js_validator_accepts_wire_result(self):
        from contextlib import redirect_stdout
        from io import StringIO
        actual = []
        for host, machine, expected_platform, expected_arch in [
            ("win32", "AMD64", "windows", "x64"), ("darwin", "aarch64", "darwin", "arm64")
        ]:
            with patch.object(server.sys, "platform", host), patch.object(server.platform, "machine", return_value=machine):
                response = server.runtime_probe()
                self.assertEqual((response['platform'], response['arch']), (expected_platform, expected_arch))
                actual.append([response, host, expected_arch])
        code = "const {isCompatibleRuntimeProbe}=require('./apps/desktop/runtime-health.cjs');const fs=require('node:fs');console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(x=>isCompatibleRuntimeProbe(...x))));"
        compared = subprocess.run(["node", "-e", code], cwd=ROOT, input=json.dumps(actual), text=True, capture_output=True, timeout=10)
        self.assertEqual(compared.returncode, 0, compared.stderr)
        self.assertEqual(json.loads(compared.stdout), [True, True])
        output, errors = StringIO(), StringIO()
        from contextlib import redirect_stderr
        # Exercise original JSONL dispatcher in-memory, never spawn a native runtime.
        with (patch.object(server.sys, "stdin", StringIO('{"id":"p","method":"runtime.probe","params":{}}\n')),
              redirect_stdout(output), redirect_stderr(errors)):
            server.serve()
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0], {"event": "ready", "protocol": 1})
        self.assertEqual(messages[1], {"id": "p", "success": True, "result": server.runtime_probe()})
        self.assertEqual(errors.getvalue(), "")

    def test_probe_is_pure_and_dispatch_requires_exact_empty_params(self):
        self.assertTrue(callable(getattr(server, "runtime_probe", None)))
        from contextlib import redirect_stdout
        from io import StringIO
        output = StringIO()
        # Calls to model/health machinery are fatal, never swallowed assertions.
        with patch.object(server, "backend_registry", None), patch.object(
            server, "create_backend_registry", side_effect=RuntimeError("MODEL_INIT_FORBIDDEN")
        ), patch.object(server, "health_capabilities", side_effect=RuntimeError("HEALTH_FORBIDDEN")), patch.object(
            server, "runtime_platform", return_value="windows"
        ), patch.object(server, "runtime_arch", return_value="x64"), redirect_stdout(output):
            expected = {"probeVersion": 1, "protocol": 1, "platform": "windows", "arch": "x64", "executable": True}
            self.assertEqual(server.runtime_probe(), expected)
            self.assertEqual(server.dispatch("runtime.probe", {}), expected)
            for params in [None, [], True, "", {"ready": False}, {"protocol": 1}]:
                with self.subTest(params=params), self.assertRaises(server.BackendInputError):
                    server.dispatch("runtime.probe", params)
        self.assertEqual(output.getvalue(), "")


class Utf8PipeTest(unittest.TestCase):
    def test_pipes_are_utf8_whatever_the_locale(self):
        # Node writes UTF-8; on Windows Python defaults pipes to the ANSI code page (cp950),
        # which turns an LLM's em dash into mojibake that the English G2P rejects. An id
        # echo cannot detect this (a single-byte code page round-trips bytes), so check the
        # decoded text the server sees.
        code = ("import sys; sys.path.insert(0, sys.argv[1]); import server; server._utf8_stdio(); "
                "line = sys.stdin.readline(); print(len(line.strip()), sys.stdin.encoding, sys.stdout.encoding)")
        env = {**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"}
        out = subprocess.run([sys.executable, "-c", code, str(SERVER.parent)], input="\u2014\u0101\n".encode("utf-8"),
                             capture_output=True, env=env, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.decode().split(), ["2", "utf-8", "utf-8"])


class RuntimeServerContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = {**os.environ, "VOICE_RUNTIME_FAKE": "1", "VOICE_RUNTIME_TEMP_DIR": tempfile.gettempdir()}
        cls.proc = subprocess.Popen(
            [sys.executable, "-u", str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        ready = json.loads(cls.proc.stdout.readline())
        assert ready == {"event": "ready", "protocol": 1}

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)

    def request(self, request_id, method, params=None):
        payload = {"id": request_id, "method": method, "params": params or {}}
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def test_health_contract(self):
        response = self.request("health-1", "runtime.health")
        self.assertEqual(response["id"], "health-1")
        self.assertTrue(response["success"])
        self.assertEqual(response["result"]["protocol"], 1)
        self.assertTrue(response["result"]["fake"])

        capabilities = response["result"]
        self.assertIsInstance(capabilities["platform"], str)
        self.assertTrue(capabilities["platform"])
        self.assertIsInstance(capabilities["arch"], str)
        self.assertTrue(capabilities["arch"])
        self.assertEqual(capabilities["sttBackends"], ["fake"])
        self.assertEqual(capabilities["ttsBackends"], ["fake"])
        self.assertEqual(capabilities["selectedStt"], "fake")
        self.assertEqual(capabilities["selectedTts"], "fake")
        self.assertIs(capabilities["ready"], True)
        self.assertIsNone(capabilities["degradedReason"])

    def test_tts_returns_valid_wav(self):
        response = self.request("tts-1", "tts.synthesize", {
            "text": "Hello", "voice": "af_heart", "speed": 1.0
        })
        self.assertEqual(response["id"], "tts-1")
        self.assertTrue(response["success"])
        raw = base64.b64decode(response["result"]["audio"])
        with wave.open(BytesIO(raw), "rb") as wav:
            self.assertEqual(wav.getframerate(), 24000)
            self.assertEqual(wav.getnchannels(), 1)

    def test_stt_contract(self):
        audio_path = os.path.join(tempfile.gettempdir(), "fake.webm")
        response = self.request("stt-1", "stt.transcribe", {"audioPath": audio_path})
        self.assertTrue(response["success"])
        self.assertEqual(response["result"]["text"], "Fake transcription")

    def test_invalid_language_is_rejected(self):
        audio_path = os.path.join(tempfile.gettempdir(), "fake.webm")
        response = self.request("stt-language", "stt.transcribe", {
            "audioPath": audio_path,
            "language": "../../secret",
        })
        self.assertFalse(response["success"])
        self.assertEqual(response["error"]["code"], "INVALID_LANGUAGE")

    def test_outside_audio_path_is_rejected(self):
        response = self.request("stt-outside", "stt.transcribe", {"audioPath": "/etc/passwd"})
        self.assertEqual(response["id"], "stt-outside")
        self.assertFalse(response["success"])
        self.assertIn("AUDIO_PATH_OUTSIDE_RUNTIME_TEMP", response["error"]["message"])

    def test_error_preserves_request_id(self):
        response = self.request("bad-1", "unknown.method")
        self.assertEqual(response["id"], "bad-1")
        self.assertFalse(response["success"])
        self.assertIn("UNKNOWN_METHOD", response["error"]["code"])


class RuntimeDispatchValidationTest(unittest.TestCase):
    def test_rejects_non_object_params_and_wrong_tts_types(self):
        with self.assertRaisesRegex(ValueError, "INVALID_PARAMS"):
            server.dispatch("tts.synthesize", [])
        with self.assertRaisesRegex(ValueError, "INVALID_TEXT"):
            server.dispatch("tts.synthesize", {"text": {"nested": True}})
        with self.assertRaisesRegex(ValueError, "INVALID_SPEED"):
            server.dispatch("tts.synthesize", {"text": "Hello", "speed": True})

    def test_region_language_is_normalized_before_registry_call(self):
        calls = []

        class Registry:
            def transcribe(self, path, language):
                calls.append((path, language))
                return {"text": "ok"}

        with patch.object(server, "backend_registry", Registry()):
            server.dispatch("stt.transcribe", {"audioPath": "/tmp/a.wav", "language": "en-US"})

        self.assertEqual(calls, [("/tmp/a.wav", "en")])


class RuntimeWireSanitizationTest(unittest.TestCase):
    def test_invalid_request_id_is_not_reflected_as_protocol_id(self):
        env = {**os.environ, "VOICE_RUNTIME_FAKE": "1", "VOICE_RUNTIME_TEMP_DIR": tempfile.gettempdir()}
        completed = subprocess.run(
            [sys.executable, "-u", str(SERVER)],
            input=json.dumps({"id": {"private": "detail"}, "method": "runtime.health", "params": {}}) + "\n",
            text=True,
            capture_output=True,
            env=env,
            check=True,
            timeout=5,
        )

        response = json.loads(completed.stdout.splitlines()[1])
        self.assertIsNone(response["id"])
        self.assertEqual(response["error"]["code"], "MISSING_REQUEST_ID")

    def test_invalid_payload_does_not_echo_private_details_to_wire_or_stderr(self):
        private_detail = "/home/alice/private/model.bin"
        request = {
            "id": "sanitize",
            "method": "tts.synthesize",
            "params": {"text": {"asset": private_detail}},
        }
        env = {**os.environ, "VOICE_RUNTIME_FAKE": "1", "VOICE_RUNTIME_TEMP_DIR": tempfile.gettempdir()}
        completed = subprocess.run(
            [sys.executable, "-u", str(SERVER)],
            input=json.dumps(request) + "\n",
            text=True,
            capture_output=True,
            env=env,
            check=True,
            timeout=5,
        )

        self.assertNotIn(private_detail, completed.stdout)
        self.assertNotIn(private_detail, completed.stderr)
        response = json.loads(completed.stdout.splitlines()[1])
        self.assertEqual(response["error"], {"code": "INVALID_TEXT", "message": "INVALID_TEXT"})


class RuntimeUnavailableBackendTest(unittest.TestCase):
    def test_unavailable_backend_returns_structured_error_and_server_stays_alive(self):
        env = {
            **os.environ,
            "VOICE_RUNTIME_TEMP_DIR": tempfile.gettempdir(),
            "VOICE_RUNTIME_FAKE": "0",
            "VOICE_STT_BACKEND": "missing-stt",
            "VOICE_TTS_BACKEND": "missing-tts",
        }
        requests = "\n".join([
            json.dumps({
                "id": "unavailable-1",
                "method": "stt.transcribe",
                "params": {"audioPath": os.path.join(tempfile.gettempdir(), "missing.wav")},
            }),
            json.dumps({"id": "health-after-error", "method": "runtime.health", "params": {}}),
            "",
        ])
        completed = subprocess.run(
            [sys.executable, "-u", str(SERVER)],
            input=requests,
            text=True,
            capture_output=True,
            env=env,
            timeout=10,
            check=True,
        )
        messages = [json.loads(line) for line in completed.stdout.splitlines()]

        self.assertEqual(messages[0], {"event": "ready", "protocol": 1})
        self.assertFalse(messages[1]["success"])
        self.assertEqual(messages[1]["error"]["code"], "BACKEND_UNAVAILABLE")
        self.assertEqual(messages[2]["id"], "health-after-error")
        self.assertTrue(messages[2]["success"])


if __name__ == "__main__":
    unittest.main()


class SpeechTextFoldingTest(unittest.TestCase):
    def test_accented_latin_and_typographic_quotes_fold_to_ascii(self):
        from native.python.voice_runtime.text import clean_text_for_speech
        self.assertEqual(clean_text_for_speech('Welcome to the caf\u00e9! A na\u00efve r\u00e9sum\u00e9.'),
                         'Welcome to the cafe! A naive resume.')
        self.assertEqual(clean_text_for_speech('I\u2019m \u201cfine\u201d \u2013 thanks'), 'I\'m "fine", thanks')
        self.assertEqual(clean_text_for_speech('\u4e2d\u6587 test'), 'test')

    def test_markdown_lists_and_free_dashes_become_pauses(self):
        from native.python.voice_runtime.text import clean_text_for_speech
        from native.python.voice_runtime.english_g2p import preflight
        reply = 'Here are our prices:\n\n- **Small:** $3.50\n- **Large:** $5.50\n\nAnything else?'
        cleaned = clean_text_for_speech(reply)
        self.assertEqual(cleaned, 'Here are our prices: Small: $3.50, Large: $5.50. Anything else?')
        preflight(cleaned)
        self.assertEqual(clean_text_for_speech("It's well-known - really."), "It's well-known, really.")
