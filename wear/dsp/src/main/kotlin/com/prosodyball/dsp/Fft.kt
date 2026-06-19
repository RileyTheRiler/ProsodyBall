package com.prosodyball.dsp

import kotlin.math.cos
import kotlin.math.sin

/**
 * In-place iterative radix-2 FFT for real input, used by [SpectrumAnalyzer].
 * Size must be a power of two.
 */
class Fft(val size: Int) {
    init {
        require(size > 1 && (size and (size - 1)) == 0) { "FFT size must be a power of two, got $size" }
    }

    private val cosTable = DoubleArray(size / 2) { cos(2.0 * Math.PI * it / size) }
    private val sinTable = DoubleArray(size / 2) { sin(2.0 * Math.PI * it / size) }
    private val re = DoubleArray(size)
    private val im = DoubleArray(size)

    /**
     * Computes magnitudes |X[k]| / size for k in 0 until size/2 into [outMagnitudes],
     * matching the Web Audio AnalyserNode normalization (spec: X[k] scaled by 1/N).
     */
    fun realMagnitudes(input: DoubleArray, outMagnitudes: DoubleArray) {
        require(input.size >= size && outMagnitudes.size >= size / 2)
        input.copyInto(re, 0, 0, size)
        im.fill(0.0)
        transform()
        for (k in 0 until size / 2) {
            outMagnitudes[k] = Math.hypot(re[k], im[k]) / size
        }
    }

    private fun transform() {
        val n = size
        val levels = Integer.numberOfTrailingZeros(n)
        // Bit-reversal permutation
        for (i in 0 until n) {
            val j = Integer.reverse(i) ushr (32 - levels)
            if (j > i) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        // Cooley-Tukey butterflies
        var sizeStep = 2
        while (sizeStep <= n) {
            val halfSize = sizeStep / 2
            val tableStep = n / sizeStep
            var i = 0
            while (i < n) {
                var j = i
                var k = 0
                while (j < i + halfSize) {
                    val l = j + halfSize
                    val tpre = re[l] * cosTable[k] + im[l] * sinTable[k]
                    val tpim = -re[l] * sinTable[k] + im[l] * cosTable[k]
                    re[l] = re[j] - tpre
                    im[l] = im[j] - tpim
                    re[j] += tpre
                    im[j] += tpim
                    j++
                    k += tableStep
                }
                i += sizeStep
            }
            sizeStep *= 2
        }
    }
}
