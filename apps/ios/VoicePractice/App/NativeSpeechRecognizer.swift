import AVFoundation
import Foundation
import Speech

/// On-device English transcription of one recorded clip (Apple Speech).
/// Audio never leaves the device: requiresOnDeviceRecognition is mandatory and the request fails closed
/// when the device cannot recognize locally.
@MainActor
public final class NativeSpeechRecognizer {
    public static let maxAudioBytes = 8 * 1024 * 1024
    private var task: SFSpeechRecognitionTask?

    public init() {}

    public static func failure(_ code: String) -> NSError {
        NSError(domain: "VoicePracticeSTT", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
    }

    private static func authorize() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        default: return false
        }
    }

    public func transcribe(_ payload: [String: Any]) async throws -> [String: Any] {
        guard Set(payload.keys).isSubset(of: ["id", "operation", "audio", "mimeType", "language"]),
              let b64 = payload["audio"] as? String, b64.count <= Self.maxAudioBytes * 4 / 3 + 4,
              let audio = Data(base64Encoded: b64), !audio.isEmpty, audio.count <= Self.maxAudioBytes else {
            throw Self.failure("INVALID_STT_REQUEST")
        }
        let language = payload["language"] as? String ?? "en-US"
        guard language.hasPrefix("en") else { throw Self.failure("INVALID_STT_REQUEST") }
        guard await Self.authorize() else { throw Self.failure("STT_NOT_AUTHORIZED") }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language == "en" ? "en-US" : language)),
              recognizer.isAvailable else { throw Self.failure("STT_UNAVAILABLE") }
        guard recognizer.supportsOnDeviceRecognition else { throw Self.failure("STT_ON_DEVICE_UNAVAILABLE") }

        // Private 0600 temp file, removed after recognition.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("vp-stt", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let mime = (payload["mimeType"] as? String ?? "").lowercased()
        let ext = mime.contains("wav") ? "wav" : (mime.contains("mp4") || mime.contains("m4a") || mime.contains("aac")) ? "m4a" : "caf"
        let file = dir.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
        FileManager.default.createFile(atPath: file.path, contents: audio, attributes: [.posixPermissions: 0o600])
        defer { try? FileManager.default.removeItem(at: file) }

        let request = SFSpeechURLRecognitionRequest(url: file)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.taskHint = .dictation
        let started = Date()
        let text: String = try await withCheckedThrowingContinuation { continuation in
            var done = false
            task = recognizer.recognitionTask(with: request) { result, error in
                guard !done else { return }
                if let result, result.isFinal { done = true; continuation.resume(returning: result.bestTranscription.formattedString); return }
                if let error {
                    done = true
                    let ns = error as NSError
                    // 1110 = no speech detected: an empty transcript, not a failure.
                    if ns.code == 1110 { continuation.resume(returning: "") } else { continuation.resume(throwing: Self.failure("STT_FAILED")) }
                }
            }
        }
        task = nil
        return ["text": text.trimmingCharacters(in: .whitespacesAndNewlines), "backend": "apple-on-device", "ms": Int(Date().timeIntervalSince(started) * 1000)]
    }

    public func cancel() { task?.cancel(); task = nil }
}
