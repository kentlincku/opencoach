package com.kentlin.voicepractice

object OnDeviceSpeechPolicy {
    fun status(deviceSdk: Int, onDeviceAvailable: Boolean): String? = when {
        deviceSdk < 31 -> "STT_REQUIRES_API_31"
        !onDeviceAvailable -> "STT_ON_DEVICE_UNAVAILABLE"
        else -> null
    }
}

data class LocalVoiceDescriptor(
    val name: String,
    val localeTag: String,
    val requiresNetwork: Boolean,
    val installed: Boolean
)

object LocalTtsVoicePolicy {
    fun select(voices: List<LocalVoiceDescriptor>, requestedLocale: String): LocalVoiceDescriptor? {
        val local = voices.filter { !it.requiresNetwork && it.installed }
        val requested = requestedLocale.lowercase()
        val language = requested.substringBefore('-')
        return local.firstOrNull { it.localeTag.lowercase() == requested }
            ?: local.firstOrNull { it.localeTag.lowercase().substringBefore('-') == language }
    }
}

class VoiceOperationRegistry {
    private var generation = 0L
    private var disposed = false
    private val active = mutableMapOf<String, Long>()

    @Synchronized fun canBegin() = !disposed

    @Synchronized fun begin(requestId: String): Long {
        if (disposed) throw BridgeFault("RUNTIME_DISPOSED")
        if (active.containsKey(requestId)) throw BridgeFault("DUPLICATE_REQUEST_ID")
        generation += 1
        active[requestId] = generation
        return generation
    }

    @Synchronized fun isCurrent(requestId: String, token: Long): Boolean =
        !disposed && active[requestId] == token

    @Synchronized fun complete(requestId: String, token: Long) {
        if (active[requestId] == token) active.remove(requestId)
    }

    @Synchronized fun cancel(requestId: String): Boolean {
        val existed = active.remove(requestId) != null
        generation += 1
        return existed
    }

    @Synchronized fun cancelAll(): Set<String> {
        val ids = active.keys.toSet()
        active.clear()
        generation += 1
        return ids
    }

    @Synchronized fun dispose(): Set<String> {
        val ids = cancelAll()
        disposed = true
        return ids
    }
}
