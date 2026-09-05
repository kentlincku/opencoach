import pathlib
import unittest

ROOT = pathlib.Path(__file__).parents[1]


class DesktopReleaseIpcTests(unittest.TestCase):
    def test_runtime_install_ipc_has_no_renderer_controlled_location_or_integrity(self):
        main = (ROOT / "apps/desktop/main.cjs").read_text()
        preload = (ROOT / "apps/desktop/preload.cjs").read_text()
        for channel in ("runtime:status", "runtime:install", "runtime:cancel"):
            self.assertIn(channel, main)
            self.assertIn(channel, preload)
        self.assertIn("new RuntimeManager", main)
        self.assertNotIn("runtimeInstall: payload", preload)

    def test_ipc_is_restricted_to_exact_product_main_frame(self):
        main = (ROOT / "apps/desktop/main.cjs").read_text()
        self.assertIn("trustedRendererUrl", main)
        self.assertIn("isTrustedMainFrame(event, mainWindow.webContents)", main)
        self.assertNotIn("senderUrl.startsWith('file://')", main)
        self.assertNotIn("url.startsWith('file://')", main)

    def test_production_runtime_install_uses_real_health_check_and_manifest_failure_degrades(self):
        main = (ROOT / "apps/desktop/main.cjs").read_text()
        self.assertIn("healthCheck: validateRuntimeEntrypoint", main)
        self.assertIn("createUnavailableRuntimeManager", main)
        self.assertIn("createUnavailableModelManager", main)
        self.assertIn("Runtime manifest unavailable", main)
        self.assertIn("Model manifest unavailable", main)
        self.assertIn("--smoke-test", main)
        self.assertIn("PACKAGED_APP_SMOKE_OK", main)

    def test_normal_startup_readies_sidecar_before_loading_renderer(self):
        main = (ROOT / "apps/desktop/main.cjs").read_text()
        self.assertLess(main.rindex("await startRuntime()"), main.rindex("await createWindow()"))

    def test_desktop_enforces_single_instance(self):
        main = (ROOT / "apps/desktop/main.cjs").read_text()
        self.assertIn("app.requestSingleInstanceLock()", main)
        self.assertIn("second-instance", main)

    def test_window_security_boundaries_remain_enabled(self):
        main = (ROOT / "apps/desktop/main.cjs").read_text()
        self.assertIn("contextIsolation: true", main)
        self.assertIn("nodeIntegration: false", main)
        self.assertIn("sandbox: true", main)
        self.assertIn("assertTrustedSender", main)
        self.assertIn("details.resourceType === 'script'", main)


if __name__ == "__main__":
    unittest.main()
