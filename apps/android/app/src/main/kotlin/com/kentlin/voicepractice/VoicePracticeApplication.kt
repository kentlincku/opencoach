package com.kentlin.voicepractice

import android.app.Application

class VoicePracticeApplication : Application() {
    lateinit var providerService: AndroidProviderService
        private set

    override fun onCreate() {
        super.onCreate()
        val endpointPolicy = EndpointPolicy()
        val credentialStore = EncryptedCredentialStore(
            SharedPreferencesEnvelopePersistence(this),
            AndroidKeystoreEnvelopeCipher()
        )
        providerService = AndroidProviderService(endpointPolicy, credentialStore)
    }
}

/** One app-scoped native service; Android never launches or downloads executable runtime code. */
class AndroidProviderService(
    val endpointPolicy: EndpointPolicy,
    val credentials: CredentialRepository,
    val provider: ProviderClient = LocalProviderClient(endpointPolicy, credentials)
)