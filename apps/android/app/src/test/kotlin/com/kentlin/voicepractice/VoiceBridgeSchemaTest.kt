package com.kentlin.voicepractice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceBridgeSchemaTest {
    private val schema = BridgeSchema()

    @Test fun mapsTypedVoiceOperations() {
        assertTrue(schema.parse("{\"id\":\"m1\",\"operation\":\"voice.health\"}") is BridgeOperation.VoiceHealth)
        assertTrue(schema.parse("{\"id\":\"m2\",\"operation\":\"voice.transcribe\",\"requestId\":\"android_stt_1\",\"language\":\"en-US\"}") is BridgeOperation.VoiceTranscribe)
        assertTrue(schema.parse("{\"id\":\"m3\",\"operation\":\"voice.synthesize\",\"requestId\":\"android_tts_1\",\"text\":\"hello\",\"locale\":\"en-US\",\"rate\":1.0,\"pitch\":1.0}") is BridgeOperation.VoiceSynthesize)
        assertTrue(schema.parse("{\"id\":\"m4\",\"operation\":\"voice.cancel\",\"requestId\":\"android_stt_1\"}") is BridgeOperation.VoiceCancel)
        assertTrue(schema.parse("{\"id\":\"m5\",\"operation\":\"voice.dispose\"}") is BridgeOperation.VoiceDispose)
    }

    @Test fun voiceOperationsRejectUnknownAndOversizeFields() {
        val unknown = assertThrows(BridgeFault::class.java) {
            schema.parse("{\"id\":\"m1\",\"operation\":\"voice.health\",\"audio\":\"raw\"}")
        }
        assertEquals("FORBIDDEN_PROPERTY", unknown.code)
        assertThrows(BridgeFault::class.java) {
            schema.parse("{\"id\":\"m2\",\"operation\":\"voice.synthesize\",\"requestId\":\"android_tts_1\",\"text\":\"${"x".repeat(BridgeLimits.VOICE_TEXT_BYTES + 1)}\"}")
        }
        assertThrows(BridgeFault::class.java) {
            schema.parse("{\"id\":\"m3\",\"operation\":\"voice.cancel\",\"requestId\":\"bad request id\"}")
        }
    }
}
