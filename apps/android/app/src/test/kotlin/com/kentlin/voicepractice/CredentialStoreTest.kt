package com.kentlin.voicepractice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CredentialStoreTest {
    @Test fun envelopeUsesBindingAsAssociatedDataAndNeverStoresPlaintext() {
        val persistence = FakeEnvelopePersistence()
        val cipher = FakeEnvelopeCipher()
        val store = EncryptedCredentialStore(persistence, cipher)
        val binding = "endpoint:abc"
        store.set(binding, "top-secret")
        assertFalse(persistence.values.getValue(binding).contains("top-secret"))
        assertTrue(store.has(binding))
        assertTrue(cipher.lastAssociatedData.contentEquals(binding.toByteArray()))
        assertTrue(store.readForNativeRequest(binding).contentEquals("top-secret".toByteArray()))
        store.clear(binding)
        assertFalse(store.has(binding))
        assertNull(persistence.values[binding])
    }

    @Test(expected = SecurityException::class)
    fun copiedEnvelopeCannotBeOpenedUnderAnotherEndpoint() {
        val persistence = FakeEnvelopePersistence()
        val store = EncryptedCredentialStore(persistence, FakeEnvelopeCipher())
        store.set("endpoint:a", "secret")
        persistence.values["endpoint:b"] = persistence.values.getValue("endpoint:a")
        store.readForNativeRequest("endpoint:b")
    }
}