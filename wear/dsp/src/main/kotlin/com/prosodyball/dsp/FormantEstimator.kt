package com.prosodyball.dsp

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

data class FormantResult(
    val f1: Double,
    val f2: Double,
    val f3: Double,
    val confidence: Double,
)

/**
 * Harmonic-envelope formant estimation, ported from
 * VoiceAnalyzer._resonanceHarmonicEnvelope (app.js:1191-1250) and
 * _peakPickFormants (app.js:1616-1713). Samples the FFT at harmonics of f0
 * to extract the vocal tract transfer function, with tilt compensation and
 * Gaussian envelope smoothing. The cepstral/LPC/centroid alternatives from the
 * web app are intentionally not ported (harmonic is the default and cheapest).
 */
class FormantEstimator {
    private var harmonicAmps = DoubleArray(0)
    private var env = DoubleArray(0)

    /**
     * @param fmtData formant-analyser float frequency data (dB per bin)
     * @param pitch detected f0 in Hz
     * @param binHz frequency resolution of [fmtData]
     * @param pitchConfidence current YIN confidence (feeds the confidence score)
     * @param vowelLikelihood current vowel likelihood (feeds the confidence score)
     */
    fun harmonicEnvelope(
        fmtData: FloatArray,
        pitch: Double,
        binHz: Double,
        pitchConfidence: Double,
        vowelLikelihood: Double,
    ): FormantResult {
        val f0 = pitch
        val maxHarmonicHz = 5500.0
        val numHarmonics = min(40, floor(maxHarmonicHz / f0).toInt())
        if (numHarmonics < 4) return FormantResult(0.0, 0.0, 0.0, 0.0)

        if (harmonicAmps.size < numHarmonics) harmonicAmps = DoubleArray(numHarmonics)

        // Sample FFT at each harmonic with peak search and parabolic amplitude interpolation
        for (h in 0 until numHarmonics) {
            val hFreq = f0 * (h + 1)
            val bin = hFreq / binHz
            val binInt = floor(bin).toInt()
            if (binInt < 1 || binInt + 1 >= fmtData.size) continue

            var peakBin = binInt
            var peakVal = fmtData[binInt].toDouble()
            val searchRange = max(1, floor(f0 / binHz * 0.3).toInt())
            for (s in -searchRange..searchRange) {
                val idx = binInt + s
                if (idx in fmtData.indices && fmtData[idx] > peakVal) {
                    peakVal = fmtData[idx].toDouble()
                    peakBin = idx
                }
            }
            if (peakBin > 0 && peakBin < fmtData.size - 1) {
                val a = fmtData[peakBin - 1].toDouble()
                val b = fmtData[peakBin].toDouble()
                val c = fmtData[peakBin + 1].toDouble()
                val denom = a - 2 * b + c
                harmonicAmps[h] = if (abs(denom) > 0.001) b - (a - c) * (a - c) / (8 * denom) else b
            } else {
                harmonicAmps[h] = peakVal
            }
        }

        // +6 dB/octave tilt compensation counteracts glottal source rolloff
        for (h in 0 until numHarmonics) {
            val hFreq = f0 * (h + 1)
            harmonicAmps[h] += 6 * (ln(hFreq / f0) / ln(2.0))
        }

        // 5-point Gaussian-weighted smoothing (sigma ~ 1.0 harmonics)
        val gWeights = doubleArrayOf(0.06, 0.24, 0.40, 0.24, 0.06)
        if (env.size < numHarmonics) env = DoubleArray(numHarmonics)
        for (i in 0 until numHarmonics) {
            var sum = 0.0
            var wSum = 0.0
            for (k in -2..2) {
                val j = i + k
                if (j in 0 until numHarmonics) {
                    sum += harmonicAmps[j] * gWeights[k + 2]
                    wSum += gWeights[k + 2]
                }
            }
            env[i] = sum / wSum
        }

        return peakPickFormants(env, f0, numHarmonics, pitchConfidence, vowelLikelihood)
    }

    /** Shared formant peak-picking; constraints/fallbacks per app.js:1616-1713. */
    private fun peakPickFormants(
        env: DoubleArray,
        f0: Double,
        numHarmonics: Int,
        pitchConfidence: Double,
        vowelLikelihood: Double,
    ): FormantResult {
        val minF1Hz = 200.0; val maxF1Hz = 1100.0
        val minF2Hz = 600.0; val maxF2Hz = 3500.0
        val minF3Hz = 2200.0; val maxF3Hz = 4200.0
        val minSepHz = 300.0

        data class Peak(val freq: Double, val amp: Double)

        val peaks = ArrayList<Peak>()
        for (i in 1 until numHarmonics - 1) {
            if (env[i] > env[i - 1] && env[i] > env[i + 1]) {
                val a = env[i - 1]; val b = env[i]; val c = env[i + 1]
                val denom = a - 2 * b + c
                var refinedIdx = i.toDouble()
                var refinedAmp = b
                if (abs(denom) > 0.001) {
                    val delta = 0.5 * (a - c) / denom
                    refinedIdx = i + max(-0.5, min(0.5, delta))
                    refinedAmp = b - (a - c) * (a - c) / (8 * denom)
                }
                // Harmonic index -> frequency: H(i+1) = f0 * (i+1)
                peaks.add(Peak(f0 * (refinedIdx + 1), refinedAmp))
            }
        }

        var f1 = 0.0; var f1Amp = Double.NEGATIVE_INFINITY
        var f2 = 0.0; var f2Amp = Double.NEGATIVE_INFINITY
        var f3 = 0.0; var f3Amp = Double.NEGATIVE_INFINITY
        var usedF1Fallback = false
        var usedF2Fallback = false

        for (p in peaks) {
            if (p.freq in minF1Hz..maxF1Hz && p.amp > f1Amp) {
                f1Amp = p.amp; f1 = p.freq
            }
        }
        val f2FloorHz = max(minF2Hz, f1 + minSepHz)
        for (p in peaks) {
            if (p.freq >= f2FloorHz && p.freq <= maxF2Hz && p.amp > f2Amp) {
                f2Amp = p.amp; f2 = p.freq
            }
        }
        val f3FloorHz = max(minF3Hz, f2 + minSepHz)
        for (p in peaks) {
            if (p.freq >= f3FloorHz && p.freq <= maxF3Hz && p.amp > f3Amp) {
                f3Amp = p.amp; f3 = p.freq
            }
        }

        // Fallbacks: band-energy centroid, marked as lower confidence
        if (f1 == 0.0) {
            usedF1Fallback = true
            var w = 0.0; var wS = 0.0
            for (i in 0 until numHarmonics) {
                val hFreq = f0 * (i + 1)
                if (hFreq in minF1Hz..maxF1Hz) {
                    val amp = 10.0.pow(env[i] / 20)
                    w += hFreq * amp; wS += amp
                }
            }
            f1 = if (wS > 0) w / wS else 500.0
        }
        if (f2 == 0.0) {
            usedF2Fallback = true
            var w = 0.0; var wS = 0.0
            for (i in 0 until numHarmonics) {
                val hFreq = f0 * (i + 1)
                if (hFreq >= f2FloorHz && hFreq <= maxF2Hz) {
                    val amp = 10.0.pow(env[i] / 20)
                    w += hFreq * amp; wS += amp
                }
            }
            f2 = if (wS > 0) w / wS else 1500.0
        }

        var envMin = 0.0
        var envRange = 0.0
        if (numHarmonics > 0) {
            envMin = env[0]
            var envMax = env[0]
            for (i in 1 until numHarmonics) {
                if (env[i] < envMin) envMin = env[i]
                if (env[i] > envMax) envMax = env[i]
            }
            envRange = envMax - envMin
        }
        var prominence = 0.0
        if (envRange > 0) {
            val f1P = if (usedF1Fallback) 0.2 else min(1.0, (f1Amp - envMin) / envRange)
            val f2P = if (usedF2Fallback) 0.2 else min(1.0, (f2Amp - envMin) / envRange)
            prominence = (f1P + f2P) / 2
        }
        val confidence = min(1.0, prominence * pitchConfidence * (vowelLikelihood + 0.3))

        return FormantResult(f1, f2, f3, confidence)
    }
}
