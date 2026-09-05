package com.kentlin.voicepractice

class FakeEnvelopePersistence : EnvelopePersistence {
    val values = mutableMapOf<String, String>()
    override fun get(binding: String) = values[binding]
    override fun putAtomically(binding: String, envelope: String) { values[binding] = envelope }
    override fun removeAtomically(binding: String) { values.remove(binding) }
}

class FakeEnvelopeCipher : EnvelopeCipher {
    var lastAssociatedData = byteArrayOf()
    override fun seal(plaintext: ByteArray, associatedData: ByteArray): CipherEnvelope {
        lastAssociatedData = associatedData.copyOf()
        val tag = associatedData.fold(0) { acc, byte -> acc xor byte.toInt() }.toByte()
        return CipherEnvelope(byteArrayOf(tag), plaintext.map { (it.toInt() xor tag.toInt()).toByte() }.toByteArray())
    }
    override fun open(envelope: CipherEnvelope, associatedData: ByteArray): ByteArray {
        val tag = associatedData.fold(0) { acc, byte -> acc xor byte.toInt() }.toByte()
        if (envelope.iv.singleOrNull() != tag) throw SecurityException("Binding mismatch")
        return envelope.ciphertext.map { (it.toInt() xor tag.toInt()).toByte() }.toByteArray()
    }
}

class FakeCredentialRepository : CredentialRepository {
    private val values = mutableMapOf<String, ByteArray>()
    override fun has(binding: String) = values.containsKey(binding)
    override fun set(binding: String, credential: ByteArray) { values[binding] = credential.copyOf(); credential.fill(0) }
    override fun clear(binding: String) { values.remove(binding)?.fill(0) }
    override fun readForNativeRequest(binding: String) = values[binding]?.copyOf()
}

class FakeProviderClient : ProviderClient {
    var calls = 0
    override suspend fun models(operation: BridgeOperation.Models): List<String> { calls++; return listOf("model") }
    override suspend fun chat(operation: BridgeOperation.Chat): String { calls++; return "reply" }
}