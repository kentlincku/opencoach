package com.kentlin.voicepractice

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeDispatcherTest {
    @Test fun deniedPermissionProducesActionableErrorAndZeroNetwork() = runTest {
        val provider = FakeProviderClient()
        val bridge = BridgeDispatcher(BridgeSchema(), provider, FakeCredentialRepository(), DeniedPermissionGate)
        val response = bridge.dispatch("{\"id\":\"r1\",\"operation\":\"models\",\"providerId\":\"local\",\"baseUrl\":\"http://127.0.0.1/v1\"}")
        assertFalse(response.success)
        assertEquals("LOCAL_NETWORK_PERMISSION_REQUIRED", response.error?.code)
        assertEquals("OPEN_APP_SETTINGS", response.error?.recovery)
        assertEquals(0, provider.calls)
    }

    @Test fun credentialSetResponseNeverContainsSecret() = runTest {
        val bridge = BridgeDispatcher(BridgeSchema(), FakeProviderClient(), FakeCredentialRepository(), GrantedPermissionGate)
        val response = bridge.dispatch("{\"id\":\"r1\",\"operation\":\"credential.set\",\"providerId\":\"local\",\"baseUrl\":\"http://127.0.0.1/v1\",\"credential\":\"never-return-me\"}")
        assertTrue(response.success)
        assertEquals(true, response.data?.stored)
        assertNull(response.data?.text)
        assertFalse(response.toJson().contains("never-return-me"))
    }
}