import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps" / "web"
HTML = (WEB / "index.html").read_text(encoding="utf-8")
SERVICE_WORKER = (WEB / "service-worker.js").read_text(encoding="utf-8")
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))


class LocalFirstWebContractTests(unittest.TestCase):
    def test_pwa_shell_is_declared_and_registered(self):
        self.assertIn('rel="manifest" href="./manifest.webmanifest"', HTML)
        self.assertIn("navigator.serviceWorker.register", HTML)
        manifest = json.loads((WEB / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(manifest["display"], "standalone")
        self.assertEqual(manifest["start_url"], "./")

    def test_runtime_javascript_is_bundled_from_same_origin(self):
        self.assertNotIn("cdn.jsdelivr.net", HTML)
        self.assertNotIn("fonts.googleapis.com", HTML)
        self.assertNotIn("fonts.gstatic.com", HTML)
        self.assertIn('import("./vendor/transformers.bundle.js")', HTML)
        self.assertIn('import("./vendor/kokoro.bundle.js")', HTML)
        self.assertIn("build:web", PACKAGE["scripts"])
        self.assertIn("@huggingface/transformers", PACKAGE["devDependencies"])
        self.assertIn("kokoro-js", PACKAGE["devDependencies"])

    def test_browser_stt_never_uploads_audio_to_cloud(self):
        self.assertNotIn("SpeechRecognition", HTML)
        self.assertNotIn("webkitSpeechRecognition", HTML)
        self.assertNotIn("recognition.start", HTML)
        stop_section = HTML.split("function stopConversation", 1)[1].split("let mediaRecorder", 1)[0]
        self.assertNotIn("recognition", stop_section)
        section = HTML.split("async function transcribeBrowserAudio", 1)[1].split(
            "function isRuntimeCancellation", 1
        )[0]
        self.assertIn("transcribeWithWebAssembly", section)
        self.assertIn('backend: "browser-whisper"', section)
        self.assertNotIn("providerOperation", section)
        self.assertNotIn("FormData", section)
        self.assertNotIn("audio/transcriptions", section)
        self.assertNotIn("cloud-whisper", section)
        self.assertNotIn("setTimeout(initOfflineWhisper", HTML)

    def test_tts_uses_only_confirmed_local_voices(self):
        self.assertIn("voice.localService === true", HTML)
        self.assertNotIn("premium|online", HTML)
        self.assertNotIn("origGenerate", HTML)
        self.assertNotIn("resolve/main/voices", HTML)
        self.assertIn("await phonemizeForKokoro", HTML)

    def test_custom_lesson_library_is_local_first_and_offline(self):
        self.assertIn('src="./runtime/lesson-library.js"', HTML)
        self.assertIn('id="lessonManagerModal"', HTML)
        self.assertIn('id="lessonJsonEditor"', HTML)
        self.assertIn("function importLessonFile", HTML)
        self.assertIn("function exportLessonLibrary", HTML)
        self.assertIn("function saveLessonEditor", HTML)
        self.assertIn("VoiceLessonLibrary.loadLessons(localStorage", HTML)
        self.assertIn('"./runtime/lesson-library.js"', SERVICE_WORKER)
        self.assertNotIn("LESSONS.map", HTML)
        self.assertNotIn("LESSONS.find", HTML)

    def test_lesson_practice_stays_in_lesson_mode_and_persists_completion(self):
        start = HTML.split("async function startSpecificLesson", 1)[1].split("// Tabs", 1)[0]
        tabs = HTML.split("function switchTab", 1)[1].split("// Coach Modal", 1)[0]
        complete = HTML.split("function completeCurrentLesson", 1)[1].split("function returnToLessonList", 1)[0]
        self.assertIn('switchTab("lesson-practice")', start)
        self.assertIn('lesson.objectives.join("; ")', start)
        self.assertNotIn('switchTab("free")', start)
        self.assertIn('tab === "lesson-practice"', tabs)
        self.assertIn('id="lessonPracticeBanner"', HTML)
        self.assertIn('id="currentLessonTitle"', HTML)
        self.assertIn('localStorage.setItem("vp_completed_lessons"', complete)

    def test_mobile_layout_uses_scoped_rows_without_horizontal_overflow(self):
        mobile = HTML.split("@media (max-width: 480px)", 1)[1].split("/* Glass Cards */", 1)[0]
        self.assertIn("flex-direction: column", mobile)
        self.assertIn(".header-actions", mobile)
        self.assertIn("grid-template-columns", mobile)
        self.assertIn(".settings-inline-row", mobile)
        self.assertIn(".settings-action-row", mobile)
        self.assertIn(".text-input-row", mobile)
        self.assertIn('class="settings-inline-row"', HTML)
        self.assertIn('class="settings-action-row"', HTML)
        self.assertIn('class="text-input-row"', HTML)
        self.assertIn('content="width=device-width, initial-scale=1.0, viewport-fit=cover"', HTML)
        self.assertIn("min-height: 100dvh", mobile)
        self.assertIn(".close-btn", mobile)
        self.assertIn("height: clamp(220px, 34dvh, 300px)", mobile)
        self.assertIn("#micNotice", mobile)
        self.assertIn('placeholder="💬 輸入英文…"', HTML)
        self.assertNotIn("\n            .icon-btn {", mobile)

    def test_english_only_whisper_uses_compatible_generation_options(self):
        transcribe = HTML.split("async function transcribeWithWebAssembly", 1)[1].split("// Browser STT is local-only", 1)[0]
        self.assertNotIn("language: 'en'", transcribe)
        self.assertNotIn("task: 'transcribe'", transcribe)

    def test_google_gemini_uses_api_key_preset_without_oauth_product(self):
        self.assertIn('src="./runtime/direct-api-presets.js"', HTML)
        self.assertIn('value="gemini"', HTML)
        self.assertIn('https://generativelanguage.googleapis.com/v1beta/openai', (ROOT / "apps/web/runtime/direct-api-presets.js").read_text(encoding="utf-8"))
        self.assertNotIn('google-gemini-oauth', HTML)
        self.assertNotIn('startGoogleGeminiLogin', HTML)
        self.assertNotIn('google-gemini-oauth.js', SERVICE_WORKER)
        self.assertNotIn('value="oauth-pkce"', HTML)
        self.assertNotIn('clientSecret', HTML)
        self.assertNotIn('refresh_token', HTML)

    def test_iphone_uses_system_voice_and_direct_api_presets(self):
        self.assertIn("isIosBrowserEnvironment()", HTML)
        self.assertIn('id="directApiPreset"', HTML)
        self.assertIn('value="openai"', HTML)
        self.assertIn('value="gemini"', HTML)
        self.assertIn('"./runtime/direct-api-presets.js"', SERVICE_WORKER)
        self.assertIn('id="kokoroTtsOption"', HTML)
        self.assertIn("vp_provider_key_bindings", HTML)
        self.assertIn("normalizeCredentialBaseUrl", HTML)
        self.assertIn("onApiBaseUrlInput", HTML)

    def test_local_web_mode_supports_http_local_models_without_becoming_a_proxy(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertEqual(PACKAGE["scripts"]["start:web"], "node scripts/start-local-web.mjs")
        self.assertIn('src="./runtime/local-endpoint-policy.js"', HTML)
        self.assertIn('"./runtime/local-endpoint-policy.js"', SERVICE_WORKER)
        self.assertIn("Local Web Mode", readme)
        self.assertIn("http://127.0.0.1:8000/v1", readme)
        self.assertIn("Hosted HTTPS", readme)

    def test_service_worker_updates_take_control_without_leaving_stale_runtime_policy(self):
        self.assertIn("self.skipWaiting()", SERVICE_WORKER)
        self.assertIn('updateViaCache: "none"', HTML)
        self.assertIn("registration.update()", HTML)
        self.assertIn("client.navigate(client.url)", SERVICE_WORKER)
        self.assertNotIn('window.location.reload()', HTML)
        self.assertIn('navigator.serviceWorker.addEventListener("controllerchange"', HTML)


    def test_settings_can_save_without_remote_llm(self):
        section = HTML.split("async function saveSettings", 1)[1].split(
            "function updateHeaderStatusBadge", 1
        )[0]
        self.assertNotIn("MODEL_REQUIRED", section)
        self.assertIn("LLM 未設定", section)

    def test_onnx_runtime_is_same_origin(self):
        ort_dir = WEB / "vendor" / "ort"
        self.assertTrue((ort_dir / "ort-wasm-simd-threaded.wasm").is_file())
        self.assertTrue((ort_dir / "ort-wasm-simd-threaded.jsep.wasm").is_file())
        transformer_entry = (ROOT / "scripts/vendor/transformers-entry.mjs").read_text(encoding="utf-8")
        kokoro_entry = (ROOT / "scripts/vendor/kokoro-entry.mjs").read_text(encoding="utf-8")
        self.assertIn("wasmPaths", transformer_entry)
        self.assertIn("wasmPaths", kokoro_entry)
        for bundle in (WEB / "vendor").glob("*.bundle.js"):
            source = bundle.read_text(encoding="utf-8")
            self.assertNotIn("cdn.jsdelivr.net", source)
            self.assertNotIn("unpkg.com", source)

    def test_service_worker_only_caches_get_assets(self):
        source = (WEB / "service-worker.js").read_text(encoding="utf-8")
        self.assertIn('request.method !== "GET"', source)
        self.assertIn("CORE_URLS", source)
        self.assertIn("isShellNavigation", source)
        self.assertNotIn("MODEL_HOSTS", source)
        self.assertNotIn('response.type === "opaque"', source)
        self.assertNotIn("url.pathname.startsWith(scopePath)", source)
        self.assertNotIn("api.openai.com", source)
        self.assertNotIn("/chat/completions", source)

    def test_browser_model_manifest_is_versioned(self):
        manifest = json.loads((WEB / "model-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertIn("whisper", manifest["models"])
        self.assertIn("kokoro", manifest["models"])


if __name__ == "__main__":
    unittest.main()
