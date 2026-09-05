#!/usr/bin/env python3
"""Dependency-free Android security/build contract checks for SDK-less hosts."""
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
ANDROID = ROOT / "apps/android"

checks = []

def check(name, condition):
    checks.append((name, bool(condition)))

main = (ANDROID / "app/src/main/kotlin/com/kentlin/voicepractice/MainActivity.kt").read_text()
schema = (ANDROID / "app/src/main/kotlin/com/kentlin/voicepractice/BridgeSchema.kt").read_text()
client = (ANDROID / "app/src/main/kotlin/com/kentlin/voicepractice/LocalProviderClient.kt").read_text()
credential = (ANDROID / "app/src/main/kotlin/com/kentlin/voicepractice/CredentialStore.kt").read_text()
permission = (ANDROID / "app/src/main/kotlin/com/kentlin/voicepractice/PermissionPolicy.kt").read_text()
voice = (ANDROID / "app/src/main/kotlin/com/kentlin/voicepractice/AndroidNativeVoiceRuntime.kt").read_text() if (ANDROID / "app/src/main/kotlin/com/kentlin/voicepractice/AndroidNativeVoiceRuntime.kt").exists() else ""
voice_policy = (ANDROID / "app/src/main/kotlin/com/kentlin/voicepractice/NativeVoicePolicy.kt").read_text() if (ANDROID / "app/src/main/kotlin/com/kentlin/voicepractice/NativeVoicePolicy.kt").exists() else ""
gradle = (ANDROID / "app/build.gradle.kts").read_text()
workflow = (ROOT / ".github/workflows/android-beta.yml").read_text()
manifest_path = ANDROID / "app/src/main/AndroidManifest.xml"
ET.parse(manifest_path)

check("fixed appassets HTTPS origin", 'const val APP_ORIGIN = "https://appassets.androidplatform.net"' in main)
check("WebViewAssetLoader", "WebViewAssetLoader" in main)
check("document-start bridge", "addDocumentStartJavaScript" in main)
check("origin-scoped message listener", "addWebMessageListener" in main and "setOf(APP_ORIGIN)" in main)
check("no JavascriptInterface", "addJavascriptInterface" not in main)
check("file/content access disabled", all(x in main for x in ["allowFileAccess = false", "allowContentAccess = false", "allowUniversalAccessFromFileURLs = false"]))
check("popup and Web permission denied", "onCreateWindow" in main and "request?.deny()" in main)
check("remote Web requests blocked", "blockedResponse()" in main)
for operation in ["models", "chat", "credential.has", "credential.set", "credential.clear"]:
    check(f"typed operation {operation}", f'"{operation}"' in schema)
for operation in ["voice.health", "voice.transcribe", "voice.synthesize", "voice.cancel", "voice.dispose"]:
    check(f"typed operation {operation}", f'"{operation}"' in schema)
check("renderer HTTP controls absent", not re.search(r'allowed.*(method|headers|authorization)', schema, re.I))
check("streaming response cap", "readByteArray(BridgeLimits.RESPONSE_BYTES.toLong() + 1)" in client)
check("manual redirect validation", ".followRedirects(false)" in client and "redirects.next" in client)
check("AES-GCM Keystore", all(x in credential for x in ["AndroidKeyStore", "AES/GCM/NoPadding", "updateAAD"]))
check("atomic credential commits", ".commit()" in credential and ".apply()" not in credential)
check("versioned SDK 36/37 permissions", all(x in permission for x in ["deviceSdk >= 37 && targetSdk >= 37", "deviceSdk >= 36", "ACCESS_LOCAL_NETWORK", "NEARBY_WIFI_DEVICES"]))
check("read-only Web sync source", 'dir("../web")' in gradle and "syncBundledWeb" in gradle)
action_refs = re.findall(r"uses:\s*[^@\s]+@([^\s]+)", workflow)
check("Android workflow actions pinned to full commits", bool(action_refs) and all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in action_refs))
check("on-device recognizer only", all(x in voice for x in ["isOnDeviceRecognitionAvailable", "createOnDeviceSpeechRecognizer"]) and "createSpeechRecognizer(" not in voice)
check("on-device recognizer API guarded", "Build.VERSION.SDK_INT < Build.VERSION_CODES.S" in voice)
check("runtime microphone permission", "Manifest.permission.RECORD_AUDIO" in permission and "ActivityResultLauncher" in permission)
check("local TTS filters network voices", "isNetworkConnectionRequired" in voice and "KEY_FEATURE_NOT_INSTALLED" in voice)
check("TTS completion listener and utterance id", "UtteranceProgressListener" in voice and "utteranceId" in voice)
check("TTS callbacks serialized on main thread", all(x in voice for x in ["Handler(Looper.getMainLooper())", "mainHandler.post"]))
check("late callback generation guard", "VoiceOperationRegistry" in voice and "isCurrent" in voice)
check("voice payload bounds", all(x in schema for x in ["VOICE_TEXT_BYTES", "REQUEST_ID_PATTERN", "requireOnly"]))
check("voice lifecycle cleanup", all(x in main for x in ["override fun onStop", "nativeVoice.cancelAll", "nativeVoice.dispose"]))
check("no Python child process", not any(x in "\n".join(p.read_text(errors="ignore") for p in (ANDROID / "app/src/main").rglob("*.kt")) for x in ["ProcessBuilder", "Runtime.getRuntime().exec"]))

failed = [name for name, ok in checks if not ok]
for name, ok in checks:
    print(("PASS" if ok else "FAIL") + " " + name)
print(f"ANDROID_STATIC_CONTRACT: {len(checks) - len(failed)}/{len(checks)} passed")
if failed:
    sys.exit(1)