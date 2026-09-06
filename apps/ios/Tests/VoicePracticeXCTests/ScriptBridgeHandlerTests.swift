#if canImport(XCTest)
import XCTest
import WebKit
#if canImport(UIKit)
import UIKit
import AVFoundation
#endif
#if canImport(VoicePracticeCore)
@testable import VoicePracticeCore
#endif

@MainActor
final class ScriptBridgeHandlerTests: XCTestCase {
    var webView: WKWebView!
    var bridge: VoiceWebBridge!
    var handler: ScriptBridgeHandler!

    #if os(iOS) && !SWIFT_PACKAGE
    func testNativeSpeechRejectsInvalidInputAndUnavailableVoice() throws {
        for payload: [String: Any] in [
            ["text": ""], ["text": String(repeating: "x", count: 12001)],
            ["text": "Hello", "rate": true], ["text": "Hello", "rate": "fast"],
            ["text": "Hello", "voiceId": 42], ["text": "Hello", "rate": 9.0], ["text": "Hello", "language": "fr-FR"],
            ["text": "Hello", "unexpected": "value"], ["text": "Hello", "voiceId": "missing.voice"]
        ] {
            XCTAssertThrowsError(try NativeSpeechService.makeUtterance(payload))
        }
    }

    func testNativeSpeechSelectsBestInstalledQualityAndFinishes() async throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Real speech output is verified on the physical iPhone")
        #else
        let voices = NativeSpeechService.englishVoices()
        XCTAssertFalse(voices.isEmpty, "Install an English system voice on the device")
        let value = try NativeSpeechService.makeUtterance(["text": "Hello. Let's practice English."])
        XCTAssertEqual(value.voice?.quality, voices.first?.quality)
        let service = NativeSpeechService()
        defer { service.stop() }
        var didStart = false
        let result = try await service.speak(["text": "Hello. Let's practice English."]) { info in
            didStart = true
            print("NATIVE_SPEECH_STARTED latency_ms=\(info["startLatencyMs"] ?? 0) quality=\(info["quality"] ?? "unknown")")
        }
        XCTAssertTrue(didStart)
        XCTAssertEqual(result["finished"] as? Bool, true)
        print("NATIVE_SPEECH_FINISHED=PASS voice_count=\(voices.count)")
        #endif
    }

    func testNativeSpeechStopSettlesPendingUtterance() async throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Real speech cancellation is verified on the physical iPhone")
        #else
        let service = NativeSpeechService()
        let operation = Task { try await service.speak(["text": String(repeating: "Practice English every day. ", count: 20)]) { _ in } }
        try await Task.sleep(nanoseconds: 250_000_000)
        service.stop()
        do { _ = try await operation.value; XCTFail("Stopped speech must reject") }
        catch { XCTAssertEqual(error.localizedDescription, "SPEECH_CANCELLED") }
        #endif
    }

    func testProductionWebViewLocksScaleAndNativeVoiceSettings() async throws {
        let container = WebViewContainer()
        let coordinator = container.makeCoordinator()
        let view = container.makeWebView(coordinator: coordinator)
        webView = view
        view.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        window.frame = view.frame
        let controller = UIViewController()
        controller.view.addSubview(view)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            previousKeyWindow?.makeKeyAndVisible()
            WebViewContainer.dismantleUIView(view, coordinator: coordinator)
        }
        for _ in 0..<100 {
            if coordinator.handler?.acceptsBridgeMessages == true { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        // WebKit may enable its recognizer internally; validate the effective zoom
        // range and delegated zoom target, rather than that transient flag.
        XCTAssertNil(view.scrollView.delegate?.viewForZooming?(in: view.scrollView))
        XCTAssertEqual(view.scrollView.minimumZoomScale, view.scrollView.maximumZoomScale, accuracy: 0.001)
        XCTAssertFalse(view.configuration.ignoresViewportScaleLimits)
        let viewport = try await view.evaluateJavaScript("document.querySelector('meta[name=viewport]').content") as? String
        XCTAssertTrue(viewport?.contains("user-scalable=no") == true)
        let initialScale = try await view.evaluateJavaScript("visualViewport.scale") as? Double
        XCTAssertEqual(initialScale, 1)
        let native = try await view.evaluateJavaScript("window.voiceNativeBridge.nativeSpeech") as? Bool
        XCTAssertEqual(native, true)
        let rawList: Any? = try await withCheckedThrowingContinuation { continuation in
            view.callAsyncJavaScript("await openSettingsModal(); return await window.voiceNativeBridge.listSpeechVoices();", arguments: [:], in: nil, in: .page) { result in
                continuation.resume(with: result)
            }
        }
        let list = rawList as? [String: Any]
        XCTAssertNotNil(list?["voices"])
        let fontSize = try await view.evaluateJavaScript("getComputedStyle(document.getElementById('apiBaseUrl')).fontSize") as? String
        XCTAssertEqual(fontSize, "16px")
        _ = try await view.evaluateJavaScript("document.getElementById('apiBaseUrl').focus();")
        try await Task.sleep(nanoseconds: 300_000_000)
        let focusedScale = try await view.evaluateJavaScript("visualViewport.scale") as? Double
        XCTAssertEqual(focusedScale, 1)
        _ = try await view.evaluateJavaScript("document.activeElement.blur();")
        let overflow = try await view.evaluateJavaScript("document.documentElement.scrollWidth > window.innerWidth") as? Bool
        XCTAssertEqual(overflow, false)
        for (name, script) in [
            ("settings", "document.getElementById('nativeSpeechSettings').scrollIntoView({block:'center'});"),
            ("chat", "closeSettingsModal(); switchTab('free');"),
            ("lessons", "switchTab('lesson');"),
            ("coaches", "openCoachModal();"),
            ("library", "closeCoachModal(); openLessonManager();")
        ] {
            _ = try await view.evaluateJavaScript(script)
            try await Task.sleep(nanoseconds: 300_000_000)
            let overflow = try await view.evaluateJavaScript("document.documentElement.scrollWidth > innerWidth") as? Bool
            XCTAssertEqual(overflow, false, name)
            let image = try await view.takeSnapshot(configuration: nil)
            let attachment = XCTAttachment(image: image)
            attachment.name = "iPhone production \(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }
    #endif

    override func setUp() async throws {
        try await super.setUp()
        bridge = VoiceWebBridge()
        handler = ScriptBridgeHandler(bridge: bridge)
    }

    override func tearDown() async throws {
        webView = nil
        handler = nil
        bridge = nil
        try await super.tearDown()
    }

    private func createConfiguredWebView(coordinator: NavigationPolicyCoordinator) -> WKWebView {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(handler, name: "voiceBridge")
        config.userContentController = controller
        let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: config)
        wv.navigationDelegate = coordinator
        handler.webView = wv
        self.webView = wv
        return wv
    }

    private func loadHtmlAndWait(_ wv: WKWebView, url: URL, coordinator: NavigationPolicyCoordinator) async throws {
        var didFinish = false
        var error: Error?
        coordinator.didFinishNavigation = { _, _ in didFinish = true }
        coordinator.didFailNavigation = { _, _, err in error = err }
        coordinator.didFailProvisional = { _, _, err in error = err }

        _ = wv.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        for _ in 0..<50 {
            if didFinish { return }
            if let err = error { throw err }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func waitForBridgeResult(_ wv: WKWebView) async throws -> [String: Any]? {
        for _ in 0..<50 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if let hasResult = try? await wv.evaluateJavaScript("window.bridgeResult !== null") as? Bool,
               hasResult {
                return try? await wv.evaluateJavaScript("window.bridgeResult") as? [String: Any]
            }
        }
        return nil
    }

    func testMainFrameCallbackReturnsIdAndBooleanData() async throws {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let wv = createConfiguredWebView(coordinator: coordinator)
        let bundleDir = FileManager.default.temporaryDirectory.appendingPathComponent("bundle_web_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundleDir) }
        handler.trustedRootURL = bundleDir

        let tempHtml = bundleDir.appendingPathComponent("index.html")
        let htmlContent = """
        <!DOCTYPE html>
        <html>
        <body>
        <script>
            window.bridgeResult = null;
            window.__voiceBridgeCallback = function(id, success, data, error) {
                window.bridgeResult = { id: id, success: success, data: data, error: error };
            };
        </script>
        </body>
        </html>
        """
        try htmlContent.write(to: tempHtml, atomically: true, encoding: .utf8)

        try await loadHtmlAndWait(wv, url: tempHtml, coordinator: coordinator)

        let testId = "test_call_123"
        let jsPost = """
        window.webkit.messageHandlers.voiceBridge.postMessage({
            id: '\(testId)',
            operation: 'credential.has',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1'
        });
        """
        try await wv.evaluateJavaScript(jsPost + "; true;")
        let result = try await waitForBridgeResult(wv)

        XCTAssertNotNil(result, "Callback must populate window.bridgeResult")
        XCTAssertEqual(result?["id"] as? String, testId)
        XCTAssertEqual(result?["success"] as? Bool, true)
        let data = result?["data"] as? [String: Any]
        XCTAssertNotNil(data)
        XCTAssertEqual(data?["hasCredential"] as? Bool, false)
    }

    func testCanonicalBundledNavigationAllowed() {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let bundleDir = FileManager.default.temporaryDirectory.appendingPathComponent("trusted_bundle_\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundleDir) }
        handler.trustedRootURL = bundleDir

        let indexHtml = bundleDir.appendingPathComponent("index.html")
        // The document file must exist: URL.resolvingSymlinksInPath() resolution is
        // existence-dependent across platforms (iOS resolves a URL containing a
        // nonexistent final component all-or-nothing, macOS resolves per-component).
        // A nonexistent document under a symlinked root (device: /var -> /private/var)
        // would diverge from the resolved root and be spuriously cancelled.
        // Production documents always exist before navigation; mirror that here.
        try? Data("<!doctype html><html></html>".utf8).write(to: indexHtml)
        let policy = coordinator.evaluateNavigationPolicy(url: indexHtml, isMainFrame: true)
        XCTAssertEqual(policy, .allow, "Canonical bundled main document must be allowed")
    }

    func testTemporaryDirectoryOutsideTrustedRootRejected() {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let trustedDir = FileManager.default.temporaryDirectory.appendingPathComponent("trusted_root_\(UUID().uuidString)")
        let outsideDir = FileManager.default.temporaryDirectory.appendingPathComponent("outside_root_\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: trustedDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: outsideDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: trustedDir)
            try? FileManager.default.removeItem(at: outsideDir)
        }
        handler.trustedRootURL = trustedDir

        let outsideHtml = outsideDir.appendingPathComponent("evil.html")
        // Create the file (existence must not change the decision: outside root is
        // rejected whether or not the document exists).
        try? Data("<!doctype html><html></html>".utf8).write(to: outsideHtml)
        let policy = coordinator.evaluateNavigationPolicy(url: outsideHtml, isMainFrame: true)
        XCTAssertEqual(policy, .cancel, "Files outside trusted root must be rejected fail-closed")
    }

    func testHttpAndHttpsNavigationRejected() {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let httpUrl = URL(string: "http://example.com/index.html")!
        let httpsUrl = URL(string: "https://example.com/index.html")!

        XCTAssertEqual(coordinator.evaluateNavigationPolicy(url: httpUrl, isMainFrame: true), .cancel)
        XCTAssertEqual(coordinator.evaluateNavigationPolicy(url: httpsUrl, isMainFrame: true), .cancel)
    }

    func testAboutBlankNavigationRejected() {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let aboutUrl = URL(string: "about:blank")!
        XCTAssertEqual(coordinator.evaluateNavigationPolicy(url: aboutUrl, isMainFrame: true), .cancel, "about: schemes must be rejected")
    }

    func testSubframeNavigationRejected() {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let bundleDir = FileManager.default.temporaryDirectory.appendingPathComponent("trusted_sub_\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundleDir) }
        handler.trustedRootURL = bundleDir

        let indexHtml = bundleDir.appendingPathComponent("index.html")
        let policy = coordinator.evaluateNavigationPolicy(url: indexHtml, isMainFrame: false)
        XCTAssertEqual(policy, .cancel, "Privileged subframes must be rejected")
    }

    func testNavigationAwayDiscardsStaleCallback() async throws {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let wv = createConfiguredWebView(coordinator: coordinator)
        let bundleDir = FileManager.default.temporaryDirectory.appendingPathComponent("bundle_nav_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundleDir) }
        handler.trustedRootURL = bundleDir

        let page1 = bundleDir.appendingPathComponent("page1.html")
        let htmlContent1 = """
        <!DOCTYPE html>
        <html>
        <body>
        <script>
            window.bridgeResult = null;
            window.__voiceBridgeCallback = function(id, success, data, error) {
                window.bridgeResult = { id: id, success: success, data: data, error: error };
            };
        </script>
        </body>
        </html>
        """
        try htmlContent1.write(to: page1, atomically: true, encoding: .utf8)

        try await loadHtmlAndWait(wv, url: page1, coordinator: coordinator)

        let jsPost = """
        window.webkit.messageHandlers.voiceBridge.postMessage({
            id: 'nav_call',
            operation: 'credential.has',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1'
        });
        true;
        """
        try await wv.evaluateJavaScript(jsPost)

        // Advance document generation simulating leaving page1
        coordinator.advanceDocumentGeneration()
        try await Task.sleep(nanoseconds: 300_000_000)

        // Stale callback must not evaluate or deliver
        let result = try await waitForBridgeResult(wv)
        XCTAssertNil(result, "Stale callbacks after navigation must be discarded")
    }

    func testLeaveThenReturnToSameUrlStaleCallbackRejected() async throws {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let wv = createConfiguredWebView(coordinator: coordinator)
        let bundleDir = FileManager.default.temporaryDirectory.appendingPathComponent("bundle_reload_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundleDir) }
        handler.trustedRootURL = bundleDir

        let tempHtml = bundleDir.appendingPathComponent("index.html")
        let htmlContent = """
        <!DOCTYPE html>
        <html>
        <body>
        <script>
            window.bridgeResult = null;
            window.__voiceBridgeCallback = function(id, success, data, error) {
                window.bridgeResult = { id: id, success: success, data: data, error: error };
            };
        </script>
        </body>
        </html>
        """
        try htmlContent.write(to: tempHtml, atomically: true, encoding: .utf8)

        try await loadHtmlAndWait(wv, url: tempHtml, coordinator: coordinator)
        let initialGeneration = handler.documentGeneration

        // Generation 1 sends message
        try await wv.evaluateJavaScript("""
        window.webkit.messageHandlers.voiceBridge.postMessage({
            id: 'gen1_call',
            operation: 'credential.has',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1'
        });
        true;
        """)

        // Simulate leave-then-return to the same URL: document generation advances
        coordinator.advanceDocumentGeneration()
        XCTAssertEqual(handler.documentGeneration, initialGeneration + 1)

        // Generation 1 callback should be dropped
        try await Task.sleep(nanoseconds: 300_000_000)
        let staleResult = try await waitForBridgeResult(wv)
        XCTAssertNil(staleResult, "Stale callback from generation 1 must not deliver into generation 2")

        // A trusted document commit re-enables the bridge. Navigation start alone
        // must never let the old document capture the next generation.
        handler.commitMainFrameNavigation(url: tempHtml)
        XCTAssertTrue(handler.acceptsBridgeMessages)

        // Now the committed document sends a message on the same URL
        try await wv.evaluateJavaScript("""
        window.webkit.messageHandlers.voiceBridge.postMessage({
            id: 'gen2_call',
            operation: 'credential.has',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1'
        });
        true;
        """)

        let gen2Result = try await waitForBridgeResult(wv)
        XCTAssertNotNil(gen2Result, "Generation 2 callback must deliver successfully")
        XCTAssertEqual(gen2Result?["id"] as? String, "gen2_call")
    }

    func testSpecialCharactersInIdTreatedPurelyAsData() async throws {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let wv = createConfiguredWebView(coordinator: coordinator)
        let bundleDir = FileManager.default.temporaryDirectory.appendingPathComponent("bundle_special_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundleDir) }
        handler.trustedRootURL = bundleDir

        let tempHtml = bundleDir.appendingPathComponent("index.html")
        let htmlContent = """
        <!DOCTYPE html>
        <html>
        <body>
        <script>
            window.bridgeResult = null;
            window.__voiceBridgeCallback = function(id, success, data, error) {
                window.bridgeResult = { id: id, success: success, data: data, error: error };
            };
        </script>
        </body>
        </html>
        """
        try htmlContent.write(to: tempHtml, atomically: true, encoding: .utf8)

        try await loadHtmlAndWait(wv, url: tempHtml, coordinator: coordinator)

        let complexId = "id_special_\"'_\n_\u{2028}_123"
        try await wv.evaluateJavaScript("""
        window.webkit.messageHandlers.voiceBridge.postMessage({
            id: "id_special_\\"'_\\n_\\u2028_123",
            operation: 'credential.has',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1'
        });
        true;
        """)
        let result = try await waitForBridgeResult(wv)

        XCTAssertNotNil(result)
        XCTAssertEqual(result?["id"] as? String, complexId)
    }

    func testNilDataPassesAsNullToJavaScript() async throws {
        let coordinator = NavigationPolicyCoordinator(handler: handler)
        let wv = createConfiguredWebView(coordinator: coordinator)
        let bundleDir = FileManager.default.temporaryDirectory.appendingPathComponent("bundle_null_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundleDir) }
        handler.trustedRootURL = bundleDir

        let tempHtml = bundleDir.appendingPathComponent("index.html")
        let htmlContent = """
        <!DOCTYPE html>
        <html>
        <body>
        <script>
            window.bridgeResult = null;
            window.__voiceBridgeCallback = function(id, success, data, error) {
                window.bridgeResult = {
                    id: id,
                    success: success,
                    dataIsNull: data === null,
                    error: error
                };
            };
        </script>
        </body>
        </html>
        """
        try htmlContent.write(to: tempHtml, atomically: true, encoding: .utf8)

        try await loadHtmlAndWait(wv, url: tempHtml, coordinator: coordinator)

        try await wv.evaluateJavaScript("""
        window.webkit.messageHandlers.voiceBridge.postMessage({
            id: 'err_test',
            operation: 'unknown.op'
        });
        true;
        """)
        let result = try await waitForBridgeResult(wv)

        XCTAssertNotNil(result)
        XCTAssertEqual(result?["success"] as? Bool, false)
        XCTAssertEqual(result?["dataIsNull"] as? Bool, true, "nil data must become JavaScript null")
        XCTAssertEqual(result?["error"] as? String, "UNSUPPORTED_OPERATION")
    }
}
#endif
