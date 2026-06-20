package com.voxarcade.wear

import kotlin.math.cos
import kotlin.math.sin

/**
 * Minimal in-place radix-2 iterative FFT for power-of-two sizes. Used to compute
 * a spectral centroid (a "brightness" / resonance proxy) for the voice analyzer.
 */
class Fft(private val n: Int) {

    private val cosT = FloatArray(n / 2)
    private val sinT = FloatArray(n / 2)

    init {
        require(n > 0 && (n and (n - 1)) == 0) { "n must be a power of two" }
        for (i in 0 until n / 2) {
            val ang = -2.0 * Math.PI * i / n
            cosT[i] = cos(ang).toFloat()
            sinT[i] = sin(ang).toFloat()
        }
    }

    /** In-place forward FFT of the complex signal held in [re] / [im]. */
    fun transform(re: FloatArray, im: FloatArray) {
        // Bit-reversal permutation.
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j or bit
            if (i < j) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        // Butterflies.
        var len = 2
        while (len <= n) {
            val half = len shr 1
            val step = n / len
            var i = 0
            while (i < n) {
                var k = 0
                for (p in 0 until half) {
                    val c = cosT[k]
                    val s = sinT[k]
                    val ar = re[i + p]
                    val ai = im[i + p]
                    val br = re[i + p + half]
                    val bi = im[i + p + half]
                    val vr = br * c - bi * s
                    val vi = br * s + bi * c
                    re[i + p] = ar + vr
                    im[i + p] = ai + vi
                    re[i + p + half] = ar - vr
                    im[i + p + half] = ai - vi
                    k += step
                }
                i += len
            }
            len = len shl 1
        }
    }
}
