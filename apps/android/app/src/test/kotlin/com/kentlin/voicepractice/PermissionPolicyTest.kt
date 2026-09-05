package com.kentlin.voicepractice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PermissionPolicyTest {
    @Test fun versionsAndroid16And17PermissionBehavior() {
        assertNull(LocalNetworkPermissionPolicy.requiredPermission(deviceSdk = 35, targetSdk = 36))
        assertEquals("android.permission.NEARBY_WIFI_DEVICES", LocalNetworkPermissionPolicy.requiredPermission(36, 36))
        assertEquals("android.permission.NEARBY_WIFI_DEVICES", LocalNetworkPermissionPolicy.requiredPermission(37, 36))
        assertEquals("android.permission.ACCESS_LOCAL_NETWORK", LocalNetworkPermissionPolicy.requiredPermission(37, 37))
    }
}