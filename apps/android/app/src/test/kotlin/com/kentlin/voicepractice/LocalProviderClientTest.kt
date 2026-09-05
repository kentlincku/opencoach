package com.kentlin.voicepractice

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class LocalProviderClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: LocalProviderClient

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        client = LocalProviderClient(EndpointPolicy(), FakeCredentialRepository(), OkHttpClient())
    }

    @After fun tearDown() = server.shutdown()

    @Test fun mapsModelsWithoutRendererChosenMethodOrHeaders() = runTest {
        server.enqueue(MockResponse().setBody("{\"data\":[{\"id\":\"lan-model\"}]}"))
        val result = client.models(BridgeOperation.Models("r1", "local", server.url("/v1").toString()))
        assertEquals(listOf("lan-model"), result)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/v1/models", request.path)
    }

    @Test fun mapsChatUsingNativeFixedRequestShape() = runTest {
        server.enqueue(MockResponse().setBody("{\"choices\":[{\"message\":{\"content\":\"hello\"}}]}"))
        val result = client.chat(BridgeOperation.Chat(
            "r1", "local", server.url("/v1").toString(), "lan-model",
            listOf(NativeChatMessage("user", "hi")), 64
        ))
        assertEquals("hello", result)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/chat/completions", request.path)
    }

    @Test fun followsOnlyRevalidatedBoundedSameOriginRedirect() = runTest {
        server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", "/v2/models"))
        server.enqueue(MockResponse().setBody("{\"data\":[{\"id\":\"redirected\"}]}"))
        assertEquals(
            listOf("redirected"),
            client.models(BridgeOperation.Models("r1", "local", server.url("/v1").toString()))
        )
        assertEquals("/v1/models", server.takeRequest().path)
        assertEquals("/v2/models", server.takeRequest().path)
    }
}