"""Tiny shared corpus: Python stdlib independently checks actual JS canonicalizer."""
import hashlib
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AssetInventoryContractTest(unittest.TestCase):
    def test_python_node_canonical_parity(self):
        corpus = [("a/z", b"\x00\xff"), ("Z", b""), ("a/A", "語音".encode()), ("_", b"x")]
        files = [{"path": p, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for p, data in corpus]
        canonical = "".join(f"{f['path']}:{f['bytes']}:{f['sha256']}\n" for f in sorted(files, key=lambda f: f['path'])).encode()
        # Node is an algorithm comparator, not a runtime/model child.
        code = "const {canonicalInventory}=require('./apps/desktop/tree-integrity.cjs');const fs=require('node:fs');process.stdout.write(JSON.stringify(canonicalInventory(JSON.parse(fs.readFileSync(0,'utf8')))));"
        result = subprocess.run(["node", "-e", code], cwd=ROOT, input=json.dumps(files), text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads(result.stdout)
        self.assertEqual(actual['treeDigest'], hashlib.sha256(canonical).hexdigest())
        self.assertEqual(actual['files'], sorted(files, key=lambda f: f['path']))
        self.assertEqual(actual['fileCount'], len(files))
        self.assertEqual(actual['totalBytes'], sum(f['bytes'] for f in files))


if __name__ == '__main__':
    unittest.main()
