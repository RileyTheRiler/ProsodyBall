package com.prosodyball.dsp

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

class SpectrumAnalyzerTest {

    private val sampleRate = 16000.0
    private val fftSize = 2048
    private val binHz = sampleRate / fftSize

    private fun tone(freqHz: Double, amplitude: Float = 0.5f): FloatArray =
        FloatArray(fftSize) { i -> (amplitude * sin(2 * PI * freqHz * i / sampleRate)).toFloat() }

    @Test
    fun `peak appears at the tone's bin`() {
        val analyzer = SpectrumAnalyzer(fftSize, smoothingTimeConstant = 0.0)
        val targetBin = 64 // exactly bin-centred tone -> no spectral leakage ambiguity
        analyzer.process(tone(targetBin * binHz))

        val out = FloatArray(fftSize / 2)
        analyzer.getFloatFrequencyData(out)
        var peakBin = 0
        for (k in out.indices) if (out[k] > out[peakBin]) peakBin = k
        assertEquals(targetBin, peakBin)
    }

    @Test
    fun `smoothing EMA follows Web Audio semantics`() {
        // tau=0.8: smoothed = 0.8*prev + 0.2*current
        val analyzer = SpectrumAnalyzer(fftSize, smoothingTimeConstant = 0.8)
        val signal = tone(64 * binHz)
        val silence = FloatArray(fftSize)

        analyzer.process(signal)
        val first = FloatArray(fftSize / 2)
        analyzer.getFloatFrequencyData(first)
        val peakDbWithSignal = first[64]

        // After one silent frame the magnitude should drop to 0.8x = -1.94 dB
        analyzer.process(silence)
        val second = FloatArray(fftSize / 2)
        analyzer.getFloatFrequencyData(second)
        val expectedDrop = 20 * kotlin.math.log10(0.8)
        assertTrue(
            abs((second[64] - peakDbWithSignal) - expectedDrop) < 0.1,
            "expected ${expectedDrop} dB drop, got ${second[64] - peakDbWithSignal}",
        )
    }

    @Test
    fun `byte data maps dB through minus100 to minus30 range`() {
        val analyzer = SpectrumAnalyzer(fftSize, smoothingTimeConstant = 0.0)
        analyzer.process(tone(64 * binHz, amplitude = 0.5f))

        val floatData = FloatArray(fftSize / 2)
        val byteData = IntArray(fftSize / 2)
        analyzer.getFloatFrequencyData(floatData)
        analyzer.getByteFrequencyData(byteData)

        for (k in floatData.indices) {
            val db = floatData[k].toDouble()
            val expected = when {
                db <= -100 -> 0
                db >= -30 -> 255
                else -> kotlin.math.floor(255.0 / 70.0 * (db + 100)).toInt()
            }
            assertEquals(expected, byteData[k], "bin $k: db=$db")
        }
        // Silence bins are 0, the strong tone bin saturates high
        assertTrue(byteData[64] > 200, "tone bin should be near saturation, got ${byteData[64]}")
        assertEquals(0, byteData[300])
    }

    @Test
    fun `magnitude normalization matches AnalyserNode scale`() {
        // A full-scale sine has FFT magnitude amplitude/2 after 1/N normalization;
        // the Blackman window's coherent gain is ~0.42, so the peak bin of a
        // 0.5-amplitude tone lands near 20*log10(0.5 * 0.42 / 2) ~= -19.6 dB.
        val analyzer = SpectrumAnalyzer(fftSize, smoothingTimeConstant = 0.0)
        analyzer.process(tone(64 * binHz, amplitude = 0.5f))
        val out = FloatArray(fftSize / 2)
        analyzer.getFloatFrequencyData(out)
        val expectedDb = 20 * kotlin.math.log10(0.5 * 0.42 / 2)
        assertTrue(abs(out[64] - expectedDb) < 1.0, "expected ~$expectedDb dB, got ${out[64]}")
    }
}
