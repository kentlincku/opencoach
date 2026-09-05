package com.kentlin.voicepractice

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class CipherEnvelope(val iv: ByteArray, val ciphertext: ByteArray)

interface EnvelopeCipher {
    fun seal(plaintext: ByteArray, associatedData: ByteArray): CipherEnvelope
    fun open(envelope: CipherEnvelope, associatedData: ByteArray): ByteArray
}

interface EnvelopePersistence {
    fun get(binding: String): String?
    fun putAtomically(binding: String, envelope: String)
    fun removeAtomically(binding: String)
}

interface CredentialRepository {
    fun has(binding: String): Boolean
    fun set(binding: String, credential: ByteArray)
    fun clear(binding: String)
    fun readForNativeRequest(binding: String): ByteArray?
}

class EncryptedCredentialStore(
    private val persistence: EnvelopePersistence,
    private val cipher: EnvelopeCipher
) : CredentialRepository {
    @Synchronized override fun has(binding: String) = persistence.get(binding) != null

    @Synchronized override fun set(binding: String, credential: ByteArray) {
        val envelope = cipher.seal(credential, binding.toByteArray())
        try {
            val encoded = "v1.${envelope.iv.b64()}.${envelope.ciphertext.b64()}"
            persistence.putAtomically(binding, encoded)
        } finally {
            credential.fill(0)
            envelope.iv.fill(0)
            envelope.ciphertext.fill(0)
        }
    }

    @Synchronized override fun clear(binding: String) = persistence.removeAtomically(binding)

    @Synchronized override fun readForNativeRequest(binding: String): ByteArray? {
        val fields = persistence.get(binding)?.split('.') ?: return null
        if (fields.size != 3 || fields[0] != "v1") throw SecurityException("Invalid credential envelope")
        return cipher.open(CipherEnvelope(fields[1].unb64(), fields[2].unb64()), binding.toByteArray())
    }

    private fun ByteArray.b64() = Base64.getEncoder().encodeToString(this)
    private fun String.unb64() = Base64.getDecoder().decode(this)
}

class SharedPreferencesEnvelopePersistence(context: Context) : EnvelopePersistence {
    private val prefs = context.getSharedPreferences("native_credentials_v1", Context.MODE_PRIVATE)
    override fun get(binding: String): String? = prefs.getString(binding, null)
    override fun putAtomically(binding: String, envelope: String) {
        if (!prefs.edit().putString(binding, envelope).commit()) throw IllegalStateException("Credential commit failed")
    }
    override fun removeAtomically(binding: String) {
        if (!prefs.edit().remove(binding).commit()) throw IllegalStateException("Credential clear failed")
    }
}

class AndroidKeystoreEnvelopeCipher(private val alias: String = "voice_practice_provider_aes_v1") : EnvelopeCipher {
    override fun seal(plaintext: ByteArray, associatedData: ByteArray): CipherEnvelope {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(associatedData)
        return CipherEnvelope(cipher.iv, cipher.doFinal(plaintext))
    }

    override fun open(envelope: CipherEnvelope, associatedData: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, envelope.iv))
        cipher.updateAAD(associatedData)
        return cipher.doFinal(envelope.ciphertext)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build())
            generateKey()
        }
    }
}