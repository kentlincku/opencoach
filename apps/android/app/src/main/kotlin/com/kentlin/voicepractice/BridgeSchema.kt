package com.kentlin.voicepractice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

object BridgeLimits {
    const val REQUEST_BYTES = 1_048_576
    const val RESPONSE_BYTES = 1_048_576
    const val BASE_URL_BYTES = 2_048
    const val ID_BYTES = 128
    const val MODEL_BYTES = 256
    const val MESSAGE_BYTES = 32_000
    const val CREDENTIAL_BYTES = 4_096
    const val VOICE_TEXT_BYTES = 8_000
    const val LOCALE_BYTES = 64
    const val MAX_MESSAGES = 100
    const val MAX_MODELS = 1_000
    val REQUEST_ID_PATTERN = Regex("^[A-Za-z0-9._:-]{1,128}$")
}

data class NativeChatMessage(val role: String, val content: String)

sealed class BridgeOperation {
    abstract val id: String
    sealed class Provider : BridgeOperation() {
        abstract val providerId: String
        abstract val baseUrl: String
    }
    data class Models(override val id: String, override val providerId: String, override val baseUrl: String) : Provider()
    data class Chat(
        override val id: String,
        override val providerId: String,
        override val baseUrl: String,
        val model: String,
        val messages: List<NativeChatMessage>,
        val maxTokens: Int
    ) : Provider()
    data class CredentialHas(override val id: String, override val providerId: String, override val baseUrl: String) : Provider()
    class CredentialSet(
        override val id: String,
        override val providerId: String,
        override val baseUrl: String,
        val credential: ByteArray
    ) : Provider() {
        override fun toString() = "CredentialSet(id=$id, providerId=$providerId, baseUrl=<redacted>, credential=<redacted>)"
    }
    data class CredentialClear(override val id: String, override val providerId: String, override val baseUrl: String) : Provider()

    data class VoiceHealth(override val id: String) : BridgeOperation()
    data class VoiceTranscribe(override val id: String, val requestId: String, val language: String) : BridgeOperation()
    data class VoiceSynthesize(
        override val id: String,
        val requestId: String,
        val text: String,
        val locale: String,
        val rate: Float,
        val pitch: Float
    ) : BridgeOperation()
    data class VoiceCancel(override val id: String, val requestId: String) : BridgeOperation()
    data class VoiceDispose(override val id: String) : BridgeOperation()
}

class BridgeSchema(private val json: Json = Json) {
    fun parse(raw: String): BridgeOperation {
        if (raw.toByteArray(Charsets.UTF_8).size > BridgeLimits.REQUEST_BYTES) throw BridgeFault("REQUEST_TOO_LARGE")
        val root = try { json.parseToJsonElement(raw) as? JsonObject } catch (_: Exception) { null }
            ?: throw BridgeFault("INVALID_JSON_MESSAGE")
        val id = root.requiredString("id", BridgeLimits.ID_BYTES, "MISSING_MESSAGE_ID")
        val operation = root.requiredString("operation", 64, "UNSUPPORTED_OPERATION")
        val envelope = setOf("id", "operation")
        val providerCommon = envelope + setOf("providerId", "baseUrl")
        fun provider() = root.optionalString("providerId", "openai-compatible", 64)
        fun base() = root.optionalString("baseUrl", "http://127.0.0.1:8000/v1", BridgeLimits.BASE_URL_BYTES)
        return when (operation) {
            "models" -> {
                root.requireOnly(providerCommon)
                BridgeOperation.Models(id, provider(), base())
            }
            "chat" -> {
                root.requireOnly(providerCommon + setOf("model", "messages", "maxTokens"))
                val model = root.requiredString("model", BridgeLimits.MODEL_BYTES, "MISSING_MODEL")
                val rawMessages = root["messages"] as? JsonArray ?: throw BridgeFault("MISSING_MESSAGES")
                if (rawMessages.isEmpty()) throw BridgeFault("EMPTY_MESSAGES")
                if (rawMessages.size > BridgeLimits.MAX_MESSAGES) throw BridgeFault("TOO_MANY_MESSAGES")
                val messages = rawMessages.map {
                    val item = it as? JsonObject ?: throw BridgeFault("MALFORMED_MESSAGES")
                    item.requireOnly(setOf("role", "content"))
                    val role = item.requiredString("role", 16, "MALFORMED_MESSAGES")
                    if (role !in setOf("system", "user", "assistant")) throw BridgeFault("MALFORMED_MESSAGES")
                    NativeChatMessage(role, item.requiredString("content", BridgeLimits.MESSAGE_BYTES, "MALFORMED_MESSAGES", allowEmpty = true))
                }
                val maxTokens = root["maxTokens"]?.let {
                    (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.intOrNull ?: throw BridgeFault("INVALID_MAX_TOKENS")
                } ?: 300
                if (maxTokens !in 1..4096) throw BridgeFault("INVALID_MAX_TOKENS")
                BridgeOperation.Chat(id, provider(), base(), model, messages, maxTokens)
            }
            "credential.has" -> {
                root.requireOnly(providerCommon)
                BridgeOperation.CredentialHas(id, provider(), base())
            }
            "credential.set" -> {
                root.requireOnly(providerCommon + "credential")
                val secret = root.requiredString("credential", BridgeLimits.CREDENTIAL_BYTES, "INVALID_CREDENTIAL").toByteArray()
                BridgeOperation.CredentialSet(id, provider(), base(), secret)
            }
            "credential.clear" -> {
                root.requireOnly(providerCommon)
                BridgeOperation.CredentialClear(id, provider(), base())
            }
            "voice.health" -> {
                root.requireOnly(envelope)
                BridgeOperation.VoiceHealth(id)
            }
            "voice.transcribe" -> {
                root.requireOnly(envelope + setOf("requestId", "language"))
                BridgeOperation.VoiceTranscribe(id, root.requestId(), root.optionalString("language", "en-US", BridgeLimits.LOCALE_BYTES))
            }
            "voice.synthesize" -> {
                root.requireOnly(envelope + setOf("requestId", "text", "locale", "rate", "pitch"))
                val text = root.requiredString("text", BridgeLimits.VOICE_TEXT_BYTES, "INVALID_VOICE_TEXT")
                val rate = root.optionalFloat("rate", 1f, 0.5f..2f)
                val pitch = root.optionalFloat("pitch", 1f, 0.5f..2f)
                BridgeOperation.VoiceSynthesize(id, root.requestId(), text, root.optionalString("locale", "en-US", BridgeLimits.LOCALE_BYTES), rate, pitch)
            }
            "voice.cancel" -> {
                root.requireOnly(envelope + "requestId")
                BridgeOperation.VoiceCancel(id, root.requestId())
            }
            "voice.dispose" -> {
                root.requireOnly(envelope)
                BridgeOperation.VoiceDispose(id)
            }
            else -> throw BridgeFault("UNSUPPORTED_OPERATION")
        }
    }

    private fun JsonObject.requireOnly(keys: Set<String>) {
        if (this.keys.any { it !in keys }) throw BridgeFault("FORBIDDEN_PROPERTY")
    }

    private fun JsonObject.requestId(): String {
        val value = requiredString("requestId", BridgeLimits.ID_BYTES, "INVALID_REQUEST_ID")
        if (!BridgeLimits.REQUEST_ID_PATTERN.matches(value)) throw BridgeFault("INVALID_REQUEST_ID")
        return value
    }

    private fun JsonObject.requiredString(key: String, maxBytes: Int, fault: String, allowEmpty: Boolean = false): String {
        val value = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw BridgeFault(fault)
        if ((!allowEmpty && value.isEmpty()) || value.toByteArray().size > maxBytes) throw BridgeFault(fault)
        return value
    }

    private fun JsonObject.optionalString(key: String, fallback: String, maxBytes: Int): String =
        if (containsKey(key)) requiredString(key, maxBytes, "INVALID_${key.uppercase()}") else fallback

    private fun JsonObject.optionalFloat(key: String, fallback: Float, range: ClosedFloatingPointRange<Float>): Float {
        if (!containsKey(key)) return fallback
        val value = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.toFloat()
            ?: throw BridgeFault("INVALID_${key.uppercase()}")
        if (!value.isFinite() || value !in range) throw BridgeFault("INVALID_${key.uppercase()}")
        return value
    }
}
