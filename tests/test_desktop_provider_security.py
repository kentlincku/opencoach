import pathlib
import unittest

ROOT = pathlib.Path(__file__).parents[1]
HTML = (ROOT / "apps/web/index.html").read_text(encoding="utf-8")
MAIN = (ROOT / "apps/desktop/main.cjs").read_text(encoding="utf-8")
PRELOAD = (ROOT / "apps/desktop/preload.cjs").read_text(encoding="utf-8")


class DesktopProviderSecurityTests(unittest.TestCase):
    def test_preload_exposes_only_write_only_credential_controls_and_broker(self):
        for name in ("providerCredentialHas", "providerCredentialSet", "providerCredentialClear", "providerOperation"):
            self.assertIn(name, PRELOAD)
        self.assertNotIn("providerCredentialGet", PRELOAD)
        self.assertNotIn("credential:get", MAIN)

    def test_main_owns_safe_storage_and_broker(self):
        self.assertIn("safeStorage", MAIN)
        self.assertIn("new CredentialStore", MAIN)
        self.assertIn("new ProviderBroker", MAIN)
        self.assertIn("credential:has", MAIN)
        self.assertIn("credential:set", MAIN)
        self.assertIn("credential:clear", MAIN)
        self.assertIn("provider:operation", MAIN)

    def test_subscription_oauth_is_owned_by_main_and_exposes_only_typed_operations(self):
        for name in (
            "subscriptionCapabilities", "subscriptionBeginLogin", "subscriptionPollLogin", "subscriptionCancelLogin",
            "subscriptionStatus", "subscriptionLogout", "subscriptionOperation",
        ):
            self.assertIn(name, PRELOAD)
        self.assertNotIn("subscriptionToken", PRELOAD)
        self.assertNotIn("subscription:get-token", MAIN)
        self.assertIn("new SubscriptionAuthBroker", MAIN)
        for channel in (
            "subscription:capabilities", "subscription:begin-login", "subscription:poll-login", "subscription:cancel-login",
            "subscription:status", "subscription:logout", "subscription:operation",
        ):
            self.assertIn(channel, MAIN)
        self.assertIn("VOICE_OPENAI_CODEX_CLIENT_ID", MAIN)
        self.assertIn("VOICE_XAI_OAUTH_CLIENT_ID", MAIN)
        self.assertIn("VOICE_XAI_OAUTH_SCOPE", MAIN)
        self.assertIn("namespace: 'subscription'", MAIN)
        self.assertIn("credentialStore = new CredentialStore({ userData, safeStorage });", MAIN)
        self.assertIn("credentialStore: subscriptionTokenStore", MAIN)

    def test_electron_web_path_migrates_then_deletes_legacy_keys(self):
        self.assertIn("migrateDesktopProviderCredentials", HTML)
        migration = HTML.split("async function migrateDesktopProviderCredentials", 1)[1].split("\n}", 1)[0]
        self.assertIn("providerCredentialSet", migration)
        self.assertIn('localStorage.removeItem("vp_provider_keys")', migration)
        self.assertIn('localStorage.removeItem("vp_apiKey")', migration)

    def test_electron_provider_requests_use_broker_without_renderer_key(self):
        request = HTML.split("async function requestProviderChat", 1)[1].split("function populateModelSelect", 1)[0]
        self.assertIn("window.electronAPI.providerOperation", request)
        self.assertNotIn("apiKey,", request.split("providerOperation", 1)[1].split(")", 1)[0])
        models = HTML.split("async function fetchModelsFromProvider", 1)[1].split("function onModelDropdownChange", 1)[0]
        self.assertIn("window.electronAPI.providerOperation", models)

    def test_electron_never_persists_new_provider_keys_to_local_storage(self):
        setter = HTML.split("function setProviderApiKey", 1)[1].split("function getProviderBaseUrl", 1)[0]
        self.assertIn("providerCredentialSet", setter)
        self.assertIn("if (window.electronAPI)", setter)
        self.assertIn("providerCredentialClear", PRELOAD)
        self.assertNotRegex(HTML, r"console\.(?:log|warn|error)\([^\n]*(?:apiKey|credential)")

    def test_security_baseline_is_unchanged(self):
        for setting in ("contextIsolation: true", "nodeIntegration: false", "sandbox: true", "assertTrustedSender", "details.resourceType === 'script'"):
            self.assertIn(setting, MAIN)


if __name__ == "__main__":
    unittest.main()
