package com.kentlin.voicepractice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeVoicePolicyTest {
    @Test fun speechRequiresApi31AndOnDeviceRecognizer() {
        assertEquals("STT_REQUIRES_API_31", OnDeviceSpeechPolicy.status(30, onDeviceAvailable = true))
        assertEquals("STT_ON_DEVICE_UNAVAILABLE", OnDeviceSpeechPolicy.status(31, onDeviceAvailable = false))
        assertNull(OnDeviceSpeechPolicy.status(31, onDeviceAvailable = true))
    }

    @Test fun ttsRejectsNetworkAndMissingVoicesAndPrefersLocale() {
        val voices = listOf(
            LocalVoiceDescriptor("network", "en-US", requiresNetwork = true, installed = true),
            LocalVoiceDescriptor("missing", "en-US", requiresNetwork = false, installed = false),
            LocalVoiceDescriptor("gb", "en-GB", requiresNetwork = false, installed = true),
            LocalVoiceDescriptor("us", "en-US", requiresNetwork = false, installed = true)
        )
        assertEquals("us", LocalTtsVoicePolicy.select(voices, "en-US")?.name)
        assertEquals("gb", LocalTtsVoicePolicy.select(voices, "en-AU")?.name)
        assertNull(LocalTtsVoicePolicy.select(voices.take(2), "en-US"))
    }

    @Test fun registryCancelAndDisposeInvalidateLateCallbacks() {
        val registry = VoiceOperationRegistry()
        val first = registry.begin("stt_1")
        assertTrue(registry.isCurrent("stt_1", first))
        assertTrue(registry.cancel("stt_1"))
        assertFalse(registry.isCurrent("stt_1", first))
        val second = registry.begin("tts_2")
        registry.dispose()
        assertFalse(registry.isCurrent("tts_2", second))
        assertFalse(registry.canBegin())
    }
}
