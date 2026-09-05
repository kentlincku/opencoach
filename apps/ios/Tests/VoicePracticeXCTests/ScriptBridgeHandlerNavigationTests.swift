#if canImport(XCTest)
import XCTest
import WebKit
#if canImport(VoicePracticeCore)
@testable import VoicePracticeCore
#endif

// Packet P3: real `WKWebView` + the canonical `web/index.html` copied into the
// application test host + the production `WKNavigationDelegate` path, with a
// controllable in-flight delay so the test can navigate while an operation is
// pending.
//
// These tests deliberately:
//   * do NOT set `trustedRootURL` to a temporary directory to impersonate the
//     canonical bundle, and
//   * do NOT call `advanceDocumentGeneration()` manually — generation advances
//     only through the real `didStartProvisionalNavigation` fire of an actual
//     navigation.

@MainActor
final class ScriptBridgeHandlerNavigationTests: XCTestCase {

    // A bridge whose `handleMessage(dict:)` blocks on a gate the test controls
    // and reports when it has started / returned, so an operation can be held
    // in-flight and released only after the test has triggered a real navigation.
    //
    // The handler SUSPENDS (never blocks) at an `await withCheckedContinuation`,
    // so the main actor stays free for both the handler's `Task` and the test to
    // perform a real navigation between "post the message" and "release the gate".
    // Race-safety: if the test releases before the handler registers its response
    // continuation, that one release is remembered and consumed exactly once.
    private final class GateBridge: VoiceBridgeContract {
        private let state = DispatchQueue(label: "gate.bridge.state")
        private var startedCont: CheckedContinuation<Void, Never>?
        private var alreadyStarted = false
        private var releaseCont: CheckedContinuation<BridgeResponse, Never>?
        private var releaseRequested = false
        private var releaseConsumed = false
        private var pendingId = "unknown"
        private var _startedCount = 0
        private var _returnedIds: [String] = []

        public var startedCount: Int { state.sync { _startedCount } }
        public var returnedIds: [String] { state.sync { _returnedIds } }

        func awaitStarted() async {
            if state.sync(execute: { alreadyStarted }) { return }
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                var resumeImmediately = false
                state.sync {
                    if alreadyStarted {
                        resumeImmediately = true
                    } else {
                        precondition(startedCont == nil, "only one started waiter is supported")
                        startedCont = cont
                    }
                }
                if resumeImmediately { cont.resume() }
            }
        }

        func releaseGate() {
            var continuation: CheckedContinuation<BridgeResponse, Never>?
            var response: BridgeResponse?
            state.sync {
                guard !releaseConsumed && !releaseRequested else { return }
                if let pending = releaseCont {
                    releaseConsumed = true
                    continuation = pending
                    response = BridgeResponse(id: pendingId, success: true, hasCredential: false)
                    releaseCont = nil
                    pendingId = "unknown"
                } else {
                    releaseRequested = true
                }
            }
            if let continuation, let response {
                continuation.resume(returning: response)
            }
        }

        func handleMessage(dict: [String: Any]) async -> BridgeResponse {
            let id = dict["id"] as? String ?? "unknown"
            var startedContinuation: CheckedContinuation<Void, Never>?
            state.sync {
                _startedCount += 1
                alreadyStarted = true
                startedContinuation = startedCont
                startedCont = nil
            }
            startedContinuation?.resume()

            let response = await withCheckedContinuation { (cont: CheckedContinuation<BridgeResponse, Never>) in
                var immediateResponse: BridgeResponse?
                state.sync {
                    if releaseRequested {
                        releaseRequested = false
                        releaseConsumed = true
                        immediateResponse = BridgeResponse(id: id, success: true, hasCredential: false)
                    } else {
                        precondition(releaseCont == nil, "only one in-flight operation is supported")
                        pendingId = id
                        releaseCont = cont
                    }
                }
                if let immediateResponse { cont.resume(returning: immediateResponse) }
            }
            state.sync { _returnedIds.append(id) }
            return response
        }
    }

    private var webView: WKWebView!
    private var handler: ScriptBridgeHandler!
    private var bridge: GateBridge!
    private var policy: NavigationPolicyCoordinator!

    // Xcode's application test host must contain the same `web` folder copied by
    // the VoicePractice Resources phase. A source-tree fallback would not prove
    // production bundle layout and is intentionally forbidden here.
    private func canonicalWebIndex() -> URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web")
    }

    private var canonicalWebRoot: URL? {
        canonicalWebIndex()?.deletingLastPathComponent()
    }

    override func setUp() async throws {
        try await super.setUp()
        bridge = GateBridge()
        handler = ScriptBridgeHandler(bridge: bridge)
        handler.trustedRootURL = canonicalWebRoot
        policy = NavigationPolicyCoordinator(handler: handler)
    }

    override func tearDown() async throws {
        bridge.releaseGate()
        bridge = nil
        handler = nil
        policy = nil
        webView = nil
        try await super.tearDown()
    }

    // MARK: - Harness

    private func configuredWebView(coordinator: NavigationPolicyCoordinator) -> WKWebView {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        // The real bundled `web/index.html` is the Electron desktop UI and does
        // not register the iOS `webkit.messageHandlers.voiceBridge` contract, so
        // the test injects it. The navigation itself still uses the real canonical
        // bundled `web/index.html`.
        let injectScript = WKUserScript(
            source: "window.__voiceBridgeCallback = function(id, success, data, error) { window._lastBridgeResult = { id: id, success: success, data: data, error: error }; };",
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        controller.addUserScript(injectScript)
        controller.add(handler, name: "voiceBridge")
        config.userContentController = controller
        let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: config)
        wv.navigationDelegate = coordinator
        handler.webView = wv
        self.webView = wv
        return wv
    }

    private func loadCanonicalAndWait(_ wv: WKWebView) async throws {
        guard let canonical = canonicalWebIndex() else {
            throw XCTSkip("P3 navigation test requires the Xcode application test host with bundled web resources")
        }
        let bundleRoot = Bundle.main.bundleURL.standardizedFileURL.path + "/"
        XCTAssertTrue(
            canonical.standardizedFileURL.path.hasPrefix(bundleRoot),
            "Canonical web fixture must come from the built application test host"
        )
        var didFinish = false
        var navError: Error?
        policy.didFinishNavigation = { _, _ in didFinish = true }
        policy.didFailProvisional = { _, _, err in navError = err }
        wv.loadFileURL(canonical, allowingReadAccessTo: canonicalWebRoot ?? canonical)
        for _ in 0..<60 {
            if didFinish { return }
            if let navError = navError { throw navError }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Canonical bundled index.html did not finish loading")
    }

    private func postMessage(_ wv: WKWebView, id: String) async throws {
        try await wv.evaluateJavaScript("""
        window.webkit.messageHandlers.voiceBridge.postMessage({
            id: '\(id)',
            operation: 'credential.has',
            providerId: 'openai',
            baseUrl: 'http://127.0.0.1:8000/v1'
        });
        true;
        """)
    }

    private func lastBridgeResult(_ wv: WKWebView) async -> [String: Any]? {
        for _ in 0..<50 {
            if let v = try? await wv.evaluateJavaScript("window._lastBridgeResult") as? [String: Any] {
                return v
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return nil
    }

    // MARK: - Tests

    func testGateBuffersReleaseBeforeHandleRegistersContinuation() async {
        let earlyBridge = GateBridge()
        earlyBridge.releaseGate()
        let response = await earlyBridge.handleMessage(dict: ["id": "early_release"])
        XCTAssertEqual(response.id, "early_release")
        XCTAssertEqual(earlyBridge.returnedIds, ["early_release"])
    }

    func testBridgeIsDisabledFromProvisionalStartUntilTrustedCommit() async throws {
        let wv = configuredWebView(coordinator: policy)
        try await loadCanonicalAndWait(wv)
        XCTAssertTrue(handler.acceptsBridgeMessages)

        policy.webView(wv, didStartProvisionalNavigation: nil)
        XCTAssertFalse(handler.acceptsBridgeMessages)

        policy.webView(wv, didFinish: nil)
        XCTAssertTrue(handler.acceptsBridgeMessages)
    }

    func testSupersededNavigationFailureCannotReenableBridge() {
        let trustedRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("trusted_\(UUID().uuidString)")
        let trustedPage = trustedRoot.appendingPathComponent("index.html")
        handler.trustedRootURL = trustedRoot

        let navigationA = NSObject()
        let navigationB = NSObject()
        handler.beginMainFrameNavigation(navigationToken: navigationA)
        handler.beginMainFrameNavigation(navigationToken: navigationB)

        handler.failMainFrameNavigation(navigationToken: navigationA, currentUrl: trustedPage)
        XCTAssertFalse(handler.acceptsBridgeMessages)

        handler.failMainFrameNavigation(navigationToken: navigationB, currentUrl: trustedPage)
        XCTAssertTrue(handler.acceptsBridgeMessages)
    }

    // Real navigation-away (reload the canonical document) while an operation is
    // pending: the in-flight callback must be discarded.
    func testRealReloadOfSameCanonicalUrlDiscardsInFlightCallback() async throws {
        let wv = configuredWebView(coordinator: policy)
        try await loadCanonicalAndWait(wv)

        try await postMessage(wv, id: "inflight_reload")

        // The operation is genuinely in-flight (handleMessage is suspended at a
        // release continuation, not blocking the main actor).
        await bridge.awaitStarted()
        XCTAssertEqual(bridge.startedCount, 1)

        // Advance document generation through a REAL navigation (reload), not
        // advanceDocumentGeneration().
        let before = handler.documentGeneration
        guard let canonical = canonicalWebIndex() else { XCTFail("missing canonical"); return }
        let targetGen = handler.documentGeneration + 1
        wv.loadFileURL(canonical, allowingReadAccessTo: canonicalWebRoot ?? canonical)
        for _ in 0..<50 {
            if handler.documentGeneration >= targetGen { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertGreaterThanOrEqual(handler.documentGeneration, before + 1,
                                    "A real reload of the canonical document must advance generation")

        // Release the gate: handleMessage returns, sees the new generation and
        // discards the callback before dispatching it.
        bridge.releaseGate()

        let result = await lastBridgeResult(wv)
        XCTAssertNil(result, "In-flight callback must be discarded after real navigation-away")
        XCTAssertTrue(bridge.returnedIds.contains("inflight_reload"),
                      "handleMessage returned, proving the discard was post-resolution")
    }

    // Positive control: release the in-flight operation before any navigation —
    // the callback must deliver successfully.
    func testReleasedBeforeNavigationDeliversInFlightCallback() async throws {
        let wv = configuredWebView(coordinator: policy)
        try await loadCanonicalAndWait(wv)

        try await postMessage(wv, id: "delivered_before_nav")
        await bridge.awaitStarted()

        // Release immediately, without any navigation — callback must deliver.
        bridge.releaseGate()

        let result = await lastBridgeResult(wv)
        XCTAssertEqual(result?["id"] as? String, "delivered_before_nav")
    }
}
#endif
