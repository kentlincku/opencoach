import AVFoundation
import Foundation
import UIKit

/// One native utterance at a time; navigation and Stop settle pending playback.
@MainActor
public final class NativeSpeechService: NSObject {
    private let synthesizer = AVSpeechSynthesizer()
    private var utterance: AVSpeechUtterance?
    private var completion: CheckedContinuation<[String: Any], Error>?
    private var onStart: (([String: Any]) -> Void)?
    private var startedAt = Date()
    private var startLatencyMs: Int?
    private var watchdog: Task<Void, Never>?

    public override init() {
        super.init()
        synthesizer.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    @objc private nonisolated func interrupted() {
        Task { @MainActor [weak self] in self?.stop() }
    }

    public static func englishVoices() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en-") }
            .sorted {
                if $0.quality.rawValue != $1.quality.rawValue { return $0.quality.rawValue > $1.quality.rawValue }
                if $0.language != $1.language { return $0.language < $1.language }
                return $0.identifier < $1.identifier
            }
    }

    public static func qualityName(_ voice: AVSpeechSynthesisVoice) -> String {
        switch voice.quality {
        case .premium: return "premium"
        case .enhanced: return "enhanced"
        default: return "default"
        }
    }

    public func list() -> [String: Any] {
        ["voices": Self.englishVoices().map {
            ["id": $0.identifier, "name": $0.name, "language": $0.language, "quality": Self.qualityName($0)]
        }]
    }

    public static func makeUtterance(_ payload: [String: Any]) throws -> AVSpeechUtterance {
        guard Set(payload.keys).isSubset(of: ["id", "operation", "text", "voiceId", "language", "rate"]),
              let text = payload["text"] as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 12000 else { throw failure("INVALID_SPEECH_REQUEST") }
        guard payload["language"] == nil || payload["language"] is String,
              payload["voiceId"] == nil || payload["voiceId"] is String,
              payload["rate"] == nil || (payload["rate"] is NSNumber && CFGetTypeID(payload["rate"] as! NSNumber) != CFBooleanGetTypeID()) else {
            throw failure("INVALID_SPEECH_REQUEST")
        }
        let language = payload["language"] as? String ?? "en-US"
        let voiceID = payload["voiceId"] as? String ?? ""
        let rate = payload["rate"] as? Double ?? 1
        guard language.hasPrefix("en-"), rate.isFinite, (0.6...1.4).contains(rate) else {
            throw failure("INVALID_SPEECH_REQUEST")
        }
        let voices = englishVoices()
        let selected: AVSpeechSynthesisVoice?
        if !voiceID.isEmpty {
            selected = voices.first { $0.identifier == voiceID }
        } else {
            let bestQuality = voices.first?.quality
            selected = voices.first { $0.language == language && $0.quality == bestQuality } ?? voices.first
        }
        guard let selected else { throw failure("NATIVE_VOICE_UNAVAILABLE") }
        let value = AVSpeechUtterance(string: text)
        value.voice = selected
        value.rate = AVSpeechUtteranceDefaultSpeechRate * Float(rate)
        value.pitchMultiplier = 1
        return value
    }

    public func speak(_ payload: [String: Any], onStart: @escaping ([String: Any]) -> Void) async throws -> [String: Any] {
        let value = try Self.makeUtterance(payload)
        stop()
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try AVAudioSession.sharedInstance().setActive(true)
        return try await withCheckedThrowingContinuation { continuation in
            self.completion = continuation
            self.onStart = onStart
            self.utterance = value
            self.startedAt = Date()
            self.startLatencyMs = nil
            self.watchdog = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard !Task.isCancelled, let self, self.utterance === value, self.startLatencyMs == nil else { return }
                self.stop(errorCode: "SPEECH_START_TIMEOUT")
            }
            synthesizer.speak(value)
        }
    }

    public func stop() {
        stop(errorCode: "SPEECH_CANCELLED")
    }

    private func stop(errorCode: String) {
        let pending = completion
        watchdog?.cancel()
        watchdog = nil
        completion = nil
        utterance = nil
        onStart = nil
        synthesizer.stopSpeaking(at: .immediate)
        pending?.resume(throwing: Self.failure(errorCode))
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart value: AVSpeechUtterance) {
        guard utterance === value else { return }
        watchdog?.cancel()
        watchdog = nil
        startLatencyMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        onStart?(["voiceName": value.voice?.name ?? "", "quality": value.voice.map(Self.qualityName) ?? "default",
                  "startLatencyMs": startLatencyMs ?? 0])
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish value: AVSpeechUtterance) {
        guard utterance === value else { return }
        let pending = completion
        completion = nil
        utterance = nil
        onStart = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        pending?.resume(returning: ["finished": true, "startLatencyMs": startLatencyMs ?? 0])
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel value: AVSpeechUtterance) {
        guard utterance === value else { return }
        stop()
    }

    private static func failure(_ code: String) -> NSError {
        NSError(domain: "NativeSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
    }
}

// SE-0423 conformance annotations require Swift 6. Keep the Swift 5/Xcode 15
// source path usable without removing main-actor isolation from the service.
#if compiler(>=6.0)
extension NativeSpeechService: @preconcurrency AVSpeechSynthesizerDelegate {}
#else
extension NativeSpeechService: AVSpeechSynthesizerDelegate {}
#endif
