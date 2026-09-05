package com.kentlin.voicepractice

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable data class BridgeError(val code: String, val recovery: String? = null)
@Serializable data class BridgeData(
    val models: List<String>? = null,
    val text: String? = null,
    val hasCredential: Boolean? = null,
    val stored: Boolean? = null,
    val cleared: Boolean? = null,
    val protocol: Int? = null,
    val platform: String? = null,
    val arch: String? = null,
    val sttBackends: List<String>? = null,
    val ttsBackends: List<String>? = null,
    val selectedStt: String? = null,
    val selectedTts: String? = null,
    val ready: Boolean? = null,
    val degradedReason: String? = null,
    val requestId: String? = null,
    val language: String? = null,
    val backend: String? = null,
    val playback: String? = null,
    val completed: Boolean? = null,
    val cancelled: Boolean? = null,
    val disposed: Boolean? = null
)
@Serializable data class BridgeResponse(
    val id: String,
    val success: Boolean,
    val data: BridgeData? = null,
    val error: BridgeError? = null
) {
    fun toJson(): String {
        val encoded = Json.encodeToString(this)
        if (encoded.toByteArray().size <= BridgeLimits.RESPONSE_BYTES) return encoded
        return Json.encodeToString(BridgeResponse(id, false, error = BridgeError("RESPONSE_TOO_LARGE")))
    }
}

class BridgeDispatcher(
    private val schema: BridgeSchema,
    private val provider: ProviderClient,
    private val credentials: CredentialRepository,
    private val permission: PermissionGate,
    private val endpointPolicy: EndpointPolicy = EndpointPolicy(),
    private val permissionRequest: () -> Unit = {},
    private val nativeVoice: NativeVoiceRuntime? = null
) {
    suspend fun dispatch(raw: String): BridgeResponse {
        var id = "unknown"
        return try {
            val operation = schema.parse(raw)
            id = operation.id
            when (operation) {
                is BridgeOperation.Models -> {
                    requireNetworkPermission()
                    endpointPolicy.credentialBinding(operation.providerId, operation.baseUrl)
                    BridgeResponse(id, true, BridgeData(models = provider.models(operation)))
                }
                is BridgeOperation.Chat -> {
                    requireNetworkPermission()
                    endpointPolicy.credentialBinding(operation.providerId, operation.baseUrl)
                    BridgeResponse(id, true, BridgeData(text = provider.chat(operation)))
                }
                is BridgeOperation.CredentialHas -> {
                    val binding = endpointPolicy.credentialBinding(operation.providerId, operation.baseUrl)
                    BridgeResponse(id, true, BridgeData(hasCredential = credentials.has(binding)))
                }
                is BridgeOperation.CredentialSet -> {
                    val binding = endpointPolicy.credentialBinding(operation.providerId, operation.baseUrl)
                    credentials.set(binding, operation.credential)
                    BridgeResponse(id, true, BridgeData(stored = true))
                }
                is BridgeOperation.CredentialClear -> {
                    val binding = endpointPolicy.credentialBinding(operation.providerId, operation.baseUrl)
                    credentials.clear(binding)
                    BridgeResponse(id, true, BridgeData(cleared = true))
                }
                is BridgeOperation.VoiceHealth -> {
                    val health = voice().health()
                    BridgeResponse(id, true, BridgeData(
                        protocol = health.protocol, platform = health.platform, arch = health.arch,
                        sttBackends = health.sttBackends, ttsBackends = health.ttsBackends,
                        selectedStt = health.selectedStt, selectedTts = health.selectedTts,
                        ready = health.ready, degradedReason = health.degradedReason
                    ))
                }
                is BridgeOperation.VoiceTranscribe -> {
                    val transcript = voice().transcribe(operation)
                    BridgeResponse(id, true, BridgeData(
                        requestId = transcript.requestId, text = transcript.text,
                        language = transcript.language, backend = transcript.backend
                    ))
                }
                is BridgeOperation.VoiceSynthesize -> {
                    val playback = voice().synthesize(operation)
                    BridgeResponse(id, true, BridgeData(
                        requestId = playback.requestId, playback = playback.playback,
                        completed = playback.completed, backend = playback.backend
                    ))
                }
                is BridgeOperation.VoiceCancel -> BridgeResponse(
                    id, true, BridgeData(requestId = operation.requestId, cancelled = voice().cancel(operation.requestId))
                )
                is BridgeOperation.VoiceDispose -> {
                    voice().dispose()
                    BridgeResponse(id, true, BridgeData(disposed = true))
                }
            }
        } catch (fault: BridgeFault) {
            BridgeResponse(id, false, error = BridgeError(fault.code, fault.recovery))
        } catch (_: Exception) {
            BridgeResponse(id, false, error = BridgeError("BRIDGE_EXECUTION_ERROR"))
        }
    }

    private fun voice() = nativeVoice ?: throw BridgeFault("NATIVE_VOICE_UNAVAILABLE")

    private fun requireNetworkPermission() {
        if (!permission.isGranted()) {
            permissionRequest()
            throw BridgeFault("LOCAL_NETWORK_PERMISSION_REQUIRED", "OPEN_APP_SETTINGS")
        }
    }
}
