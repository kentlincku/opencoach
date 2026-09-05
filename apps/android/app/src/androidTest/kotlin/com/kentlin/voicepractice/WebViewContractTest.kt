package com.kentlin.voicepractice

import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import android.Manifest
import android.content.pm.PackageManager

@RunWith(AndroidJUnit4::class)
class WebViewContractTest {
    @get:Rule val activity = ActivityScenarioRule(MainActivity::class.java)

    @Test fun shellUsesFixedAppassetsOriginAndHardenedSettings() {
        activity.scenario.onActivity { screen ->
            val webView = screen.webViewForTest
            assertNotNull(webView)
            assertEquals("https://appassets.androidplatform.net", webView.url?.let { android.net.Uri.parse(it).let { u -> "${u.scheme}://${u.host}" } })
            assertFalse(webView.settings.allowFileAccess)
            assertFalse(webView.settings.allowContentAccess)
            assertFalse(webView.settings.allowFileAccessFromFileURLs)
            assertFalse(webView.settings.allowUniversalAccessFromFileURLs)
            assertFalse(webView.settings.javaScriptCanOpenWindowsAutomatically)
        }
    }

    @Test fun manifestRequestsOnlyTheRuntimeMicrophonePermissionForVoice() {
        activity.scenario.onActivity { screen ->
            val info = screen.packageManager.getPackageInfo(screen.packageName, PackageManager.GET_PERMISSIONS)
            val requested = info.requestedPermissions.orEmpty().toSet()
            assertEquals(true, Manifest.permission.RECORD_AUDIO in requested)
            assertEquals(false, Manifest.permission.CAMERA in requested)
        }
    }
}