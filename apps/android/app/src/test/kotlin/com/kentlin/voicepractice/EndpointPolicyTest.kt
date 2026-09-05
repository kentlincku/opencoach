package com.kentlin.voicepractice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointPolicyTest {
    private val policy = EndpointPolicy()

    @Test fun acceptsOnlyLanAddressFamiliesAndLocalNames() {
        listOf(
            "http://127.0.0.1:8080/v1", "http://10.0.0.2/v1",
            "http://172.16.1.2/v1", "http://172.31.255.2/v1",
            "http://192.168.1.3/v1", "http://169.254.4.3/v1",
            "http://[::1]:8080/v1", "http://[fd12::2]/v1",
            "https://[fe80::1]/v1", "http://model-box.local/v1"
        ).forEach { assertTrue(it, policy.validate(it).isLan) }
    }

    @Test fun rejectsPublicAndAmbiguousEndpoints() {
        listOf(
            "http://8.8.8.8/v1", "https://example.com/v1", "ftp://127.0.0.1/v1",
            "http://user@127.0.0.1/v1", "http://127.0.0.1/v1?q=1",
            "http://127.0.0.1/v1#x", "http://0177.0.0.1/v1", "http://localhost.evil/v1"
        ).forEach { assertThrows(it, BridgeFault::class.java) { policy.validate(it) } }
    }

    @Test fun canonicalIdentityBindsSchemeHostPortAndPath() {
        assertEquals(
            policy.credentialBinding("local", "http://MODEL.local:80/v1/"),
            policy.credentialBinding("LOCAL", "http://model.local/v1")
        )
        assertTrue(
            policy.credentialBinding("local", "http://model.local:8080/v1") !=
                policy.credentialBinding("local", "http://model.local/v1")
        )
    }
}