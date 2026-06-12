package com.prosodyball.wear.audio

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log

/**
 * Routes microphone input (built-in vs Bluetooth headset SCO) and reports
 * whether a Bluetooth audio output is available for cue playback.
 *
 * SCO may negotiate 8kHz narrowband; callers should check [isNarrowband] and
 * apply the degraded-band handling (the analyzer keeps every band inside
 * Nyquist automatically; the UI shows a "narrowband mic" badge and resonance
 * confidence is reduced).
 */
class AudioRouteManager(context: Context) {

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var scoStarted = false

    /** True when capture is routed through a Bluetooth headset mic. */
    var usingBluetoothMic = false
        private set

    val isNarrowband: Boolean
        get() = usingBluetoothMic // assume worst case until proven wideband; metrics stay valid either way

    fun bluetoothInputDevice(): AudioDeviceInfo? =
        audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        }

    fun hasBluetoothOutput(): Boolean =
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        }

    /** Attempts to route capture through a connected Bluetooth headset. */
    fun enableBluetoothMic(): Boolean {
        val device = bluetoothInputDevice()
        if (device == null) {
            Log.i(TAG, "No Bluetooth headset mic available")
            return false
        }
        usingBluetoothMic = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.setCommunicationDevice(device)
        } else {
            @Suppress("DEPRECATION")
            audioManager.startBluetoothSco()
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            scoStarted = true
            true
        }
        return usingBluetoothMic
    }

    fun disableBluetoothMic() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        } else if (scoStarted) {
            @Suppress("DEPRECATION")
            audioManager.stopBluetoothSco()
            audioManager.mode = AudioManager.MODE_NORMAL
            scoStarted = false
        }
        usingBluetoothMic = false
    }

    private companion object {
        const val TAG = "AudioRouteManager"
    }
}
