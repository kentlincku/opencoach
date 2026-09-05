package com.kentlin.voicepractice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BridgeSchemaTest {
    private val schema = BridgeSchema()

    @Test fun mapsTheFiveTypedOperations() {
        val fixtures = mapOf(
            "models" to BridgeOperation.Models::class,
            "chat" to BridgeOperation.Chat::class,
            "credential.has" to BridgeOperation.CredentialHas::class,
            "credential.set" to BridgeOperation.CredentialSet::class,
            "credential.clear" to BridgeOperation.CredentialClear::class
        )
        fixtures.forEach { (name, type) ->
            val extra = when (name) {
                "chat" -> ",\"model\":\"m\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]"
                "credential.set" -> ",\"credential\":\"secret\""
                else -> ""
            }
            val parsed = schema.parse("{\"id\":\"1\",\"operation\":\"$name\",\"providerId\":\"local\",\"baseUrl\":\"http://127.0.0.1/v1\"$extra}")
            assertEquals(type, parsed::class)
        }
    }

    @Test fun rejectsUnknownFieldsAndRendererHttpControls() {
        listOf("method", "headers", "url", "authorization").forEach { field ->
            assertThrows(BridgeFault::class.java) {
                schema.parse("{\"id\":\"1\",\"operation\":\"models\",\"providerId\":\"local\",\"baseUrl\":\"http://127.0.0.1/v1\",\"$field\":\"x\"}")
            }
        }
    }

    @Test fun enforcesMessageCountContentCredentialAndByteLimits() {
        assertThrows(BridgeFault::class.java) { schema.parse("x".repeat(BridgeLimits.REQUEST_BYTES + 1)) }
        val tooMany = (1..101).joinToString(",") { "{\"role\":\"user\",\"content\":\"x\"}" }
        assertThrows(BridgeFault::class.java) {
            schema.parse("{\"id\":\"1\",\"operation\":\"chat\",\"providerId\":\"local\",\"baseUrl\":\"http://127.0.0.1/v1\",\"model\":\"m\",\"messages\":[$tooMany]}")
        }
        assertThrows(BridgeFault::class.java) {
            schema.parse("{\"id\":\"1\",\"operation\":\"credential.set\",\"providerId\":\"local\",\"baseUrl\":\"http://127.0.0.1/v1\",\"credential\":\"${"s".repeat(4097)}\"}")
        }
    }
}