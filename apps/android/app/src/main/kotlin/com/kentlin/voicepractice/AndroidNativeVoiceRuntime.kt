package com.kentlin.voicepractice

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale

@kotlinx.serialization.Serializable
data class VoiceCapabilities(
    val protocol: Int = 1,
    val platform: String = "android",
    val arch: String,
    val sttBackends: List<String>,
    val ttsBackends: List<String>,
    val selectedStt: String?,
    val selectedTts: String?,
    val ready: Boolean,
    val degradedReason: String?
)

data class VoiceTranscript(val requestId: String, val text: String, val language: String, val backend: String)
data class VoicePlayback(val requestId: String, val playback: String = "direct", val completed: Boolean = true, val backend: String = "android-tts-local")

interface NativeVoiceRuntime {
    suspend fun health(): VoiceCapabilities
    suspend fun transcribe(operation: BridgeOperation.VoiceTranscribe): VoiceTranscript
    suspend fun synthesize(operation: BridgeOperation.VoiceSynthesize): VoicePlayback
    fun cancel(requestId: String): Boolean
    fun cancelAll()
    fun dispose()
}

class AndroidNativeVoiceRuntime(
    private val context: Context,
    private val microphonePermission: MicrophonePermissionController
) : NativeVoiceRuntime {
    private enum class TtsState { INITIALIZING, READY, FAILED, DISPOSED }
    private data class PendingStt(val requestId: String, val token: Long, val result: CompletableDeferred<VoiceTranscript>)
    private data class PendingTts(val requestId: String, val token: Long, val result: CompletableDeferred<VoicePlayback>)

    private val registry = VoiceOperationRegistry()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ttsInitialized = CompletableDeferred<Unit>()
    private var ttsState = TtsState.INITIALIZING
    private var recognizer: SpeechRecognizer? = null
    private var pendingStt: PendingStt? = null
    private var pendingTts: PendingTts? = null
    private var tts: TextToSpeech? = null

    init {
        tts = TextToSpeech(context.applicationContext) { status ->
            mainHandler.post {
                if (ttsState != TtsState.DISPOSED) {
                    ttsState = if (status == TextToSpeech.SUCCESS) TtsState.READY else TtsState.FAILED
                    if (!ttsInitialized.isCompleted) ttsInitialized.complete(Unit)
                }
            }
        }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) { mainHandler.post { finishTts(utteranceId, null) } }
            @Deprecated("Deprecated in Android")
            override fun onError(utteranceId: String?) {
                mainHandler.post { finishTts(utteranceId, BridgeFault("TTS_PLAYBACK_FAILED")) }
            }
            override fun onError(utteranceId: String?, errorCode: Int) {
                mainHandler.post { finishTts(utteranceId, BridgeFault("TTS_PLAYBACK_FAILED")) }
            }
            override fun onStop(utteranceId: String?, interrupted: Boolean) {
                mainHandler.post { finishTts(utteranceId, BridgeFault("RUNTIME_CANCELLED")) }
            }
        })
    }

    override suspend fun health(): VoiceCapabilities {
        withTimeoutOrNull(5_000) { ttsInitialized.await() }
        val sttReason = speechAvailabilityReason()
        val ttsReady = ttsState == TtsState.READY && selectLocalVoice("en-US") != null
        val reasons = buildList {
            sttReason?.let(::add)
            if (!ttsReady) add(if (ttsState == TtsState.INITIALIZING) "TTS_INITIALIZING" else "TTS_LOCAL_VOICE_UNAVAILABLE")
        }
        return VoiceCapabilities(
            arch = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown",
            sttBackends = if (sttReason == null) listOf("android-on-device-speech") else emptyList(),
            ttsBackends = if (ttsReady) listOf("android-tts-local") else emptyList(),
            selectedStt = if (sttReason == null) "android-on-device-speech" else null,
            selectedTts = if (ttsReady) "android-tts-local" else null,
            ready = sttReason == null && ttsReady,
            degradedReason = reasons.takeIf { it.isNotEmpty() }?.joinToString(";")
        )
    }

    override suspend fun transcribe(operation: BridgeOperation.VoiceTranscribe): VoiceTranscript {
        speechAvailabilityReason()?.let { throw BridgeFault(it) }
        microphonePermission.ensureGranted()
        if (pendingStt != null) throw BridgeFault("VOICE_OPERATION_BUSY")
        val token = registry.begin(operation.requestId)
        val result = CompletableDeferred<VoiceTranscript>()
        val pending = PendingStt(operation.requestId, token, result)
        pendingStt = pending
        val speechRecognizer = recognizer ?: createOnDeviceRecognizer().also { recognizer = it }
        speechRecognizer.setRecognitionListener(listenerFor(pending, operation.language))
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, operation.language)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        }
        try {
            speechRecognizer.startListening(intent)
        } catch (_: Exception) {
            completeStt(pending, null, BridgeFault("STT_START_FAILED"))
        }
        return result.await()
    }

    override suspend fun synthesize(operation: BridgeOperation.VoiceSynthesize): VoicePlayback {
        withTimeoutOrNull(5_000) { ttsInitialized.await() }
        if (ttsState != TtsState.READY) throw BridgeFault("TTS_NOT_READY")
        if (pendingTts != null) throw BridgeFault("VOICE_OPERATION_BUSY")
        val engine = tts ?: throw BridgeFault("TTS_NOT_READY")
        val voice = selectLocalVoice(operation.locale) ?: throw BridgeFault("TTS_LOCAL_VOICE_UNAVAILABLE")
        if (engine.setVoice(voice) == TextToSpeech.ERROR) throw BridgeFault("TTS_LOCAL_VOICE_UNAVAILABLE")
        engine.setSpeechRate(operation.rate)
        engine.setPitch(operation.pitch)
        val token = registry.begin(operation.requestId)
        val result = CompletableDeferred<VoicePlayback>()
        val pending = PendingTts(operation.requestId, token, result)
        pendingTts = pending
        val utteranceId = operation.requestId
        if (engine.speak(operation.text, TextToSpeech.QUEUE_FLUSH, null, utteranceId) == TextToSpeech.ERROR) {
            finishTts(utteranceId, BridgeFault("TTS_PLAYBACK_FAILED"))
        }
        return result.await()
    }

    override fun cancel(requestId: String): Boolean {
        val wasActive = registry.cancel(requestId)
        pendingStt?.takeIf { it.requestId == requestId }?.let {
            pendingStt = null
            recognizer?.cancel()
            it.result.completeExceptionally(BridgeFault("RUNTIME_CANCELLED"))
        }
        pendingTts?.takeIf { it.requestId == requestId }?.let {
            pendingTts = null
            tts?.stop()
            it.result.completeExceptionally(BridgeFault("RUNTIME_CANCELLED"))
        }
        return wasActive
    }

    override fun cancelAll() {
        registry.cancelAll()
        microphonePermission.cancelPending()
        recognizer?.cancel()
        tts?.stop()
        pendingStt?.result?.completeExceptionally(BridgeFault("RUNTIME_CANCELLED"))
        pendingTts?.result?.completeExceptionally(BridgeFault("RUNTIME_CANCELLED"))
        pendingStt = null
        pendingTts = null
    }

    override fun dispose() {
        if (!registry.canBegin()) return
        cancelAll()
        registry.dispose()
        recognizer?.destroy()
        recognizer = null
        tts?.shutdown()
        tts = null
        ttsState = TtsState.DISPOSED
        if (!ttsInitialized.isCompleted) ttsInitialized.complete(Unit)
    }

    private fun speechAvailabilityReason(): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return "STT_REQUIRES_API_31"
        return OnDeviceSpeechPolicy.status(
            Build.VERSION.SDK_INT,
            SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        )
    }

    private fun createOnDeviceRecognizer(): SpeechRecognizer {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
            throw BridgeFault("STT_ON_DEVICE_UNAVAILABLE")
        }
        return SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
    }

    private fun selectLocalVoice(localeTag: String): android.speech.tts.Voice? {
        val engine = tts ?: return null
        val descriptors = engine.voices.orEmpty().map { voice ->
            LocalVoiceDescriptor(
                name = voice.name,
                localeTag = voice.locale?.toLanguageTag().orEmpty(),
                requiresNetwork = voice.isNetworkConnectionRequired,
                installed = voice.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true
            )
        }
        val selected = LocalTtsVoicePolicy.select(descriptors, Locale.forLanguageTag(localeTag).toLanguageTag()) ?: return null
        return engine.voices.orEmpty().firstOrNull { it.name == selected.name }
    }

    private fun listenerFor(pending: PendingStt, language: String) = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onError(error: Int) { completeStt(pending, null, BridgeFault("STT_RECOGNITION_FAILED")) }
        override fun onResults(results: Bundle?) {
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
            completeStt(pending, text, if (text.isNullOrBlank()) BridgeFault("STT_NO_MATCH") else null, language)
        }
        override fun onPartialResults(partialResults: Bundle?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
    }

    private fun completeStt(pending: PendingStt, text: String?, error: BridgeFault?, language: String = "en-US") {
        if (!registry.isCurrent(pending.requestId, pending.token) || pendingStt !== pending) return
        registry.complete(pending.requestId, pending.token)
        pendingStt = null
        if (error != null) pending.result.completeExceptionally(error)
        else pending.result.complete(VoiceTranscript(
            pending.requestId,
            boundedUtf8(text.orEmpty(), BridgeLimits.MESSAGE_BYTES),
            language,
            "android-on-device-speech"
        ))
    }

    private fun finishTts(utteranceId: String?, error: BridgeFault?) {
        val pending = pendingTts ?: return
        if (utteranceId != pending.requestId || !registry.isCurrent(pending.requestId, pending.token)) return
        registry.complete(pending.requestId, pending.token)
        pendingTts = null
        if (error != null) pending.result.completeExceptionally(error)
        else pending.result.complete(VoicePlayback(pending.requestId))
    }

    private fun boundedUtf8(value: String, maxBytes: Int): String {
        if (value.toByteArray().size <= maxBytes) return value
        var end = value.length
        while (end > 0 && value.substring(0, end).toByteArray().size > maxBytes) end--
        return value.substring(0, end)
    }
}
