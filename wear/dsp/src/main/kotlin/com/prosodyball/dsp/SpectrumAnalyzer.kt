package com.prosodyball.dsp

import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/**
 * Emulates the Web Audio AnalyserNode frequency path so the web analyzer's
 * tuned constants behave identically on watch:
 *
 *  1. Blackman window over the fftSize block (Web Audio spec section on AnalyserNode)
 *  2. FFT magnitude normalized by 1/N
 *  3. Per-call EMA across frames with [smoothingTimeConstant]
 *  4. Float data = dB of the smoothed magnitude
 *  5. Byte data maps dB through [minDecibels, maxDecibels] = [-100, -30] to 0..255
 *
 * The web app calls the analysers once per ~16ms animation frame; feed this class
 * at the same hop so smoothing constants port unchanged.
 */
class SpectrumAnalyzer(
    val fftSize: Int,
    private val smoothingTimeConstant: Double,
    private val minDecibels: Double = -100.0,
    private val maxDecibels: Double = -30.0,
) {
    val frequencyBinCount: Int = fftSize / 2

    private val fft = Fft(fftSize)
    private val window = DoubleArray(fftSize) { i ->
        // Blackman window, per the Web Audio spec (a = 0.16)
        0.42 - 0.5 * cos(2.0 * Math.PI * i / fftSize) + 0.08 * cos(4.0 * Math.PI * i / fftSize)
    }
    private val windowed = DoubleArray(fftSize)
    private val magnitudes = DoubleArray(frequencyBinCount)
    private val smoothed = DoubleArray(frequencyBinCount)
    private var hasSmoothed = false

    /** Processes one fftSize block of time-domain samples (the latest window). */
    fun process(timeDomain: FloatArray) {
        require(timeDomain.size >= fftSize)
        for (i in 0 until fftSize) windowed[i] = timeDomain[i] * window[i]
        fft.realMagnitudes(windowed, magnitudes)
        if (!hasSmoothed) {
            magnitudes.copyInto(smoothed)
            hasSmoothed = true
        } else {
            val tau = smoothingTimeConstant
            for (k in 0 until frequencyBinCount) {
                smoothed[k] = tau * smoothed[k] + (1 - tau) * magnitudes[k]
            }
        }
    }

    /** Equivalent of getFloatFrequencyData: dB of the smoothed magnitudes. */
    fun getFloatFrequencyData(out: FloatArray) {
        require(out.size >= frequencyBinCount)
        for (k in 0 until frequencyBinCount) {
            val mag = smoothed[k]
            out[k] = if (mag > 1e-40) (20.0 * log10(mag)).toFloat() else -800f
        }
    }

    /** Equivalent of getByteFrequencyData (values 0..255 in an IntArray). */
    fun getByteFrequencyData(out: IntArray) {
        require(out.size >= frequencyBinCount)
        val range = maxDecibels - minDecibels
        for (k in 0 until frequencyBinCount) {
            val mag = smoothed[k]
            val db = if (mag > 1e-40) 20.0 * log10(mag) else -800.0
            val scaled = floor(255.0 / range * (db - minDecibels))
            out[k] = min(255.0, max(0.0, scaled)).toInt()
        }
    }

    fun reset() {
        smoothed.fill(0.0)
        hasSmoothed = false
    }
}
