import SwiftUI
import WebKit
#if canImport(VoicePracticeCore)
import VoicePracticeCore
#endif

public struct WebViewContainer: UIViewRepresentable {
    private let bridge: VoiceWebBridge

    public init(bridge: VoiceWebBridge = VoiceWebBridge()) {
        self.bridge = bridge
    }

    public func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()

        let scriptHandler = ScriptBridgeHandler(bridge: bridge)
        controller.add(scriptHandler, name: "voiceBridge")
        context.coordinator.handler = scriptHandler

        // Inject bridge polyfill into webview so shared Web UI seamlessly uses typed bridge
        let polyfillScript = """
        (function() {
            document.documentElement.classList.add("native-ios-app");

            function syncNativeViewportHeight() {
                const viewport = window.visualViewport;
                const height = Math.max(1, Math.round(viewport ? viewport.height : window.innerHeight));
                document.documentElement.style.setProperty("--native-app-height", height + "px");
            }

            syncNativeViewportHeight();
            window.addEventListener("resize", syncNativeViewportHeight, { passive: true });
            if (window.visualViewport) {
                window.visualViewport.addEventListener("resize", syncNativeViewportHeight, { passive: true });
            }

            document.addEventListener("focusin", function(event) {
                const target = event.target;
                if (!(target instanceof HTMLElement) || !target.matches("input, textarea, select, [contenteditable='true']")) {
                    return;
                }
                window.setTimeout(function() {
                    target.scrollIntoView({ block: "nearest", inline: "nearest" });
                }, 120);
            }, true);

            window.__pendingBridgeCallbacks = new Map();
            window.__activeAppleFoundationModelRequests = new Set();
            window.__voiceBridgeCallback = function(id, success, data, error) {
                const cb = window.__pendingBridgeCallbacks.get(id);
                if (cb) {
                    window.__pendingBridgeCallbacks.delete(id);
                    window.__activeAppleFoundationModelRequests.delete(id);
                    if (success) cb.resolve(data);
                    else cb.reject(new Error(error || "BRIDGE_ERROR"));
                }
            };

            function invokeBridge(operation, payload) {
                return new Promise((resolve, reject) => {
                    const id = "msg_" + Math.random().toString(36).slice(2) + "_" + Date.now();
                    window.__pendingBridgeCallbacks.set(id, { resolve, reject });
                    const msg = Object.assign({ id: id, operation: operation }, payload);
                    msg.id = id;
                    msg.operation = operation;
                    if (operation === "apple.chat") window.__activeAppleFoundationModelRequests.add(id);
                    window.webkit.messageHandlers.voiceBridge.postMessage(msg);
                });
            }

            function cancelAppleFoundationModelRequests() {
                const requestIds = Array.from(window.__activeAppleFoundationModelRequests);
                window.__activeAppleFoundationModelRequests.clear();
                for (const targetRequestId of requestIds) {
                    invokeBridge("apple.cancel", {
                        providerId: "apple-foundation-models",
                        targetRequestId: targetRequestId
                    }).catch(function() {});
                }
            }

            // Expose native bridge adapter to shared index.html
            window.voiceNativeBridge = {
                appleFoundationModels: true,
                providerOperation: function(payload) {
                    return invokeBridge(payload.operation, payload);
                },
                cancelAppleFoundationModelRequests: cancelAppleFoundationModelRequests,
                credentialHas: function(providerId, baseUrl) {
                    return invokeBridge("credential.has", { providerId: providerId, baseUrl: baseUrl });
                },
                credentialSet: function(providerId, baseUrl, credential) {
                    return invokeBridge("credential.set", { providerId: providerId, baseUrl: baseUrl, credential: credential });
                },
                credentialClear: function(providerId, baseUrl) {
                    return invokeBridge("credential.clear", { providerId: providerId, baseUrl: baseUrl });
                }
            };
        })();
        """

        let userScript = WKUserScript(
            source: polyfillScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        controller.addUserScript(userScript)
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.handler = scriptHandler
        webView.navigationDelegate = context.coordinator
        scriptHandler.webView = webView

        // Load bundled web app from Resources
        if let bundleUrl = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            scriptHandler.trustedRootURL = bundleUrl.deletingLastPathComponent()
            webView.loadFileURL(bundleUrl, allowingReadAccessTo: bundleUrl.deletingLastPathComponent())
        } else if let localUrl = Bundle.main.url(forResource: "index", withExtension: "html") {
            scriptHandler.trustedRootURL = localUrl.deletingLastPathComponent()
            webView.loadFileURL(localUrl, allowingReadAccessTo: localUrl.deletingLastPathComponent())
        }

        return webView
    }

    public func updateUIView(_ uiView: WKWebView, context: Context) {}

    public func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    public class Coordinator: NavigationPolicyCoordinator {}
}

public struct ContentView: View {
    public init() {}

    public var body: some View {
        WebViewContainer()
            .edgesIgnoringSafeArea(.all)
    }
}
