package com.prosodyball.dsp

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs

/**
 * Kotlin port of dsp-utils.test.mjs and voice-analyzer-core.test.mjs — the same
 * assertions the web app's CI runs against the JS implementation.
 */
class DspUtilsTest {

    @Test
    fun `computeRawProsody applies weighted sum`() {
        val got = computeRawProsody(bounce = 1.0, vowel = 0.5, articulation = 0.5)
        assertEquals(0.50 + 0.15 + 0.10, got, 1e-12)
    }

    @Test
    fun `computeProsodyScore smooths toward target`() {
        val score = computeProsodyScore(0.0, bounce = 1.0, vowel = 0.0, articulation = 0.0, smoothing = 0.2)
        assertTrue(abs(score - 0.10) < 1e-9)
    }

    @Test
    fun `pitchHzToPosition clamps to 0-1`() {
        assertEquals(0.0, pitchHzToPosition(80.0))
        assertEquals(1.0, pitchHzToPosition(300.0))
        assertEquals(0.5, pitchHzToPosition(190.0))
        assertEquals(0.0, pitchHzToPosition(30.0))
        assertEquals(1.0, pitchHzToPosition(500.0))
        assertEquals(0.0, pitchHzToPosition(Double.NaN))
    }

    @Test
    fun `clamp01 clamps values`() {
        assertEquals(0.0, clamp01(-1.0))
        assertEquals(0.25, clamp01(0.25))
        assertEquals(1.0, clamp01(5.0))
    }

    @Test
    fun `normalizeAgainstRange is bounded and monotonic`() {
        assertEquals(0.5, normalizeAgainstRange(5.0, 0.0, 10.0))
        assertEquals(0.0, normalizeAgainstRange(-10.0, 0.0, 10.0))
        assertEquals(1.0, normalizeAgainstRange(100.0, 0.0, 10.0))
    }

    @Test
    fun `normalizeAgainstPercentiles maps p50-p90 spread`() {
        assertEquals(0.0, normalizeAgainstPercentiles(0.2, 0.2, 0.6))
        assertEquals(1.0, normalizeAgainstPercentiles(0.6, 0.2, 0.6))
        assertTrue(normalizeAgainstPercentiles(0.4, 0.2, 0.6) > 0.49)
    }

    @Test
    fun `computeFrameReliability lowers confidence on weak signal and applies hysteresis`() {
        val weak = computeFrameReliability(
            pitchConfidence = 0.1, formantConfidence = 0.1,
            voicedStrength = 0.1, spectralTiltConfidence = 0.1,
        )
        val strong = computeFrameReliability(
            pitchConfidence = 0.9, formantConfidence = 0.7,
            voicedStrength = 0.8, spectralTiltConfidence = 0.8,
        )

        assertFalse(weak.reliableFrame)
        assertTrue(strong.reliableFrame)
        assertTrue(strong.confidenceGate > weak.confidenceGate)
        assertTrue(strong.voicedGate > weak.voicedGate)

        // Hysteresis: transitional frame turns ON only if already reliable
        val turnOnAttempt = computeFrameReliability(
            pitchConfidence = 0.30, formantConfidence = 0.35,
            voicedStrength = 0.20, wasLastFrameReliable = false,
        )
        assertFalse(turnOnAttempt.reliableFrame)

        val stayOnAttempt = computeFrameReliability(
            pitchConfidence = 0.30, formantConfidence = 0.35,
            voicedStrength = 0.20, wasLastFrameReliable = true,
        )
        assertTrue(stayOnAttempt.reliableFrame)
    }

    @Test
    fun `computeWeightTarget falls back to spectral tilt alone when other cues are absent`() {
        assertEquals(0.8, computeWeightTarget(tiltHeaviness = 0.8, tiltWeight = 0.55), 1e-12)
        assertEquals(0.2, computeWeightTarget(tiltHeaviness = 0.2, tiltWeight = 0.55), 1e-12)
    }

    @Test
    fun `computeWeightTarget reads pressed-heavy vs breathy-light voices in the right direction`() {
        val heavy = computeWeightTarget(
            tiltHeaviness = 0.85, tiltWeight = 0.55,
            h1h2Heaviness = 0.9, h1h2Weight = 0.30,
            f2Heaviness = 0.8, f2Weight = 0.15,
        )
        val light = computeWeightTarget(
            tiltHeaviness = 0.15, tiltWeight = 0.55,
            h1h2Heaviness = 0.1, h1h2Weight = 0.30,
            f2Heaviness = 0.2, f2Weight = 0.15,
        )
        assertTrue(heavy > 0.7, "expected heavy > 0.7, got $heavy")
        assertTrue(light < 0.3, "expected light < 0.3, got $light")
        assertTrue(heavy > light)
    }

    @Test
    fun `computeWeightTarget H1-H2 breathiness cue nudges weight when blended in`() {
        val withHeavyH1H2 = computeWeightTarget(
            tiltHeaviness = 0.5, tiltWeight = 0.55, h1h2Heaviness = 1.0, h1h2Weight = 0.30, f2Weight = 0.0,
        )
        val withLightH1H2 = computeWeightTarget(
            tiltHeaviness = 0.5, tiltWeight = 0.55, h1h2Heaviness = 0.0, h1h2Weight = 0.30, f2Weight = 0.0,
        )
        assertTrue(withHeavyH1H2 > 0.5, "pressed H1-H2 should pull weight heavier")
        assertTrue(withLightH1H2 < 0.5, "breathy H1-H2 should pull weight lighter")
        for (v in listOf(withHeavyH1H2, withLightH1H2)) assertTrue(v in 0.0..1.0)
    }

    @Test
    fun `computeAttackHardness separates a hard onset from a soft onset`() {
        val hard = computeAttackHardness(
            risePeak = 0.6, riseCeiling = 0.5, cleanliness = 1.0, onsetAbruptness = 1.0, abruptWeight = 0.3,
        )
        val soft = computeAttackHardness(
            risePeak = 0.05, riseCeiling = 0.5, cleanliness = 0.4, onsetAbruptness = 0.0, abruptWeight = 0.3,
        )
        assertTrue(hard > 0.8, "expected hard > 0.8, got $hard")
        assertTrue(soft < 0.2, "expected soft < 0.2, got $soft")
    }

    @Test
    fun `computeAttackHardness abruptness raises and breathiness lowers hardness`() {
        val abrupt = computeAttackHardness(
            risePeak = 0.25, riseCeiling = 0.5, cleanliness = 1.0, onsetAbruptness = 1.0, abruptWeight = 0.3,
        )
        val gradual = computeAttackHardness(
            risePeak = 0.25, riseCeiling = 0.5, cleanliness = 1.0, onsetAbruptness = 0.0, abruptWeight = 0.3,
        )
        assertTrue(abrupt > gradual, "an earlier rise peak should read harder")

        val clean = computeAttackHardness(risePeak = 0.6, riseCeiling = 0.5, cleanliness = 1.0)
        val breathy = computeAttackHardness(risePeak = 0.6, riseCeiling = 0.5, cleanliness = 0.0)
        assertTrue(clean > breathy, "a breathy onset should read softer")
        assertTrue(breathy >= 0.0 && clean <= 1.0)
    }

    @Test
    fun `weight and attack helpers stay finite and bounded with default inputs`() {
        for (v in listOf(computeWeightTarget(), computeAttackHardness())) {
            assertTrue(v.isFinite(), "expected finite, got $v")
            assertTrue(v in 0.0..1.0, "expected [0,1], got $v")
        }
    }

    @Test
    fun `percentile matches quickselect order statistics`() {
        val values = doubleArrayOf(5.0, 1.0, 4.0, 2.0, 3.0)
        assertEquals(3.0, percentile(values, 0.5))
        assertEquals(1.0, percentile(values, 0.0))
        assertEquals(5.0, percentile(values, 1.0))
        assertEquals(0.0, percentile(doubleArrayOf(), 0.5))
        // floor((n-1)*p) indexing, matching app.js:455
        assertEquals(4.0, percentile(values, 0.9))
    }
}
