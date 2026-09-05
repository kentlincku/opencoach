import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class OfficialProviderAuthOnlyTests(unittest.TestCase):
    def test_product_contains_no_hermes_subscription_bridge_runtime(self):
        self.assertFalse((ROOT / "apps/desktop/hermes-bridge.cjs").exists())

        production_files = [
            ROOT / "apps/desktop/main.cjs",
            ROOT / "apps/desktop/preload.cjs",
            ROOT / "apps/desktop/subscription-auth-broker.cjs",
            ROOT / "apps/web/index.html",
            ROOT / "apps/web/runtime/llm-provider-contract.js",
        ]
        forbidden = (
            "HermesBridge",
            "hermes-bridge",
            "ai:subscription",
            "bridgeSubscription",
            "listSubscriptionModels",
            "startNativeOAuth",
            "subscription-bridge",
            "MANUAL_AUTH_PENDING",
            "安全Bridge",
            "claude-subscription",
            "copilot-subscription",
            "xai-subscription",
            "nous-subscription",
            "grok-cli:access",
            "codex_cli_rs",
        )
        for path in production_files:
            text = path.read_text(encoding="utf-8")
            for value in forbidden:
                self.assertNotIn(value, text, f"{value} remains in {path.relative_to(ROOT)}")

    def test_public_contract_allows_only_provider_owned_auth_products(self):
        schema = json.loads((ROOT / "contracts/llm-runtime.schema.json").read_text(encoding="utf-8"))
        provider = schema["properties"]["providers"]["items"]["properties"]
        self.assertEqual(
            provider["id"]["enum"],
            ["openai-compatible", "chatgpt-subscription", "grok-subscription", "apple-foundation-models"],
        )
        self.assertEqual(
            provider["authProduct"]["enum"],
            ["api-key-or-none", "chatgpt-subscription", "grok-subscription", "none"],
        )
        self.assertEqual(
            provider["state"]["enum"],
            ["AVAILABLE", "UNAVAILABLE_ACCURATELY_DISABLED"],
        )

    def test_canonical_docs_define_three_separate_provider_routes(self):
        text = (ROOT / "docs/cross-platform-llm-auth-architecture.md").read_text(encoding="utf-8")
        self.assertIn("API / endpoint route", text)
        self.assertIn("ChatGPT / Codex subscription", text)
        self.assertIn("Grok / SuperGrok subscription", text)
        self.assertIn("Apple Foundation Models", text)
        self.assertIn("VOICE_OPENAI_CODEX_CLIENT_ID", text)
        self.assertIn("VOICE_XAI_OAUTH_SCOPE", text)
        self.assertNotIn("Hermes Bridge", text)
        self.assertNotIn("subscription-bridge", text)
        self.assertNotIn("Manual Hermes", text)

    def test_active_docs_contain_no_retired_bridge_guidance(self):
        paths = (
            ROOT / "README.md",
            ROOT / "ARCHITECTURE.md",
            ROOT / "SECURITY.md",
            ROOT / "docs/RELEASE_STATUS.md",
            ROOT / "docs/cross-platform-llm-auth-architecture.md",
            ROOT / "docs/local-first-web.md",
            ROOT / "docs/testing/desktop-e2e-release.md",
            ROOT / "docs/testing/README.md",
            ROOT / "docs/testing/windows-product-completeness-matrix.md",
        )
        forbidden = (
            "Hermes proxy",
            "restricted proxy adapter",
            "MANUAL_AUTH_PENDING",
            "HERMES_PROXY",
            "Subscription OAuth boundary",
            "google-gemini-oauth",
            "Google Identity Services",
            "Google Web OAuth",
            "Google Gemini Web OAuth",
            "provider-oauth",
            "startLogin(providerId)",
            "logout(providerId)",
        )
        for path in paths:
            text = path.read_text(encoding="utf-8")
            for value in forbidden:
                self.assertNotIn(value, text, f"{value} remains in {path.relative_to(ROOT)}")

    def test_cloud_models_use_api_route_without_google_oauth_product(self):
        production_paths = (
            ROOT / "apps/web/index.html",
            ROOT / "apps/web/runtime/llm-provider-contract.js",
            ROOT / "apps/web/service-worker.js",
            ROOT / "contracts/llm-runtime.schema.json",
        )
        forbidden = (
            "google-gemini-oauth",
            "google-gemini-oauth.js",
            "VoiceGoogleGemini",
            "Google Identity Services",
            "startGoogleGeminiLogin",
            "provider OAuth option",
        )
        for path in production_paths:
            text = path.read_text(encoding="utf-8")
            for value in forbidden:
                self.assertNotIn(value, text, f"{value} remains in {path.relative_to(ROOT)}")

        self.assertFalse((ROOT / "apps/web/runtime/google-gemini-oauth.js").exists())
        self.assertFalse((ROOT / "tests/google-gemini-oauth.test.cjs").exists())


if __name__ == "__main__":
    unittest.main()
