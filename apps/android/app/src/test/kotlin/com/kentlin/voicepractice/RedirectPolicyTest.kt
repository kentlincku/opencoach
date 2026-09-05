package com.kentlin.voicepractice

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RedirectPolicyTest {
    private val redirects = RedirectPolicy(EndpointPolicy())

    @Test fun validatesEveryRelativeRedirectHop() {
        val start = "http://192.168.1.4:8080/v1/models".toHttpUrl()
        assertEquals("http://192.168.1.4:8080/v2/models", redirects.next(start, "/v2/models").toString())
    }

    @Test fun rejectsPublicUnsafeAndOriginChangingRedirects() {
        val start = "http://192.168.1.4:8080/v1/models".toHttpUrl()
        listOf("http://example.com/x", "file:///etc/passwd", "http://192.168.1.5:8080/x").forEach {
            assertThrows(BridgeFault::class.java) { redirects.next(start, it) }
        }
    }
}