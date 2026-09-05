package com.kentlin.voicepractice

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit

interface ProviderClient {
    suspend fun models(operation: BridgeOperation.Models): List<String>
    suspend fun chat(operation: BridgeOperation.Chat): String
}

class LanOnlyDns(private val policy: EndpointPolicy, private val delegate: Dns = Dns.SYSTEM) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val addresses = delegate.lookup(hostname)
        if (addresses.isEmpty() || addresses.any { !policy.isLanAddress(it) }) throw IOException("LAN endpoint resolution rejected")
        return addresses
    }
}

class LocalProviderClient(
    private val endpointPolicy: EndpointPolicy,
    private val credentials: CredentialRepository,
    client: OkHttpClient? = null,
    private val json: Json = Json { ignoreUnknownKeys = false }
) : ProviderClient {
    private val redirects = RedirectPolicy(endpointPolicy)
    private val http = (client ?: OkHttpClient()).newBuilder()
        .dns(LanOnlyDns(endpointPolicy))
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    override suspend fun models(operation: BridgeOperation.Models): List<String> = withContext(Dispatchers.IO) {
        val endpoint = endpointPolicy.validate(operation.baseUrl)
        val binding = endpointPolicy.credentialBinding(operation.providerId, operation.baseUrl)
        val request = request(endpoint.uri.resolve(endpoint.uri.path.trimEnd('/') + "/models").toString().toHttpUrl(), "GET", null, binding)
        val body = execute(request)
        val root = parseObject(body)
        val candidates = when (val data = root["data"] ?: root["models"]) {
            is JsonArray -> data.mapNotNull {
                when (it) {
                    is JsonPrimitive -> it.contentOrNull
                    is JsonObject -> (it["id"] ?: it["name"])?.jsonPrimitive?.contentOrNull
                    else -> null
                }
            }
            else -> emptyList()
        }.filter { it.isNotBlank() && it.toByteArray().size <= BridgeLimits.MODEL_BYTES }.take(BridgeLimits.MAX_MODELS)
        if (candidates.isEmpty()) throw BridgeFault("EMPTY_MODEL_LIST")
        candidates
    }

    override suspend fun chat(operation: BridgeOperation.Chat): String = withContext(Dispatchers.IO) {
        val endpoint = endpointPolicy.validate(operation.baseUrl)
        val binding = endpointPolicy.credentialBinding(operation.providerId, operation.baseUrl)
        val payload = buildJsonObject {
            put("model", JsonPrimitive(operation.model))
            put("messages", buildJsonArray {
                operation.messages.forEach { message -> add(buildJsonObject {
                    put("role", JsonPrimitive(message.role)); put("content", JsonPrimitive(message.content))
                }) }
            })
            put("max_tokens", JsonPrimitive(operation.maxTokens))
        }.toString().toByteArray()
        if (payload.size > BridgeLimits.REQUEST_BYTES) throw BridgeFault("REQUEST_TOO_LARGE")
        val body = payload.toRequestBody("application/json; charset=utf-8".toMediaType())
        val url = endpoint.uri.resolve(endpoint.uri.path.trimEnd('/') + "/chat/completions").toString().toHttpUrl()
        val root = parseObject(execute(request(url, "POST", body, binding)))
        val text = try { root["choices"]!!.jsonArray.first().jsonObject["message"]!!.jsonObject["content"]!!.jsonPrimitive.content } catch (_: Exception) {
            throw BridgeFault("INVALID_RESPONSE")
        }
        if (text.isBlank() || text.toByteArray().size > BridgeLimits.RESPONSE_BYTES) throw BridgeFault("INVALID_RESPONSE")
        text.trim()
    }

    private fun request(url: HttpUrl, method: String, body: RequestBody?, binding: String): Request {
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        val secret = credentials.readForNativeRequest(binding)
        try {
            if (secret != null) builder.header("Authorization", "Bearer ${secret.toString(Charsets.UTF_8)}")
        } finally { secret?.fill(0) }
        return builder.method(method, body).build()
    }

    private fun execute(initial: Request): String {
        var request = initial
        var hops = 0
        while (true) {
            val response = try { http.newCall(request).execute() } catch (_: IOException) { throw BridgeFault("NETWORK_ERROR") }
            try {
                if (response.code in 300..399) {
                    redirects.validateHopCount(hops++)
                    val location = response.header("Location") ?: throw BridgeFault("REDIRECT_REJECTED")
                    val next = redirects.next(request.url, location)
                    request = request.newBuilder().url(next).build()
                    continue
                }
                if (response.code !in 200..299) throw BridgeFault("HTTP_ERROR_${response.code}")
                val source = response.body?.source() ?: throw BridgeFault("INVALID_RESPONSE")
                val bytes = source.readByteArray(BridgeLimits.RESPONSE_BYTES.toLong() + 1)
                if (bytes.size > BridgeLimits.RESPONSE_BYTES) throw BridgeFault("RESPONSE_TOO_LARGE")
                return bytes.toString(Charsets.UTF_8)
            } finally {
                response.close()
            }
        }
    }

    private fun parseObject(raw: String): JsonObject = try { json.parseToJsonElement(raw).jsonObject } catch (_: Exception) { throw BridgeFault("INVALID_RESPONSE") }
}