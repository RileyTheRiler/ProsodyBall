package com.prosodyball.wear.feedback

import android.content.Context
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.prosodyball.feedback.AlertType

/**
 * Distinct on-wrist vibration per alert so feedback works eyes-free and
 * silently (the core of discrete mode). Legend, also shown in Settings:
 *
 * - PITCH_LOW: one long buzz            - PITCH_HIGH: two short taps
 * - MONOTONE: three quick taps          - TOO_FAST: long-short
 * - MUSHY: short-short-long             - TOO_LOUD: long-long
 * - TOO_QUIET: short-long               - TOO_HEAVY: long-short-short
 * - TOO_LIGHT: short-short              - RESONANCE_DARK: short-long-short
 * - RESONANCE_BRIGHT: long-short-long
 */
class HapticPatterns(context: Context) {

    private val vibrator: Vibrator = run {
        val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
        manager.defaultVibrator
    }

    fun play(alert: AlertType) {
        if (!vibrator.hasVibrator()) return
        vibrator.vibrate(effectFor(alert))
    }

    /** Single confirmation pulse (session start/stop), matching the web app's [40,30,40] pattern. */
    fun confirm() {
        if (!vibrator.hasVibrator()) return
        vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 40, 30, 40), -1))
    }

    fun effectFor(alert: AlertType): VibrationEffect {
        val short = 80L
        val long = 350L
        val gap = 120L
        val timings = when (alert) {
            AlertType.PITCH_LOW -> longArrayOf(0, 500)
            AlertType.PITCH_HIGH -> longArrayOf(0, short, gap, short)
            AlertType.MONOTONE -> longArrayOf(0, short, gap, short, gap, short)
            AlertType.TOO_FAST -> longArrayOf(0, long, gap, short)
            AlertType.MUSHY -> longArrayOf(0, short, gap, short, gap, long)
            AlertType.TOO_LOUD -> longArrayOf(0, long, gap, long)
            AlertType.TOO_QUIET -> longArrayOf(0, short, gap, long)
            AlertType.TOO_HEAVY -> longArrayOf(0, long, gap, short, gap, short)
            AlertType.TOO_LIGHT -> longArrayOf(0, short, gap, short)
            AlertType.RESONANCE_DARK -> longArrayOf(0, short, gap, long, gap, short)
            AlertType.RESONANCE_BRIGHT -> longArrayOf(0, long, gap, short, gap, long)
        }
        return VibrationEffect.createWaveform(timings, -1)
    }
}
