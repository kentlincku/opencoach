package com.kentlin.voicepractice

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream

class MainActivity : ComponentActivity() {
    companion object {
        const val APP_ORIGIN = "https://appassets.androidplatform.net"
        const val APP_URL = "$APP_ORIGIN/assets/web/index.html"
        private const val BRIDGE_NAME = "voicePracticeNative"
    }

    internal var webViewForTest: WebView? = null
        private set

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private val microphoneLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        microphonePermission.onResult(granted)
    }
    private lateinit var permissionGate: AndroidLocalNetworkPermissionGate
    private lateinit var microphonePermission: MicrophonePermissionController
    private lateinit var nativeVoice: AndroidNativeVoiceRuntime

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        permissionGate = AndroidLocalNetworkPermissionGate(this, permissionLauncher)
        microphonePermission = MicrophonePermissionController(this, microphoneLauncher)
        nativeVoice = AndroidNativeVoiceRuntime(this, microphonePermission)
        createHardenedWebView()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createHardenedWebView() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) {
            setContentView(TextView(this).apply { text = "此裝置的 Android System WebView 太舊，請更新後重試。" })
            return
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        val webView = WebView(this)
        webViewForTest = webView
        webView.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_DEFAULT
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) safeBrowsingEnabled = true
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?) = false
            override fun onPermissionRequest(request: PermissionRequest?) { request?.deny() }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                assetLoader.shouldInterceptRequest(request.url)?.let { return it }
                return blockedResponse()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !request.isForMainFrame || !isTrustedAppUrl(request.url)
        }

        val service = (application as VoicePracticeApplication).providerService
        val dispatcher = BridgeDispatcher(
            BridgeSchema(), service.provider, service.credentials, permissionGate, service.endpointPolicy,
            permissionRequest = permissionGate::requestIfNeeded,
            nativeVoice = nativeVoice
        )
        WebViewCompat.addWebMessageListener(webView, BRIDGE_NAME, setOf(APP_ORIGIN)) {
                _: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, reply ->
            if (!isMainFrame || sourceOrigin.toString().trimEnd('/') != APP_ORIGIN) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            lifecycleScope.launch {
                val response = dispatcher.dispatch(raw)
                runCatching { reply.postMessage(response.toJson()) }
            }
        }
        WebViewCompat.addDocumentStartJavaScript(webView, bridgeBootstrap, setOf(APP_ORIGIN))
        setContentView(webView)
        webView.loadUrl(APP_URL)
    }

    private fun isTrustedAppUrl(uri: Uri): Boolean =
        uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
            uri.port == -1 && uri.path?.startsWith("/assets/web/") == true &&
            uri.userInfo == null && uri.query == null && uri.fragment == null

    private fun blockedResponse() = WebResourceResponse(
        "text/plain", "UTF-8", 403, "Blocked", mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0))
    )

    override fun onStop() {
        nativeVoice.cancelAll()
        super.onStop()
    }

    override fun onDestroy() {
        nativeVoice.dispose()
        webViewForTest?.apply {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
            removeAllViews()
            destroy()
        }
        webViewForTest = null
        super.onDestroy()
    }

    private val bridgeBootstrap = """
        (() => {
          'use strict';
          const pending = new Map();
          const MAX_PENDING = 64;
          const nativePort = window.voicePracticeNative;
          nativePort.onmessage = event => {
            let response;
            try { response = JSON.parse(event.data); } catch (_) { return; }
            const callback = pending.get(response.id);
            if (!callback) return;
            pending.delete(response.id);
            if (response.success) callback.resolve(response.data || {});
            else {
              const error = new Error(response.error?.code || 'BRIDGE_ERROR');
              error.code = response.error?.code || 'BRIDGE_ERROR';
              error.recovery = response.error?.recovery || null;
              callback.reject(error);
            }
          };
          function invoke(operation, payload) {
            return new Promise((resolve, reject) => {
              if (pending.size >= MAX_PENDING) return reject(new Error('BRIDGE_BUSY'));
              const id = 'msg_' + crypto.randomUUID();
              const message = Object.assign({}, payload || {}, { id, operation });
              pending.set(id, { resolve, reject });
              nativePort.postMessage(JSON.stringify(message));
            });
          }
          Object.defineProperty(window, 'voiceNativeBridge', {
            configurable: false, enumerable: true, writable: false,
            value: Object.freeze({
              providerOperation: payload => invoke(payload.operation, payload),
              credentialHas: (providerId, baseUrl) => invoke('credential.has', { providerId, baseUrl }),
              credentialSet: (providerId, baseUrl, credential) => invoke('credential.set', { providerId, baseUrl, credential }),
              credentialClear: (providerId, baseUrl) => invoke('credential.clear', { providerId, baseUrl }),
              voiceHealth: () => invoke('voice.health'),
              voiceTranscribe: payload => invoke('voice.transcribe', payload),
              voiceSynthesize: payload => invoke('voice.synthesize', payload),
              voiceCancel: payload => invoke('voice.cancel', payload),
              voiceDispose: () => invoke('voice.dispose')
            })
          });
          addEventListener('pagehide', () => {
            for (const callback of pending.values()) callback.reject(new Error('RUNTIME_DISPOSED'));
            pending.clear();
          }, { once: true });
          document.documentElement.classList.add('native-android-app');
        })();
    """.trimIndent()
}