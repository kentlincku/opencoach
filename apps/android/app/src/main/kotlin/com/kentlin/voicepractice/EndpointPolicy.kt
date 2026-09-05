package com.kentlin.voicepractice

import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.security.MessageDigest
import java.util.Locale

class BridgeFault(val code: String, val recovery: String? = null) : Exception(code)

data class ValidatedEndpoint(val uri: URI, val canonical: String, val isLan: Boolean)

class EndpointPolicy {
    fun validate(raw: String): ValidatedEndpoint {
        if (raw.toByteArray(Charsets.UTF_8).size > BridgeLimits.BASE_URL_BYTES) throw BridgeFault("INVALID_BASE_URL")
        val uri = try { URI(raw.trim()) } catch (_: Exception) { throw BridgeFault("INVALID_ENDPOINT") }
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: throw BridgeFault("INVALID_ENDPOINT")
        if (scheme != "http" && scheme != "https") throw BridgeFault("UNSAFE_SCHEME")
        if (uri.rawUserInfo != null) throw BridgeFault("CREDENTIALS_IN_URL")
        if (uri.rawQuery != null || uri.rawFragment != null) throw BridgeFault("URL_COMPONENT_FORBIDDEN")
        val host = uri.host?.lowercase(Locale.ROOT)?.removePrefix("[")?.removeSuffix("]")
            ?: throw BridgeFault("INVALID_ENDPOINT")
        if (host.isBlank() || uri.port < -1 || uri.port > 65_535) throw BridgeFault("INVALID_ENDPOINT")
        if (!isLanHost(host)) throw BridgeFault(if (scheme == "http") "PUBLIC_HTTP_FORBIDDEN" else "ENDPOINT_HOST_DISALLOWED")
        val port = when {
            uri.port == -1 -> null
            scheme == "http" && uri.port == 80 -> null
            scheme == "https" && uri.port == 443 -> null
            else -> uri.port
        }
        val displayHost = if (host.contains(':')) "[$host]" else host
        val cleanPath = (uri.rawPath ?: "").trimEnd('/').ifEmpty { "" }
        val canonical = "$scheme://$displayHost${port?.let { ":$it" } ?: ""}$cleanPath"
        return ValidatedEndpoint(URI(canonical), canonical, true)
    }

    fun credentialBinding(providerId: String, baseUrl: String): String {
        val provider = providerId.trim().lowercase(Locale.ROOT)
        if (!provider.matches(Regex("[a-z0-9][a-z0-9._-]{0,63}"))) throw BridgeFault("INVALID_PROVIDER_ID")
        val canonical = validate(baseUrl).canonical
        val digest = MessageDigest.getInstance("SHA-256").digest("$provider\n$canonical".toByteArray())
        return "endpoint:" + digest.joinToString("") { "%02x".format(it) }
    }

    fun isLanHost(host: String): Boolean {
        val lower = host.lowercase(Locale.ROOT)
        if (lower == "localhost" || lower.endsWith(".local")) return true
        parseStrictIpv4(lower)?.let { return isLanAddress(it) }
        if (!lower.contains(':')) return false
        return try { isLanAddress(InetAddress.getByName(lower)) } catch (_: Exception) { false }
    }

    fun isLanAddress(address: InetAddress): Boolean {
        val bytes = address.address
        if (bytes.size == 4) {
            val a = bytes[0].toInt() and 255
            val b = bytes[1].toInt() and 255
            return a == 127 || a == 10 || (a == 172 && b in 16..31) ||
                (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        if (address is Inet6Address) {
            val first = bytes[0].toInt() and 255
            val second = bytes[1].toInt() and 255
            return address.isLoopbackAddress || (first and 0xfe) == 0xfc || (first == 0xfe && (second and 0xc0) == 0x80)
        }
        return false
    }

    private fun parseStrictIpv4(host: String): InetAddress? {
        val parts = host.split('.')
        if (parts.size != 4 || parts.any { it.isEmpty() || (it.length > 1 && it.startsWith('0')) || it.any { c -> !c.isDigit() } }) return null
        val octets = parts.map { it.toIntOrNull() ?: return null }
        if (octets.any { it !in 0..255 }) return null
        return InetAddress.getByAddress(octets.map { it.toByte() }.toByteArray())
    }
}