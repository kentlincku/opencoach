import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).parents[1]


class PackagingContractTests(unittest.TestCase):
    def test_builder_contract_is_release_safe(self):
        package = json.loads((ROOT / "package.json").read_text())
        config = (ROOT / "electron-builder.yml").read_text()
        self.assertEqual(package["scripts"]["pack:mac"], "npm run build:web && electron-builder --mac dmg zip --arm64")
        self.assertEqual(package["scripts"]["pack:win"], "npm run build:web && electron-builder --win nsis portable --x64")
        self.assertEqual(package["scripts"]["dist:dir"], "npm run build:web && electron-builder --dir")
        self.assertEqual(package["scripts"]["test"], "node scripts/run-tests.mjs")
        self.assertEqual(package["version"], "0.2.0-beta.1")
        self.assertIn("artifactName: Voice-Practice-${version}-${arch}.${ext}", config)
        self.assertIn("artifactName: Voice-Practice-Setup-${version}-${arch}.${ext}", config)
        self.assertIn("artifactName: Voice-Practice-Portable-${version}-${arch}.${ext}", config)
        self.assertIn("electron-builder", package["devDependencies"])
        self.assertIn("notarize: false", config)
        self.assertIn("entitlements: build/entitlements.mac.plist", config)
        self.assertTrue((ROOT / "build/entitlements.mac.plist").exists())
        entitlements = (ROOT / "build/entitlements.mac.plist").read_text()
        self.assertIn("com.apple.security.cs.allow-jit", entitlements)
        self.assertIn("com.apple.security.device.audio-input", entitlements)
        self.assertNotIn("com.apple.security.cs.allow-unsigned-executable-memory", entitlements)
        self.assertNotIn("com.apple.security.cs.disable-library-validation", entitlements)
        self.assertTrue((ROOT / "scripts/verify-macos-release.sh").exists())
        self.assertTrue((ROOT / "scripts/verify-windows-release.ps1").exists())
        for required in (
            "appId: com.kentlin.voicepractice", "productName: Voice Practice", "asar: true",
            "files:", "apps/desktop/**", "apps/web/**", "resources/**",
            "target: dmg", "target: zip", "target: nsis", "target: portable",
            "arch:\n        - arm64", "arch:\n        - x64",
        ):
            self.assertIn(required, config)
        for forbidden in (".venv/**", ".runtime/**", "tests/**", "node_modules/**"):
            self.assertNotIn(forbidden, config)

    def test_ci_uses_the_cross_platform_project_test_runner(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        runner = (ROOT / "scripts/run-tests.mjs").read_text()
        self.assertIn("- run: npm test", workflow)
        self.assertNotIn("node --test tests/*.test.cjs", workflow)
        self.assertIn("PYTHON: python", runner)

    def test_public_repository_has_no_binary_publication_workflow(self):
        workflows = ROOT / ".github/workflows"
        self.assertFalse((workflows / "desktop-release.yml").exists())
        self.assertFalse((workflows / "desktop-engineering.yml").exists())
        for workflow_path in workflows.glob("*.yml"):
            workflow = workflow_path.read_text()
            self.assertNotIn("release-signing", workflow)
            self.assertNotIn("upload-artifact", workflow)
            self.assertNotIn("secrets.MACOS", workflow)
            self.assertNotIn("secrets.WINDOWS", workflow)
            self.assertNotIn("ANDROID_RELEASE_", workflow)

    def test_macos_arm64_packaging_contract(self):
        config = (ROOT / "electron-builder.yml").read_text()
        self.assertIn("files:", config)
        self.assertIn("apps/desktop/**", config)
        self.assertIn("apps/web/**", config)
        self.assertIn("resources/**", config)
        self.assertIn("target:\n    - target: dmg\n      arch:\n        - arm64", config)
        self.assertIn("- target: zip\n      arch:\n        - arm64", config)
        self.assertIn("hardenedRuntime: true", config)
        self.assertIn("entitlements: build/entitlements.mac.plist", config)

    def test_workflow_actions_are_pinned_to_full_commit_shas(self):
        import re
        for name in ("ci.yml", "desktop-beta.yml", "ios-beta.yml", "windows-beta.yml", "android-beta.yml"):
            workflow = (ROOT / ".github/workflows" / name).read_text()
            actions = re.findall(r"uses:\s*([^\s]+)", workflow)
            self.assertTrue(actions)
            for action in actions:
                self.assertRegex(action, r"^[^@]+@[0-9a-f]{40}$")

    def test_cloudflare_worker_deploys_built_web_assets(self):
        config = json.loads((ROOT / "wrangler.jsonc").read_text())
        self.assertEqual(config["name"], "opencoach")
        self.assertEqual(config["assets"]["directory"], "./apps/web")
        self.assertEqual(config["assets"]["not_found_handling"], "single-page-application")

    def test_icon_source_and_builder_png_exist(self):
        svg = ROOT / "build/icon-source.svg"
        png = ROOT / "build/icons/512x512.png"
        self.assertTrue(svg.read_text().startswith("<svg"))
        self.assertEqual(png.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")

    def test_ios_packaging_contract_requires_bundled_web_assets(self):
        pbxproj = (ROOT / "apps/ios/VoicePractice.xcodeproj/project.pbxproj").read_text(encoding="utf-8")
        self.assertIn("PBXResourcesBuildPhase", pbxproj)
        self.assertIn("web in Resources", pbxproj)

        ios_web = ROOT / "apps/ios/VoicePractice/Resources/web"
        self.assertTrue((ios_web / "index.html").is_file())
        self.assertTrue((ios_web / "offline.html").is_file())
        self.assertTrue((ios_web / "manifest.webmanifest").is_file())
        self.assertTrue((ios_web / "runtime/runtime-contract.js").is_file())
        self.assertTrue((ios_web / "vendor/transformers.bundle.js").is_file())
        self.assertTrue((ios_web / "vendor/kokoro.bundle.js").is_file())
        self.assertTrue((ios_web / "icons/icon-512.png").is_file())
        self.assertTrue((ios_web / "voices/af_heart.bin").is_file())

    def test_ios_navigation_tests_use_xcode_target_and_app_bundle(self):
        pbxproj = (ROOT / "apps/ios/VoicePractice.xcodeproj/project.pbxproj").read_text(encoding="utf-8")
        navigation_test = (
            ROOT / "apps/ios/Tests/VoicePracticeXCTests/ScriptBridgeHandlerNavigationTests.swift"
        ).read_text(encoding="utf-8")
        handler = (ROOT / "apps/ios/VoicePractice/App/ScriptBridgeHandler.swift").read_text(encoding="utf-8")

        self.assertEqual(
            sum("ScriptBridgeHandlerNavigationTests.swift" in line for line in pbxproj.splitlines()),
            4,
        )
        self.assertEqual(pbxproj.count("A100000F2C7F000100000001"), 2)
        self.assertEqual(pbxproj.count("B100000F2C7F000100000001"), 3)
        self.assertIn("ScriptBridgeHandlerNavigationTests.swift in Sources", pbxproj)
        self.assertIn('Bundle.main.url(forResource: "index"', navigation_test)
        self.assertNotIn("URL(fileURLWithPath: #file)", navigation_test)
        self.assertIn("guard acceptsBridgeMessages else { return }", handler)
        self.assertIn("guard isCurrentNavigation(navigationToken) else { return }", handler)
        self.assertIn("handler?.beginMainFrameNavigation(navigationToken: navigation)", handler)
        self.assertIn(
            "handler?.commitMainFrameNavigation(navigationToken: navigation, url: webView.url)",
            handler,
        )
        self.assertIn(
            "handler?.failMainFrameNavigation(navigationToken: navigation, currentUrl: webView.url)",
            handler,
        )

    def test_ios_native_shell_locks_outer_scroll_and_preserves_inner_scroll(self):
        html = (ROOT / "apps/web/index.html").read_text(encoding="utf-8")
        content_view = (
            ROOT / "apps/ios/VoicePractice/App/ContentView.swift"
        ).read_text(encoding="utf-8")

        self.assertIn('document.documentElement.classList.add("native-ios-app")', content_view)
        self.assertIn('"--native-app-height"', content_view)
        self.assertIn("window.visualViewport", content_view)
        self.assertIn('document.addEventListener("focusin"', content_view)
        self.assertIn('target.scrollIntoView({ block: "nearest", inline: "nearest" })', content_view)
        self.assertIn("webView.scrollView.bounces = false", content_view)
        self.assertIn("webView.scrollView.alwaysBounceVertical = false", content_view)
        self.assertIn("webView.scrollView.alwaysBounceHorizontal = false", content_view)
        self.assertNotIn("webView.scrollView.isScrollEnabled = false", content_view)

        self.assertIn("html.native-ios-app", html)
        self.assertIn("height: var(--native-app-height, 100dvh);", html)
        self.assertIn("overscroll-behavior: none;", html)
        self.assertIn(".native-ios-app .container", html)
        self.assertIn("grid-template-rows: auto auto auto minmax(0, 1fr);", html)
        self.assertIn(".native-ios-app .main-grid", html)
        self.assertRegex(
            html,
            r"\.native-ios-app \.chat-box\s*\{[^}]*height: clamp\(220px, 34dvh, 300px\);",
        )
        self.assertRegex(
            html,
            r"\.native-ios-app \.card,\s*\.native-ios-app \.virtual-coach-card\s*\{[^}]*padding: 14px;",
        )
        self.assertIn("overflow-y: auto;", html)
        self.assertIn("-webkit-overflow-scrolling: touch;", html)
        self.assertIn("env(safe-area-inset-top)", html)
        self.assertIn("env(safe-area-inset-bottom)", html)
        self.assertIn(".modal-card", html)

    def test_embedded_runtime_packaging_contract(self):
        config = (ROOT / "electron-builder.yml").read_text(encoding="utf-8")
        self.assertIn("from: dist/voice-runtime", config)
        self.assertIn("to: runtime", config)
        self.assertNotIn("models/**", config)
        self.assertNotIn(".cache/**", config)


if __name__ == "__main__":
    unittest.main()
