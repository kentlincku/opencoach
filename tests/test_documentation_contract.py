import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PublicRepositoryContractTests(unittest.TestCase):
    def read(self, relative):
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_required_public_entry_points_exist(self):
        for relative in (
            "README.md",
            "LICENSE",
            "NOTICE",
            "THIRD_PARTY_NOTICES.md",
            "CONTRIBUTING.md",
            "SECURITY.md",
            "CODE_OF_CONDUCT.md",
            "SUPPORT.md",
            "ARCHITECTURE.md",
            "docs/RELEASE_STATUS.md",
            "docs/SOURCE_PROVENANCE.md",
        ):
            with self.subTest(relative=relative):
                self.assertTrue((ROOT / relative).is_file(), relative)

    def test_license_and_package_metadata_are_public_and_explicit(self):
        license_text = self.read("LICENSE")
        self.assertIn("Apache License", license_text)
        self.assertIn("Version 2.0, January 2004", license_text)

        package = json.loads(self.read("package.json"))
        self.assertEqual(package["license"], "Apache-2.0")
        self.assertTrue(package["private"], "Electron app must not be published to npm accidentally")
        self.assertEqual(
            package["repository"]["url"],
            "git+https://github.com/kentlincku/opencoach.git",
        )

    def test_internal_development_records_are_not_in_public_tree(self):
        self.assertFalse((ROOT / "CLAUDE.md").exists())
        self.assertFalse((ROOT / "docs/handoffs").exists())
        self.assertFalse((ROOT / "docs/testing/raw").exists())
        self.assertFalse((ROOT / "tools/gradio_diagnostics").exists())
        self.assertFalse((ROOT / "packages").exists())

    def test_release_status_does_not_overclaim_binary_readiness(self):
        readme = self.read("README.md")
        release = self.read("docs/RELEASE_STATUS.md")
        for value in (
            "not signed with an Apple Developer ID or notarized",
            "Open Anyway",
            "SHA256SUMS.txt",
            "no App Store or TestFlight release",
            "Nothing large is bundled",
        ):
            self.assertIn(value, readme)
        self.assertIn("unsigned engineering pre-release", release)
        self.assertIn("no signed, notarized, production-supported binary release", release)
        self.assertIn("not stored in git", release.lower())

    def test_faster_whisper_is_not_committed_as_vendored_package(self):
        requirements = self.read("spikes/packaged-runtime/requirements-windows-x64.in")
        self.assertNotIn("packages/faster_whisper", requirements)
        self.assertFalse(any((ROOT / "spikes/packaged-runtime").glob("*.whl")))

    def test_markdown_local_links_resolve(self):
        link_pattern = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
        failures = []
        for path in ROOT.rglob("*.md"):
            if any(part in {".git", "node_modules", ".venv", "dist"} for part in path.parts):
                continue
            for _text, href in link_pattern.findall(path.read_text(encoding="utf-8")):
                href = href.split("#", 1)[0].strip()
                if not href or href.startswith(("http://", "https://", "mailto:")):
                    continue
                target = (path.parent / href).resolve()
                if not target.exists():
                    failures.append(f"{path.relative_to(ROOT)} -> {href}")
        self.assertEqual(failures, [])

    def test_documentation_contains_no_personal_absolute_paths(self):
        forbidden = re.compile(
            r"(?:[A-Za-z]:\\Users\\(?!<name>(?:\\|$)|USER(?:\\|$))[A-Za-z0-9._-]+|"
            r"/Users/(?!<name>(?:/|$)|USER(?:/|$))[A-Za-z0-9._-]+|"
            r"/home/(?!<name>(?:/|$)|USER(?:/|$))[A-Za-z0-9._-]+|/opt/data/)"
        )
        failures = []
        for path in ROOT.rglob("*.md"):
            if any(part in {".git", "node_modules", ".venv", "dist"} for part in path.parts):
                continue
            if forbidden.search(path.read_text(encoding="utf-8", errors="replace")):
                failures.append(str(path.relative_to(ROOT)))
        self.assertEqual(failures, [])

    def test_codeowners_covers_security_sensitive_trees(self):
        text = self.read(".github/CODEOWNERS")
        for required in (
            "/apps/web/",
            "/apps/desktop/",
            "/apps/ios/",
            "/native/python/",
            "/.github/workflows/",
        ):
            self.assertIn(required, text)


if __name__ == "__main__":
    unittest.main()
