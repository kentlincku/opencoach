from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVER_SCRIPT = REPO_ROOT / "native" / "python" / "voice_runtime" / "server.py"


class TestVoiceRuntimeServer(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env = {
            **os.environ,
            "VOICE_RUNTIME_TEMP_DIR": self.temp_dir.name,
            "VOICE_RUNTIME_FAKE": "1",
        }

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_server_health_protocol_and_clean_streams(self) -> None:
        """Server stdout must emit ready event and health response; stderr must not leak prompts."""
        proc = subprocess.Popen(
            [sys.executable, "-u", str(SERVER_SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self.env,
            cwd=str(REPO_ROOT),
        )
        try:
            ready_line = proc.stdout.readline().strip()
            ready = json.loads(ready_line)
            self.assertEqual(ready.get("event"), "ready")
            self.assertEqual(ready.get("protocol"), 1)

            # Send health request
            req = {"id": "test-1", "method": "runtime.health", "params": {}}
            proc.stdin.write(json.dumps(req) + "\n")
            proc.stdin.flush()

            resp_line = proc.stdout.readline().strip()
            resp = json.loads(resp_line)
            self.assertEqual(resp["id"], "test-1")
            self.assertTrue(resp["success"])
            result = resp["result"]
            self.assertIn("ready", result)
            self.assertIn("selectedTts", result)
            self.assertIn("selectedStt", result)

            # Perform synthesis
            synth_req = {
                "id": "test-2",
                "method": "tts.synthesize",
                "params": {"text": "Hello world", "voice": "af_heart", "speed": 1.0},
            }
            proc.stdin.write(json.dumps(synth_req) + "\n")
            proc.stdin.flush()

            synth_resp_line = proc.stdout.readline().strip()
            synth_resp = json.loads(synth_resp_line)
            self.assertEqual(synth_resp["id"], "test-2")
            self.assertTrue(synth_resp["success"])
            self.assertIn("audio", synth_resp["result"])

            proc.stdin.close()
            stderr_output = proc.stderr.read()
            self.assertNotIn("Hello world", stderr_output)
            proc.stdout.close()
            proc.stderr.close()
            proc.wait(timeout=5)

        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    if stream and not stream.closed:
                        stream.close()
                except Exception:
                    pass


if __name__ == "__main__":
    unittest.main()
