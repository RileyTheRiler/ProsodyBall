package com.prosodyball.dsp

import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * IEC 61672 A-weighting gain table, ported from VoiceAnalyzer._aWeightTableFor /
 * _aWeightGain (app.js:374-397). The gain per bin depends only on the bin's
 * centre frequency, so it is precomputed once per (sampleRate, fftSize).
 */
class AWeighting(fftBinHz: Double, numBins: Int) {
    val gains = DoubleArray(numBins) { aWeightGain(it * fftBinHz) }

    companion object {
        fun aWeightGain(freqHz: Double): Double {
            if (freqHz < 20) return 0.01
            val f2 = freqHz * freqHz
            val f4 = f2 * f2
            val num = 12194.0 * 12194.0 * f4
            val den = (f2 + 20.6 * 20.6) *
                sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) *
                (f2 + 12194.0 * 12194.0)
            val ra = num / den
            val a = 20 * log10(ra) + 2.0
            return 10.0.pow(a / 10)
        }
    }
}
