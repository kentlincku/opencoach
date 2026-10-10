// First-party text-only helper. stdout is protocol-only; no tools, subprocesses,
// downloads, credentials, environment-selected executables or framework logging.
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif
import Darwin

private struct Message: Codable, Sendable { let role: String; let content: String }
private struct Parameters: Decodable, Sendable {
    let messages: [Message]?
    let maxTokens: Int?
    let requestId: String?
}
private struct Request: Decodable, Sendable {
    let `protocol`: Int
    let id: String
    let method: String
    let params: Parameters
}
private enum HelperError: Error { case invalid, unavailable, output }

private actor Helper {
    private var task: Task<Void, Never>?
    private var activeID: String?
    private var quitting = false

    private func emit(_ id: String, success: Bool, result: [String: String]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: ["protocol": 1, "id": id, "success": success, "result": result]) else { exit(70) }
        do { try FileHandle.standardOutput.write(contentsOf: bytes + Data([10])) }
        catch { exit(74) }
    }
    private func availability() -> String {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available: return "available"
            case .unavailable(let reason):
                switch reason {
                case .deviceNotEligible: return "device-not-eligible"
                case .appleIntelligenceNotEnabled: return "intelligence-disabled"
                case .modelNotReady: return "model-not-ready"
                @unknown default: return "unavailable"
                }
            @unknown default: return "unavailable"
            }
        }
        #endif
        return "unsupported-os"
    }
    func receive(_ data: Data) {
        guard !quitting,
            let dictionary = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            Set(dictionary.keys) == Set(["protocol", "id", "method", "params"]),
            let params = dictionary["params"] as? [String: Any],
            let request = try? JSONDecoder().decode(Request.self, from: data),
            request.protocol == 1, request.id.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$", options: .regularExpression) != nil
        else { exit(65) }
        switch request.method {
        case "availability":
            guard params.isEmpty else { emit(request.id, success: false, result: ["code": "FM_INVALID_REQUEST"]); return }
            emit(request.id, success: true, result: ["reason": availability()])
        case "quit":
            guard params.isEmpty else { exit(65) }
            quit()
        case "cancel":
            guard Set(params.keys) == Set(["requestId"]), request.params.requestId == activeID else { return }
            // Task.cancel is a cooperative REQUEST. Only finish()/exit proves completion.
            task?.cancel()
        case "generate":
            guard task == nil else { emit(request.id, success: false, result: ["code": "FM_BUSY"]); return }
            guard Set(params.keys) == Set(["messages", "maxTokens"]),
                let raw = params["messages"] as? [[String: Any]], raw.allSatisfy({ Set($0.keys) == Set(["role", "content"]) }),
                let messages = request.params.messages, !messages.isEmpty, messages.count <= 32,
                let tokens = request.params.maxTokens, (1...512).contains(tokens),
                messages.last?.role == "user",
                messages.enumerated().allSatisfy({ i, m in ["system", "user", "assistant"].contains(m.role) && (m.role != "system" || i == 0) && !m.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
                messages.reduce(0, { $0 + $1.content.utf8.count }) <= 8192
            else { emit(request.id, success: false, result: ["code": "FM_INVALID_REQUEST"]); return }
            guard availability() == "available" else { emit(request.id, success: false, result: ["code": "FM_UNAVAILABLE"]); return }
            activeID = request.id
            task = Task {
                do {
                    try Task.checkCancellation()
                    let text = try await self.generate(messages, tokens: tokens)
                    try Task.checkCancellation()
                    self.finish(request.id, success: true, result: ["text": text])
                } catch {
                    // Never expose arbitrary Swift/framework descriptions (which may include input).
                    let code = Task.isCancelled || error is CancellationError ? "FM_CANCELLED" : "FM_GENERATION_FAILED"
                    self.finish(request.id, success: false, result: ["code": code])
                }
            }
        default: emit(request.id, success: false, result: ["code": "FM_INVALID_REQUEST"])
        }
    }
    private func generate(_ messages: [Message], tokens: Int) async throws -> String {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            // Fresh bounded session per request: no hidden accumulated transcript.
            // System instructions stay separate from the ordered JSON user/assistant history.
            let instructions = messages.first?.role == "system" ? messages[0].content : "Reply in natural English."
            let history = messages.filter { $0.role != "system" }
            let encoded = try JSONEncoder().encode(history)
            guard let json = String(data: encoded, encoding: .utf8) else { throw HelperError.invalid }
            let prompt = "Respond to the last user message in this ordered conversation history (JSON):\n" + json
            let session = LanguageModelSession(model: SystemLanguageModel.default, instructions: instructions)
            let options = GenerationOptions(sampling: nil, maximumResponseTokens: tokens)
            let response = try await session.respond(to: prompt, options: options)
            try Task.checkCancellation()
            let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, text.utf8.count <= 8192 else { throw HelperError.output }
            return text
        }
        #endif
        throw HelperError.unavailable
    }
    private func finish(_ id: String, success: Bool, result: [String: String]) {
        guard activeID == id else { return }
        activeID = nil; task = nil
        emit(id, success: success, result: result)
        if quitting { exit(0) }
    }
    func quit() {
        quitting = true
        task?.cancel()
        if task == nil { exit(0) }
    }
}

@main private struct FoundationModelsHelper {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        let helper = Helper()
        var line = Data()
        do {
            // Read byte-wise to bound an unterminated line BEFORE allocating it all.
            for try await byte in FileHandle.standardInput.bytes {
                if byte == 10 { await helper.receive(line); line.removeAll(keepingCapacity: true) }
                else { line.append(byte); if line.count > 16384 { exit(65) } }
            }
            await helper.quit()
            // EOF requests cancellation too; parent owns a bounded escalation if it stalls.
            while true { try await Task.sleep(nanoseconds: 1_000_000_000) }
        } catch { exit(74) }
    }
}
