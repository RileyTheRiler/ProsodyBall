package com.voxarcade.wear

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Native vibration wrapper. Plays a `[on, off, …]` ms timing array at a fixed
 * amplitude (1..255) when the motor supports amplitude control, so Discreet
 * (gentle) and Practice (stronger) haptics feel different; falls back to the
 * default-amplitude waveform otherwise. Ported from the old WebView app's
 * HapticsBridge.vibrateAmp.
 */
class Haptics(context: Context) {

    private val vibrator: Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)
                ?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    /**
     * Play a `[on, off, …]` ms [timings] pattern at [amplitude] (1..255). No-ops when
     * there's no motor or the pattern is empty; vibration exceptions are swallowed.
     */
    fun buzz(timings: LongArray, amplitude: Int) {
        val v = vibrator ?: return
        if (!v.hasVibrator() || timings.isEmpty()) return
        try {
            // Leading 0 = initial off-delay; the rest alternate on/off starting "on".
            val waveform = LongArray(timings.size + 1)
            for (i in timings.indices) waveform[i + 1] = timings[i]

            if (v.hasAmplitudeControl() && amplitude in 1..255) {
                val amps = IntArray(timings.size + 1)
                for (i in timings.indices) amps[i + 1] = if (i % 2 == 0) amplitude else 0
                v.vibrate(VibrationEffect.createWaveform(waveform, amps, -1))
            } else {
                v.vibrate(VibrationEffect.createWaveform(waveform, -1))
            }
        } catch (_: Exception) {
        }
    }
}
