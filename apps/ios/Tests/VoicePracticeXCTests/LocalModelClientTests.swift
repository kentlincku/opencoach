#if canImport(XCTest)
import XCTest
#if canImport(VoicePracticeCore)
@testable import VoicePracticeCore
#endif

final class LocalModelClientTests: XCTestCase {
    func testLoopbackAndLanEndpointsAreAllowedForHttp() throws {
        let allowed = [
            "http://127.0.0.1:8000/v1",
            "http://localhost:8000/v1",
            "http://[::1]:8000/v1",
            "http://192.168.1.50:8000/v1",
            "http://192.168.0.1:11434/v1",
            "http://10.0.0.15:8000/v1",
            "http://10.254.254.254:1234/v1",
            "http://172.16.0.1:8000/v1",
            "http://172.24.10.5:8000/v1",
            "http://172.31.255.254:8000/v1",
            "http://169.254.1.1:8000/v1",
            "http://mac-studio.local:8000/v1",
            "http://server.local/v1"
        ]

        for urlString in allowed {
            XCTAssertNoThrow(try LocalModelClient.validateEndpoint(urlString: urlString), "Failed for \(urlString)")
        }
    }

    func testPublicHttpEndpointsAreRejected() {
        let rejected = [
            "http://8.8.8.8:8000/v1",
            "http://1.1.1.1:8000/v1",
            "http://142.250.190.46:8000/v1",
            "http://example.com/v1",
            "http://api.openai.com/v1",
            "http://openai.com/v1",
            "http://172.15.0.1:8000/v1",
            "http://172.32.0.1:8000/v1"
        ]

        for urlString in rejected {
            XCTAssertThrowsError(try LocalModelClient.validateEndpoint(urlString: urlString)) { error in
                guard let err = error as? LocalModelError, case .publicHttpNotAllowed = err else {
                    XCTFail("Expected publicHttpNotAllowed for \(urlString), got \(error)")
                    return
                }
            }
        }
    }

    func testCredentialsInURLAreRejected() {
        let urls = [
            "http://admin:secret@127.0.0.1:8000/v1",
            "http://user:pass@192.168.1.1:8000/v1"
        ]
        for url in urls {
            XCTAssertThrowsError(try LocalModelClient.validateEndpoint(urlString: url)) { error in
                guard let err = error as? LocalModelError, case .credentialsInURL = err else {
                    XCTFail("Expected credentialsInURL for \(url), got \(error)")
                    return
                }
            }
        }
    }

    func testUnsafeSchemesAreRejected() {
        let urls = [
            "file:///etc/passwd",
            "ftp://127.0.0.1/v1",
            "ws://127.0.0.1:8000/v1",
            "javascript:alert(1)"
        ]
        for url in urls {
            XCTAssertThrowsError(try LocalModelClient.validateEndpoint(urlString: url))
        }
    }

    func testAllowedHttpsEndpoints() {
        let urls = [
            "https://api.openai.com/v1",
            "https://generativelanguage.googleapis.com/v1beta/openai",
            "https://api.groq.com/openai/v1",
            "https://192.168.1.1:8443/v1"
        ]
        for url in urls {
            XCTAssertNoThrow(try LocalModelClient.validateEndpoint(urlString: url))
        }
    }

    func testCloudCredentialCannotBeSentToLanEndpoint() {
        XCTAssertThrowsError(try LocalModelClient.validateEndpoint(urlString: "http://127.0.0.1:8000/v1", providerId: "openai")) { error in
            guard let err = error as? LocalModelError, case .cloudCredentialEndpointMismatch = err else {
                XCTFail("Expected cloudCredentialEndpointMismatch, got \(error)")
                return
            }
        }
    }

    func testCredentialBindingCanonicalKeysIsolatePortsAndPaths() throws {
        let key1 = try CredentialBinding.canonicalKey(providerId: "openai-compatible", baseUrl: "http://192.168.1.10:8000/v1")
        let key2 = try CredentialBinding.canonicalKey(providerId: "openai-compatible", baseUrl: "http://192.168.1.10:11434/v1")
        let key3 = try CredentialBinding.canonicalKey(providerId: "openai-compatible", baseUrl: "http://192.168.1.10:8000/v2")

        XCTAssertNotEqual(key1, key2, "Different ports must produce different canonical keys")
        XCTAssertNotEqual(key1, key3, "Different paths must produce different canonical keys")
        XCTAssertNotEqual(key2, key3, "Different ports/paths must produce different canonical keys")

        // Normalization equivalence: casing, trailing slashes, default ports
        let key1Upper = try CredentialBinding.canonicalKey(providerId: "openai-compatible", baseUrl: "HTTP://192.168.1.10:8000/v1/")
        XCTAssertEqual(key1, key1Upper, "Upper case scheme and trailing slash must normalize to same key")

        let defaultHttp1 = try CredentialBinding.canonicalKey(providerId: "custom", baseUrl: "http://192.168.1.10:80/v1")
        let defaultHttp2 = try CredentialBinding.canonicalKey(providerId: "custom", baseUrl: "http://192.168.1.10/v1")
        XCTAssertEqual(defaultHttp1, defaultHttp2, "Default port 80 must normalize to same key")

        let defaultHttps1 = try CredentialBinding.canonicalKey(providerId: "custom", baseUrl: "https://192.168.1.10:443/v1")
        let defaultHttps2 = try CredentialBinding.canonicalKey(providerId: "custom", baseUrl: "https://192.168.1.10/v1")
        XCTAssertEqual(defaultHttps1, defaultHttps2, "Default port 443 must normalize to same key")
    }

    func testOpenAiCloudProviderRejectsUntrustedHosts() {
        XCTAssertThrowsError(try CredentialBinding.canonicalKey(providerId: "openai", baseUrl: "http://192.168.1.50:8000/v1")) { error in
            guard let err = error as? LocalModelError, case .cloudCredentialEndpointMismatch = err else {
                XCTFail("Expected cloudCredentialEndpointMismatch, got \(error)")
                return
            }
        }

        XCTAssertNoThrow(try CredentialBinding.canonicalKey(providerId: "openai", baseUrl: "https://api.openai.com/v1"))
    }

    func testExecutableRedirectIsRejected() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = LocalModelClient(timeout: 3.0, sessionConfiguration: config)

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 302,
                httpVersion: nil,
                headerFields: ["Location": "http://127.0.0.1:8000/v1/evil"]
            )!
            return (response, Data())
        }

        do {
            _ = try await client.fetchModels(baseUrl: "http://127.0.0.1:8000/v1")
            XCTFail("Expected redirect to be rejected")
        } catch let error as LocalModelError {
            XCTAssertEqual(error, LocalModelError.redirectNotAllowed)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testExecutableOversizedResponseIsRejected() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = LocalModelClient(timeout: 3.0, sessionConfiguration: config)

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Length": "2097152"]
            )!
            let oversizedData = Data(repeating: 65, count: 2 * 1024 * 1024)
            return (response, oversizedData)
        }

        do {
            _ = try await client.fetchModels(baseUrl: "http://127.0.0.1:8000/v1")
            XCTFail("Expected oversized response to be rejected")
        } catch let error as LocalModelError {
            XCTAssertEqual(error, LocalModelError.responseTooLarge)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }
}

final class MockURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        return true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    override func startLoading() {
        guard let handler = MockURLProtocol.requestHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        do {
            let (response, data) = try handler(request)
            if (300...399).contains(response.statusCode) {
                if let location = response.allHeaderFields["Location"] as? String,
                   let redirectUrl = URL(string: location, relativeTo: request.url) {
                    let newReq = URLRequest(url: redirectUrl)
                    client?.urlProtocol(self, wasRedirectedTo: newReq, redirectResponse: response)
                    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                    client?.urlProtocolDidFinishLoading(self)
                    return
                }
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
#endif
