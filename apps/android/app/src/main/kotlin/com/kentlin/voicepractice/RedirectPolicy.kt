package com.kentlin.voicepractice

import okhttp3.HttpUrl

class RedirectPolicy(private val endpointPolicy: EndpointPolicy, private val maxHops: Int = 3) {
    fun next(current: HttpUrl, location: String): HttpUrl {
        val next = current.resolve(location) ?: throw BridgeFault("REDIRECT_REJECTED")
        endpointPolicy.validate(next.toString())
        if (current.scheme != next.scheme || current.host != next.host || current.port != next.port) throw BridgeFault("REDIRECT_REJECTED")
        return next
    }

    fun validateHopCount(hops: Int) {
        if (hops >= maxHops) throw BridgeFault("REDIRECT_REJECTED")
    }
}