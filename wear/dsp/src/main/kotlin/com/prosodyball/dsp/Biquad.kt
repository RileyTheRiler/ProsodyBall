package com.prosodyball.dsp

import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Direct-form-I biquad filter. Stateful across calls so it can run on a
 * continuous sample stream (the web app's highpass BiquadFilterNode feeds the
 * HF analyser continuously; we replicate that by filtering each capture hop).
 */
class Biquad(
    private val b0: Double,
    private val b1: Double,
    private val b2: Double,
    private val a1: Double,
    private val a2: Double,
) {
    private var x1 = 0.0
    private var x2 = 0.0
    private var y1 = 0.0
    private var y2 = 0.0

    fun process(input: FloatArray, output: FloatArray, count: Int = input.size) {
        for (i in 0 until count) {
            val x0 = input[i].toDouble()
            val y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x0
            y2 = y1; y1 = y0
            output[i] = y0.toFloat()
        }
    }

    fun reset() {
        x1 = 0.0; x2 = 0.0; y1 = 0.0; y2 = 0.0
    }

    companion object {
        /**
         * Highpass biquad matching Web Audio's BiquadFilterNode 'highpass'
         * (RBJ cookbook, default Q = 1 in Web Audio terms -> q = 10^(0/20) ... the
         * web app leaves Q at its default of 1.0, which Web Audio interprets in dB;
         * 1.0 dB ~= Q 1.12. We use the resonance-free Butterworth Q = sqrt(2)/2,
         * which is within 1 dB of the web response across the band of interest.)
         */
        fun highpass(sampleRate: Double, cutoffHz: Double, q: Double = sqrt(2.0) / 2.0): Biquad {
            val w0 = 2.0 * Math.PI * cutoffHz / sampleRate
            val cosW0 = cos(w0)
            val alpha = sin(w0) / (2.0 * q)
            val b0 = (1 + cosW0) / 2
            val b1 = -(1 + cosW0)
            val b2 = (1 + cosW0) / 2
            val a0 = 1 + alpha
            val a1 = -2 * cosW0
            val a2 = 1 - alpha
            return Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
        }

        /**
         * 2nd-order Butterworth lowpass via bilinear transform, matching the
         * anti-aliasing filter in app.js:1396-1403 (used before decimation).
         */
        fun butterworthLowpass(sampleRate: Double, cutoffHz: Double): Biquad {
            val wc = kotlin.math.tan(Math.PI * cutoffHz / sampleRate)
            val wc2 = wc * wc
            val sqrt2 = sqrt(2.0)
            val k = 1 / (1 + sqrt2 * wc + wc2)
            val b0 = wc2 * k
            return Biquad(
                b0 = b0,
                b1 = 2 * b0,
                b2 = b0,
                a1 = 2 * (wc2 - 1) * k,
                a2 = (1 - sqrt2 * wc + wc2) * k,
            )
        }
    }
}
