# Voice Practice Android shell

The Android app packages the canonical `apps/web` tree at build time and serves it from
`https://appassets.androidplatform.net/assets/web/index.html`. The copy task is one-way and
never edits shared Web sources.

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
```

The privileged surface is `WebViewCompat.addWebMessageListener`, restricted to the fixed
appassets origin and main frame. There is no `JavascriptInterface`, arbitrary HTTP bridge,
credential read operation, downloaded executable, or Python child process.

See [`../../docs/install-android.md`](../../docs/install-android.md) and
[`../../docs/testing/android-device-e2e.md`](../../docs/testing/android-device-e2e.md).