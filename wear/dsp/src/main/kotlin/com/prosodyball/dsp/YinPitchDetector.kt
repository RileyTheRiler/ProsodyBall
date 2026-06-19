package com.prosodyball.dsp

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * YIN pitch detector (de Cheveigne & Kawahara 2002), ported from
 * VoiceAnalyzer.detectPitch (app.js:490-618):
 * difference function -> cumulative mean normalized difference -> absolute
 * threshold -> parabolic interpolation, with 2x decimation for speed and a
 * 5-tap median filter for octave-jump suppression.
 */
class YinPitchDetector(private val sampleRate: Double) {

    /** Confidence of the last detection (0 = unreliable, 1 = very confident). */
    var pitchConfidence = 0.0
        private set

    private var dsBuf = DoubleArray(0)
    private var cmnd = DoubleArray(0)
    private val medianBuf = ArrayDeque<Double>()

    /**
     * Detects f0 (Hz) in [buf] (length n), or returns 0 when silent/unvoiced.
     * [precomputedRms] mirrors the JS optimization of reusing the frame RMS.
     * [profileMinHz]/[profileMaxHz] are the learned adaptive pitch bounds.
     */
    fun detectPitch(
        buf: FloatArray,
        n: Int,
        precomputedRms: Double,
        silenceThreshold: Double,
        profileMinHz: Double,
        profileMaxHz: Double,
    ): Double {
        var rms = precomputedRms
        if (!rms.isFinite()) {
            var sum = 0.0
            for (i in 0 until n) sum += buf[i] * buf[i]
            rms = sqrt(sum / n)
        }
        if (rms < silenceThreshold) return 0.0

        // 2x decimation with averaging (cheap low-pass): ~4x faster YIN
        val dsRate = sampleRate / 2
        val dsN = n / 2
        if (dsBuf.size < dsN) dsBuf = DoubleArray(dsN)
        for (i in 0 until dsN) {
            dsBuf[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5
        }

        // Adaptive bounds from the learned voice profile, with 15% safety buffer
        val safeMinHz = max(40.0, profileMinHz * 0.85)
        val safeMaxHz = min(600.0, profileMaxHz * 1.15)
        val minPeriod = max(2, floor(dsRate / safeMaxHz).toInt())
        val maxPeriod = min(floor(dsRate / safeMinHz).toInt(), dsN / 2)
        if (maxPeriod <= minPeriod) return 0.0
        val w = maxPeriod // integration window

        // Difference function d(tau) and CMND d'(tau) with running sums
        if (cmnd.size < maxPeriod + 1) cmnd = DoubleArray(maxPeriod + 1)
        cmnd[0] = 1.0
        var runningSum = 0.0

        var sumSq0 = 0.0
        for (i in 0 until w) sumSq0 += dsBuf[i] * dsBuf[i]
        var currentSumSqTau = 0.0
        for (i in 0 until w) currentSumSqTau += dsBuf[i + 1] * dsBuf[i + 1]

        for (tau in 1..maxPeriod) {
            var crossCorr = 0.0
            for (i in 0 until w) {
                crossCorr += dsBuf[i] * dsBuf[i + tau]
            }
            var diff = sumSq0 + currentSumSqTau - 2 * crossCorr
            if (diff < 0) diff = 0.0

            runningSum += diff
            cmnd[tau] = diff * tau / (if (runningSum != 0.0) runningSum else 1.0)

            if (tau < maxPeriod) {
                val removeVal = dsBuf[tau]
                val addVal = dsBuf[tau + w]
                currentSumSqTau = currentSumSqTau - removeVal * removeVal + addVal * addVal
            }
        }

        // Absolute threshold — first dip below threshold, walked to its local minimum
        var bestTau = -1
        var tau = minPeriod
        while (tau <= maxPeriod) {
            if (cmnd[tau] < AnalyzerConfig.YIN_THRESHOLD) {
                while (tau + 1 <= maxPeriod && cmnd[tau + 1] < cmnd[tau]) tau++
                bestTau = tau
                break
            }
            tau++
        }

        // Fallback: global minimum, rejected if still high (likely unvoiced)
        if (bestTau < 0) {
            var minVal = Double.POSITIVE_INFINITY
            for (t in minPeriod..maxPeriod) {
                if (cmnd[t] < minVal) {
                    minVal = cmnd[t]
                    bestTau = t
                }
            }
            if (minVal > 0.4) return 0.0
        }

        // Parabolic interpolation for sub-sample accuracy
        var period = bestTau.toDouble()
        val cmndAtBest = cmnd[bestTau]
        if (bestTau in 1 until maxPeriod) {
            val a = cmnd[bestTau - 1]
            val b = cmnd[bestTau]
            val c = cmnd[bestTau + 1]
            val denom = 2 * (2 * b - a - c)
            if (abs(denom) > 1e-10) {
                period = bestTau + (a - c) / denom
            }
        }

        val rawHz = dsRate / period
        pitchConfidence = clamp01(1 - cmndAtBest * AnalyzerConfig.PITCH_CONFIDENCE_FACTOR)

        // Median filter over recent raw detections suppresses octave jumps
        medianBuf.addLast(rawHz)
        if (medianBuf.size > 5) medianBuf.removeFirst()
        if (medianBuf.size >= 3) {
            val sorted = medianBuf.sorted()
            return sorted[sorted.size / 2]
        }
        return rawHz
    }

    fun reset() {
        medianBuf.clear()
        pitchConfidence = 0.0
    }
}
