import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT.joinpath("apps/web/index.html").read_text(encoding="utf-8") if ROOT.joinpath("apps/web/index.html").exists() else ""
PRELOAD = ROOT.joinpath("apps/desktop/preload.cjs").read_text(encoding="utf-8") if ROOT.joinpath("apps/desktop/preload.cjs").exists() else ""
MAIN = ROOT.joinpath("apps/desktop/main.cjs").read_text(encoding="utf-8") if ROOT.joinpath("apps/desktop/main.cjs").exists() else ""
RUNTIME_CONTRACT = ROOT.joinpath("apps/web/runtime/runtime-contract.js").read_text(encoding="utf-8") if ROOT.joinpath("apps/web/runtime/runtime-contract.js").exists() else ""
CAPABILITY_SCHEMA = ROOT.joinpath("contracts/voice-runtime.schema.json").read_text(encoding="utf-8") if ROOT.joinpath("contracts/voice-runtime.schema.json").exists() else ""
CREATE_RUNTIME = ROOT.joinpath("apps/web/runtime/create-runtime.js").read_text(encoding="utf-8") if ROOT.joinpath("apps/web/runtime/create-runtime.js").exists() else ""
LLM_PROVIDER_CONTRACT = ROOT.joinpath("apps/web/runtime/llm-provider-contract.js").read_text(encoding="utf-8")


class WebContractTest(unittest.TestCase):
    def test_web_uses_typed_audio_payload(self):
        self.assertIn("runtime.transcribe({", HTML)
        self.assertIn("mimeType: audioBlob.type", HTML)

    def test_preload_exposes_minimal_whitelist(self):
        self.assertIn("contextBridge.exposeInMainWorld", PRELOAD)
        self.assertIn("runtimeHealth", PRELOAD)
        self.assertNotIn("ipcRenderer.send", PRELOAD)
        self.assertNotIn("require: require", PRELOAD)

    def test_capability_contract_files_exist(self):
        self.assertIn("normalizeRuntimeCapabilities", RUNTIME_CONTRACT)
        self.assertIn('"selectedStt"', CAPABILITY_SCHEMA)
        self.assertIn('"selectedTts"', CAPABILITY_SCHEMA)
        self.assertIn('"degradedReason"', CAPABILITY_SCHEMA)

    def test_ui_gates_native_voice_calls_with_normalized_capabilities(self):
        self.assertIn('src="./runtime/runtime-contract.js"', HTML)
        self.assertIn('src="./runtime/browser-runtime.js"', HTML)
        self.assertIn('src="./runtime/electron-runtime.js"', HTML)
        self.assertIn('src="./runtime/create-runtime.js"', HTML)
        self.assertIn("VoiceRuntimeFactory.createRuntime", HTML)

    def test_cancelled_stt_does_not_update_ui(self):
        transcribe = HTML.split("async function transcribeAudioBlob", 1)[1].split("function startListeningTurn", 1)[0]
        self.assertIn("isRuntimeCancellation(error)", transcribe)
        self.assertIn("return;", transcribe.split("isRuntimeCancellation(error)", 1)[1])

    def test_browser_fallbacks_remain(self):
        self.assertIn("transcribeWithWebAssembly", HTML)
        self.assertIn("speechSynthesis", HTML)

    def test_direct_api_uses_one_provider_agnostic_openai_compatible_connection(self):
        provider_select = HTML.split('id="providerSelect"', 1)[1].split("</select>", 1)[0]
        self.assertIn("選擇連線方式 (Connection)", HTML)
        self.assertIn('<option value="openai-compatible">', HTML)
        self.assertIn('src="./runtime/llm-provider-contract.js"', HTML)
        self.assertIn("OPENAI_COMPATIBLE: 'openai-compatible'", LLM_PROVIDER_CONTRACT)
        self.assertIn("name: 'OpenAI-compatible API'", LLM_PROVIDER_CONTRACT)
        self.assertIn("protocol: 'openai'", LLM_PROVIDER_CONTRACT)
        self.assertIn("authMode: 'optional'", LLM_PROVIDER_CONTRACT)
        self.assertNotIn('<option value="openai">', provider_select)
        self.assertNotIn('<option value="claude">', provider_select)
        self.assertNotIn('<option value="gemini">', provider_select)
        self.assertNotIn('<option value="groq">', provider_select)
        self.assertNotIn('<option value="ollama">', provider_select)
        self.assertNotIn('<option value="lmstudio">', provider_select)
        self.assertNotIn('<option value="deepseek">', provider_select)

    def test_legacy_direct_provider_settings_are_migrated(self):
        self.assertIn("migrateLegacyDirectProviderSettings", HTML)
        self.assertIn('"openai-compatible"', HTML)
        self.assertIn("vp_provider_keys", HTML)
        self.assertIn("vp_provider_urls", HTML)
        self.assertIn("vp_provider_models", HTML)

    def test_tts_engine_is_user_selectable_and_persisted(self):
        self.assertIn('id="ttsModeSelect"', HTML)
        self.assertIn('<option value="auto">', HTML)
        self.assertIn('<option value="system">', HTML)
        self.assertIn('value="kokoro">🎙️ Kokoro', HTML)
        self.assertIn('src="./runtime/tts-preference.js"', HTML)
        self.assertIn('localStorage.setItem("vp_ttsMode"', HTML)
        self.assertIn("shouldUseModelTts", HTML)
        self.assertIn("shouldLoadBrowserKokoro", HTML)
        self.assertIn("cancelPendingKokoroInitialization", HTML)
        self.assertIn("shouldRetryKokoroInitialization", HTML)
        self.assertIn("classifySuccessfulKokoroWarmup", HTML)
        self.assertNotIn("browserKokoroUsable = warmupMs <= 12000", HTML)
        self.assertIn("scheduleBrowserKokoroInitialization();", HTML)
        self.assertIn("kokoroInitTimer", HTML)
        self.assertGreaterEqual(HTML.count("isKokoroInitializationCurrent(generation)"), 3)
        self.assertIn("playFallbackWebSpeech(cleanText, token, triggerStart, fallbackLabel)", HTML)
        self.assertIn('"系統語音（Auto）"', HTML)
        self.assertNotIn('id="enableBrowserKokoro"', HTML)

    def test_coach_retries_non_english_output_before_tts(self):
        self.assertIn('src="./runtime/language-policy.js"', HTML)
        self.assertIn("ENGLISH_COACH_SYSTEM_PROMPT", HTML)
        self.assertIn("REPAIR_INSTRUCTION", HTML)
        self.assertIn("isEnglishOnlyReply(reply)", HTML)
        self.assertIn("sanitizeEnglishSpeechText", HTML)
        self.assertIn("cleanTextForTTS(text) || window.VoiceLanguagePolicy.SAFE_ENGLISH_FALLBACK", HTML)
        self.assertNotIn("cleanTextForTTS(text) || text", HTML)

    def test_ui_declares_cross_platform_cjk_font_fallbacks(self):
        body_rule = HTML.split("body {", 1)[1].split("}", 1)[0]
        self.assertIn('"PingFang TC"', body_rule)
        self.assertIn('"Microsoft JhengHei"', body_rule)
        self.assertIn('"Noto Sans CJK TC"', body_rule)
        self.assertLess(body_rule.index("'Nunito'"), body_rule.index('"PingFang TC"'))
        self.assertLess(body_rule.index('"PingFang TC"'), body_rule.index("sans-serif"))

    def test_remote_windows_never_inherit_preload_privileges(self):
        self.assertIn("setWindowOpenHandler", MAIN)
        self.assertIn("shell.openExternal", MAIN)
        self.assertIn("will-navigate", MAIN)

    def test_desktop_survives_missing_native_runtime(self):
        self.assertIn("Native voice runtime unavailable; browser fallbacks remain active", MAIN)
        self.assertIn("await createWindow()", MAIN)

    def test_audio_ipc_has_size_limit(self):
        self.assertIn("MAX_AUDIO_BYTES", MAIN)
        self.assertIn("AUDIO_PAYLOAD_TOO_LARGE", MAIN)

    def test_retired_hermes_bridge_is_absent(self):
        self.assertFalse(ROOT.joinpath("apps/desktop/hermes-bridge.cjs").exists())
        self.assertNotIn("ai:subscription", MAIN)
        self.assertNotIn("bridgeSubscription", PRELOAD)

    def test_desktop_does_not_eagerly_load_browser_transformers(self):
        self.assertNotIn('@xenova/transformers@2.17.2/dist/transformers.min.js', HTML)
        self.assertIn('voiceRuntime?.kind === "electron"', HTML)
        self.assertIn("details.resourceType === 'script'", MAIN)

    def test_voice_operations_use_runtime_adapter(self):
        self.assertIn("createVoiceRuntime", HTML)
        self.assertIn("runtime.transcribe", HTML)
        self.assertIn("runtime.synthesize", HTML)
        self.assertNotIn("window.electronAPI.transcribeAudio", HTML)
        self.assertNotIn("window.electronAPI.synthKokoro", HTML)
        self.assertIn("createRuntime", CREATE_RUNTIME)

    def test_shadowing_never_injects_model_or_stt_html(self):
        shadow = HTML.split("function startShadowing()", 1)[1].split("// Lessons System", 1)[0]
        self.assertNotIn("innerHTML", shadow)
        self.assertIn("textContent", shadow)

    def test_ipc_validates_sender(self):
        self.assertIn("assertTrustedSender", MAIN)
        self.assertIn("isTrustedMainFrame(event, mainWindow.webContents)", MAIN)

    def test_sidecar_receives_minimal_environment(self):
        self.assertIn("function runtimeEnvironment", MAIN)
        self.assertNotIn("env: { ...process.env, VOICE_RUNTIME_TEMP_DIR", MAIN)

    def test_subscription_chat_uses_typed_provider_broker(self):
        self.assertIn("subscription:operation", MAIN)
        self.assertIn("subscriptionOperation", PRELOAD)
        self.assertNotIn("HERMES_PROXY_URL", MAIN)


if __name__ == "__main__":
    unittest.main()
