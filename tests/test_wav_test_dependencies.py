"""Portable numerical test bootstrap; no ML runtime installation required."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class WavTestDependenciesTest(unittest.TestCase):
    def test_numpy_is_pinned_hash_locked_and_installed_before_ci_tests(self):
        requirements = ROOT / "requirements-test.txt"
        self.assertTrue(requirements.is_file(), "Numerical WAV tests need a test-only lock")
        text = requirements.read_text(encoding="utf-8")
        entries = " ".join(line for line in text.splitlines() if not line.startswith("#"))
        self.assertRegex(entries, r"^numpy==2\.4\.6\s")
        hashes = re.findall(r"--hash=sha256:([a-f0-9]{64})", entries)
        self.assertGreaterEqual(len(hashes), 6, "Cover CPython 3.11/3.13 Windows/macOS/Linux wheels")
        self.assertEqual(len(hashes), len(set(hashes)))
        self.assertEqual(re.sub(r"numpy==2\.4\.6|--hash=sha256:[a-f0-9]{64}|[\s\\]", "", entries), "")
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        install = "python -m pip install --require-hashes --only-binary=:all: -r requirements-test.txt"
        self.assertIn(install, workflow)
        self.assertLess(workflow.index(install), workflow.index("- run: npm test"))
        self.assertIn("python-version: '3.11'", workflow)
