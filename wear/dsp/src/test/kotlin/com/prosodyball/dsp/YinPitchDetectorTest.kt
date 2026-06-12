package com.prosodyball.dsp

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

class YinPitchDetectorTest {

    private val sampleRate = 16000.0
    private val bufSize = 2048

    private fun sawtooth(freqHz: Double, amplitude: Float = 0.3f): FloatArray {
        val buf = FloatArray(bufSize)
        val period = sampleRate / freqHz
        for (i in 0 until bufSize) {
            val phase = (i % period) / period
            buf[i] = ((2 * phase - 1) * amplitude).toFloat()
        }
        return buf
    }

    private fun sine(freqHz: Double, amplitude: Float = 0.3f): FloatArray {
        val buf = FloatArray(bufSize)
        for (i in 0 until bufSize) {
            buf[i] = (amplitude * sin(2 * PI * freqHz * i / sampleRate)).toFloat()
        }
        return buf
    }

    private fun detectStable(detector: YinPitchDetector, buf: FloatArray): Double {
        // Run several frames so the 5-tap median filter settles
        var hz = 0.0
        repeat(5) {
            hz = detector.detectPitch(
                buf, bufSize, precomputedRms = Double.NaN, silenceThreshold = 0.015,
                profileMinHz = 80.0, profileMaxHz = 500.0,
            )
        }
        return hz
    }

    // The detector carries a ~1-2% bias from parabolic interpolation over the
    // CMND (verified identical in the JS source this is ported from), so
    // accuracy assertions use a 2.5% relative tolerance — fidelity to the web
    // analyzer matters more here than absolute accuracy.

    @Test
    fun `detects sawtooth fundamentals within tolerance`() {
        for (freq in listOf(110.0, 220.0, 440.0)) {
            val detector = YinPitchDetector(sampleRate)
            val hz = detectStable(detector, sawtooth(freq))
            assertTrue(abs(hz - freq) < freq * 0.025, "expected ~$freq Hz, got $hz")
            assertTrue(detector.pitchConfidence > 0.7, "expected high confidence at $freq Hz, got ${detector.pitchConfidence}")
        }
    }

    @Test
    fun `detects pure sine fundamentals`() {
        for (freq in listOf(150.0, 300.0)) {
            val detector = YinPitchDetector(sampleRate)
            val hz = detectStable(detector, sine(freq))
            assertTrue(abs(hz - freq) < freq * 0.025, "expected ~$freq Hz, got $hz")
        }
    }

    @Test
    fun `returns zero for silence`() {
        val detector = YinPitchDetector(sampleRate)
        val silent = FloatArray(bufSize)
        assertEquals(
            0.0,
            detector.detectPitch(silent, bufSize, Double.NaN, 0.015, 80.0, 380.0),
        )
    }

    @Test
    fun `returns zero for white noise`() {
        val detector = YinPitchDetector(sampleRate)
        val rng = java.util.Random(42)
        val noise = FloatArray(bufSize) { (rng.nextFloat() - 0.5f) * 0.4f }
        val hz = detector.detectPitch(noise, bufSize, Double.NaN, 0.015, 80.0, 380.0)
        // Unvoiced noise should be rejected outright or flagged as very low confidence
        assertTrue(hz == 0.0 || detector.pitchConfidence < 0.3, "noise read as confident pitch: $hz @ ${detector.pitchConfidence}")
    }

    @Test
    fun `median filter suppresses a single octave jump`() {
        val detector = YinPitchDetector(sampleRate)
        val base = sawtooth(165.0)
        repeat(4) { detectStable(detector, base) }
        // One frame at the octave should be outvoted by the median buffer
        val octave = sawtooth(330.0)
        val hz = detector.detectPitch(octave, bufSize, Double.NaN, 0.015, 80.0, 500.0)
        assertTrue(abs(hz - 165.0) < 165.0 * 0.03, "octave jump leaked through median filter: $hz")
    }

    @Test
    fun `respects adaptive profile bounds`() {
        val detector = YinPitchDetector(sampleRate)
        // 70 Hz tone with a profile floor of 120 Hz: safeMin = 102 Hz, so the
        // true fundamental is out of bounds and must not be reported as 70 Hz
        val hz = detectStable(detector, sawtooth(70.0))
        // With default bounds it would find it; here use tight bounds
        val detector2 = YinPitchDetector(sampleRate)
        var bounded = 0.0
        repeat(5) {
            bounded = detector2.detectPitch(sawtooth(70.0), bufSize, Double.NaN, 0.015, 120.0, 380.0)
        }
        assertTrue(abs(hz - 70.0) < 70.0 * 0.025, "wide bounds should find 70 Hz, got $hz")
        assertTrue(bounded == 0.0 || bounded > 100.0, "tight bounds must not report 70 Hz, got $bounded")
    }
}
