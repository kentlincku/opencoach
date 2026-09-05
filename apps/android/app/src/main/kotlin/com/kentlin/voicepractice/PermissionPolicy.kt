package com.kentlin.voicepractice

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResultLauncher
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred

object LocalNetworkPermissionPolicy {
    const val ACCESS_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
    fun requiredPermission(deviceSdk: Int, targetSdk: Int): String? = when {
        deviceSdk >= 37 && targetSdk >= 37 -> ACCESS_LOCAL_NETWORK
        deviceSdk >= 36 -> Manifest.permission.NEARBY_WIFI_DEVICES
        else -> null
    }
}

interface PermissionGate { fun isGranted(): Boolean }
object GrantedPermissionGate : PermissionGate { override fun isGranted() = true }
object DeniedPermissionGate : PermissionGate { override fun isGranted() = false }

class AndroidLocalNetworkPermissionGate(
    private val activity: Activity,
    private val launcher: ActivityResultLauncher<String>
) : PermissionGate {
    private fun permission() = LocalNetworkPermissionPolicy.requiredPermission(Build.VERSION.SDK_INT, activity.applicationInfo.targetSdkVersion)
    override fun isGranted(): Boolean = permission()?.let { ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED } ?: true
    fun requestIfNeeded() { permission()?.takeUnless { isGranted() }?.let(launcher::launch) }
    fun openSettings() {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
    }
}

class MicrophonePermissionController(
    private val activity: Activity,
    private val launcher: ActivityResultLauncher<String>
) {
    private var pending: CompletableDeferred<Boolean>? = null
    private var hasRequested = false

    fun isGranted(): Boolean = ContextCompat.checkSelfPermission(
        activity, Manifest.permission.RECORD_AUDIO
    ) == PackageManager.PERMISSION_GRANTED

    suspend fun ensureGranted() {
        if (isGranted()) return
        if (pending != null) throw BridgeFault("MICROPHONE_PERMISSION_REQUEST_ACTIVE")
        val result = CompletableDeferred<Boolean>()
        pending = result
        val wasPreviouslyRequested = hasRequested
        hasRequested = true
        launcher.launch(Manifest.permission.RECORD_AUDIO)
        if (!result.await()) {
            val permanentlyDenied = wasPreviouslyRequested &&
                !activity.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
            throw BridgeFault(
                "MICROPHONE_PERMISSION_DENIED",
                if (permanentlyDenied) "OPEN_APP_SETTINGS" else "REQUEST_MICROPHONE_PERMISSION"
            )
        }
    }

    fun onResult(granted: Boolean) {
        pending?.complete(granted)
        pending = null
    }

    fun cancelPending() {
        pending?.completeExceptionally(BridgeFault("RUNTIME_CANCELLED"))
        pending = null
    }

    fun openSettings() {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
    }
}
