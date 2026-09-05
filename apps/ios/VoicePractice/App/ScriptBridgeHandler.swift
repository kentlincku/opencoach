import Foundation
import WebKit

public class ScriptBridgeHandler: NSObject, WKScriptMessageHandler {
    public let bridge: any VoiceBridgeContract
    public weak var webView: WKWebView?
    public var trustedRootURL: URL?
    public private(set) var documentGeneration: UInt64 = 1
    public private(set) var acceptsBridgeMessages = false
    private var hasActiveNavigation = false
    private var activeNavigationToken: AnyObject?

    public init(bridge: any VoiceBridgeContract = VoiceWebBridge(), webView: WKWebView? = nil, trustedRootURL: URL? = nil) {
        self.bridge = bridge
        self.webView = webView
        self.trustedRootURL = trustedRootURL
    }

    public func advanceDocumentGeneration() {
        beginMainFrameNavigation()
    }

    public func beginMainFrameNavigation(navigationToken: AnyObject? = nil) {
        hasActiveNavigation = true
        activeNavigationToken = navigationToken
        documentGeneration &+= 1
        acceptsBridgeMessages = false
    }

    private func isCurrentNavigation(_ navigationToken: AnyObject?) -> Bool {
        guard hasActiveNavigation else { return false }
        if let activeNavigationToken, let navigationToken {
            return activeNavigationToken === navigationToken
        }
        return activeNavigationToken == nil && navigationToken == nil
    }

    public func commitMainFrameNavigation(navigationToken: AnyObject? = nil, url: URL?) {
        guard isCurrentNavigation(navigationToken) else { return }
        hasActiveNavigation = false
        activeNavigationToken = nil
        documentGeneration &+= 1
        acceptsBridgeMessages = isTrustedDocument(url: url)
    }

    public func failMainFrameNavigation(navigationToken: AnyObject? = nil, currentUrl: URL?) {
        guard isCurrentNavigation(navigationToken) else { return }
        hasActiveNavigation = false
        activeNavigationToken = nil
        documentGeneration &+= 1
        acceptsBridgeMessages = isTrustedDocument(url: currentUrl)
    }

    public func isTrustedDocument(url: URL?) -> Bool {
        guard let url = url, url.isFileURL else { return false }
        let canonicalUrl = url.standardizedFileURL.resolvingSymlinksInPath()

        if let trustedRoot = trustedRootURL {
            let canonicalRoot = trustedRoot.standardizedFileURL.resolvingSymlinksInPath()
            let rootPath = canonicalRoot.path.hasSuffix("/") ? canonicalRoot.path : canonicalRoot.path + "/"
            if canonicalUrl.path == canonicalRoot.path || canonicalUrl.path.hasPrefix(rootPath) {
                return true
            }
        }

        if let bundleWeb = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            let canonicalRoot = bundleWeb.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
            let rootPath = canonicalRoot.path.hasSuffix("/") ? canonicalRoot.path : canonicalRoot.path + "/"
            if canonicalUrl.path == canonicalRoot.path || canonicalUrl.path.hasPrefix(rootPath) {
                return true
            }
        }

        if let localIndex = Bundle.main.url(forResource: "index", withExtension: "html") {
            let canonicalRoot = localIndex.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
            let rootPath = canonicalRoot.path.hasSuffix("/") ? canonicalRoot.path : canonicalRoot.path + "/"
            if canonicalUrl.path == canonicalRoot.path || canonicalUrl.path.hasPrefix(rootPath) {
                return true
            }
        }

        return false
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Enforce main frame only (reject iframes / subframes)
        guard message.frameInfo.isMainFrame else { return }

        // A provisional navigation revokes the old document immediately.  No
        // document may use the privileged bridge until a trusted main document
        // commits.  This closes the interval where the old page is still active
        // but would otherwise capture the next generation token.
        guard acceptsBridgeMessages else { return }

        // Reject non-file or untrusted origins
        guard let messageUrl = message.frameInfo.request.url else { return }
        guard isTrustedDocument(url: messageUrl) else { return }

        // Confirm active webView matches message URL
        guard let webView = self.webView else { return }
        guard let currentUrl = webView.url,
              currentUrl.standardizedFileURL.resolvingSymlinksInPath() == messageUrl.standardizedFileURL.resolvingSymlinksInPath() else { return }

        guard let dict = message.body as? [String: Any] else { return }

        let initiatingGeneration = self.documentGeneration

        Task { @MainActor in
            let response = await bridge.handleMessage(dict: dict)
            guard let webView = self.webView else { return }

            // Document generation token check: drop callback if document navigated away or reloaded
            guard self.documentGeneration == initiatingGeneration else {
                return
            }

            // Before asynchronous callback delivery, verify the current main document is STILL the same trusted document
            guard let deliveryUrl = webView.url,
                  deliveryUrl.standardizedFileURL.resolvingSymlinksInPath() == messageUrl.standardizedFileURL.resolvingSymlinksInPath(),
                  self.isTrustedDocument(url: deliveryUrl) else {
                // Navigation-away stale callback rejected
                return
            }

            var dataDict: [String: Any]? = [:]
            if let models = response.models { dataDict?["models"] = models }
            if let text = response.text { dataDict?["text"] = text }
            if let has = response.hasCredential { dataDict?["hasCredential"] = has }
            if let stored = response.stored { dataDict?["stored"] = stored }
            if let cleared = response.cleared { dataDict?["cleared"] = cleared }
            if let available = response.available { dataDict?["available"] = available }
            if let availability = response.availability { dataDict?["availability"] = availability }
            if let contextVersion = response.contextVersion { dataDict?["contextVersion"] = contextVersion }
            if dataDict?.isEmpty == true { dataDict = nil }

            // Named argument dispatch without raw interpolation or arguments.id
            let dataValue: Any = dataDict ?? NSNull()
            let errorValue: Any = (response.error as Any?) ?? NSNull()

            let arguments: [String: Any] = [
                "id": response.id,
                "success": response.success,
                "data": dataValue,
                "error": errorValue
            ]

            webView.callAsyncJavaScript(
                "window.__voiceBridgeCallback(id, success, data, error);",
                arguments: arguments,
                in: nil,
                in: .page
            )
        }
    }
}

public class NavigationPolicyCoordinator: NSObject, WKNavigationDelegate {
    public weak var handler: ScriptBridgeHandler?
    public var didFinishNavigation: ((WKWebView, WKNavigation?) -> Void)?
    public var didFailNavigation: ((WKWebView, WKNavigation?, Error) -> Void)?
    public var didFailProvisional: ((WKWebView, WKNavigation?, Error) -> Void)?

    public init(handler: ScriptBridgeHandler? = nil) {
        self.handler = handler
    }

    public func advanceDocumentGeneration() {
        handler?.advanceDocumentGeneration()
    }

    public func evaluateNavigationPolicy(url: URL?, isMainFrame: Bool) -> WKNavigationActionPolicy {
        guard isMainFrame, let url = url else { return .cancel }
        if let handler = handler, handler.isTrustedDocument(url: url) {
            return .allow
        }
        return .cancel
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        handler?.beginMainFrameNavigation(navigationToken: navigation)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        handler?.commitMainFrameNavigation(navigationToken: navigation, url: webView.url)
        didFinishNavigation?(webView, navigation)
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handler?.failMainFrameNavigation(navigationToken: navigation, currentUrl: webView.url)
        didFailNavigation?(webView, navigation, error)
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handler?.failMainFrameNavigation(navigationToken: navigation, currentUrl: webView.url)
        didFailProvisional?(webView, navigation, error)
    }

    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? false
        let policy = evaluateNavigationPolicy(url: navigationAction.request.url, isMainFrame: isMainFrame)
        decisionHandler(policy)
    }
}
