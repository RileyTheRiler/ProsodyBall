package com.voxarcade.wear

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * YIN monophonic pitch detector — a faithful Kotlin port of the canonical web DSP
 * (`app.js` detectPitch + `dsp-utils.js` correctOctaveError). Time-domain, no FFT.
 *
 * The web version captures at ~44.1 kHz and decimates 2× before running YIN; the
 * native app captures at 16 kHz, so YIN runs directly at the capture rate. Returns
 * the median-filtered fundamental in Hz (0 when silent/unvoiced) and exposes a
 * per-frame [confidence] derived from the YIN CMND value.
 */
class PitchDetector(
    private val sampleRate: Int = 16_000,
    private val minHz: Float = 70f,
    private val maxHz: Float = 400f,
) {
    /** 0 = unreliable, 1 = very confident (from the YIN CMND at the chosen lag). */
    var confidence: Float = 0f
        private set

    private val medianBuf = ArrayDeque<Float>()
    private var cmnd = FloatArray(0)

    /**
     * Estimate the fundamental for one [frame] of normalized (-1..1) samples.
     * [rms] is the frame RMS (reused for the silence gate). Returns Hz or 0.
     */
    fun detect(frame: FloatArray, rms: Float): Float {
        confidence = 0f
        val n = frame.size
        if (n < 64) return 0f
        if (rms < 0.012f) return 0f  // silence gate (no per-room calibration yet)

        val safeMinHz = max(40f, minHz)
        val safeMaxHz = min(600f, maxHz)
        val minPeriod = max(2, floor(sampleRate / safeMaxHz).toInt())
        val maxPeriod = min(floor(sampleRate / safeMinHz).toInt(), n / 2)
        if (maxPeriod <= minPeriod) return 0f
        val w = maxPeriod // integration window

        if (cmnd.size < maxPeriod + 1) cmnd = FloatArray(maxPeriod + 1)
        val cm = cmnd
        cm[0] = 1f
        var runningSum = 0.0

        // Difference function via running sums of squares (avoids (a-b)^2 inner loop).
        var sumSq0 = 0.0
        for (i in 0 until w) sumSq0 += (frame[i] * frame[i]).toDouble()
        var curSumSqTau = 0.0
        for (i in 0 until w) curSumSqTau += (frame[i + 1] * frame[i + 1]).toDouble()

        for (tau in 1..maxPeriod) {
            var cross = 0.0
            for (i in 0 until w) cross += (frame[i] * frame[i + tau]).toDouble()
            var diff = sumSq0 + curSumSqTau - 2 * cross
            if (diff < 0) diff = 0.0
            runningSum += diff
            cm[tau] = (diff * tau / (if (runningSum == 0.0) 1.0 else runningSum)).toFloat()
            if (tau < maxPeriod) {
                val removeVal = frame[tau]
                val addVal = frame[tau + w]
                curSumSqTau = curSumSqTau - removeVal * removeVal + addVal * addVal
            }
        }

        // Absolute threshold: first dip below the YIN threshold, walked to its minimum.
        var bestTau = -1
        var tau = minPeriod
        while (tau <= maxPeriod) {
            if (cm[tau] < YIN_THRESHOLD) {
                while (tau + 1 <= maxPeriod && cm[tau + 1] < cm[tau]) tau++
                bestTau = tau
                break
            }
            tau++
        }
        if (bestTau < 0) {
            var minVal = Float.POSITIVE_INFINITY
            for (t in minPeriod..maxPeriod) if (cm[t] < minVal) { minVal = cm[t]; bestTau = t }
            if (minVal > 0.4f) return 0f // likely unvoiced
        }

        bestTau = correctOctaveError(cm, bestTau, maxPeriod)

        // Parabolic interpolation for sub-sample accuracy.
        var period = bestTau.toFloat()
        val cmndAtBest = cm[bestTau]
        if (bestTau in 1 until maxPeriod) {
            val a = cm[bestTau - 1]; val b = cm[bestTau]; val c = cm[bestTau + 1]
            val denom = 2 * (2 * b - a - c)
            if (abs(denom) > 1e-10f) period = bestTau + (a - c) / denom
        }
        if (period <= 0f) return 0f

        val rawHz = sampleRate / period
        confidence = max(0f, min(1f, 1f - cmndAtBest * PITCH_CONFIDENCE_FACTOR))

        // 7-frame median suppresses octave jumps / transient blips.
        medianBuf.addLast(rawHz)
        if (medianBuf.size > 7) medianBuf.removeFirst()
        if (medianBuf.size < 3) return rawHz
        val sorted = medianBuf.sorted()
        return sorted[sorted.size / 2]
    }

    fun reset() {
        medianBuf.clear()
        confidence = 0f
    }

    /**
     * Recover the true (longer) period when YIN's first-below-threshold rule latched
     * onto a 2×/3× harmonic — common for deep voices with a weak fundamental dip.
     */
    private fun correctOctaveError(cm: FloatArray, bestTau: Int, maxPeriod: Int): Int {
        if (bestTau <= 0) return bestTau
        val limit = min(maxPeriod, cm.size - 1)
        val baseVal = cm[bestTau]
        if (baseVal < 0.05f) return bestTau // confident dip — leave it alone
        var m = 2
        while (m * bestTau <= limit) {
            val t = m * bestTau
            val v = cm[t]
            val isLocalMin = v <= cm[t - 1] && (t + 1 > limit || v <= cm[t + 1])
            if (isLocalMin && v < RELAXED_THRESHOLD && v <= baseVal + 0.02f) return t
            m++
        }
        return bestTau
    }

    private companion object {
        const val YIN_THRESHOLD = 0.15f
        const val PITCH_CONFIDENCE_FACTOR = 3.3f
        const val RELAXED_THRESHOLD = 0.35f
    }
}
