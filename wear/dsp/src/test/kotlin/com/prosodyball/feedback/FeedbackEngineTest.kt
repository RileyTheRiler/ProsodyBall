package com.prosodyball.feedback

import com.prosodyball.dsp.model.VoiceFrame
import com.prosodyball.dsp.model.VoiceMetrics
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FeedbackEngineTest {

    private val dt = 0.016

    private fun frame(
        pitchHz: Double = 180.0,
        bounce: Double = 0.4,
        tempo: Double = 0.4,
        tempoVariance: Double = 0.5,
        syllable: Double = 0.4,
        energy: Double = 0.5,
        weight: Double = 0.5,
        resonance: Double = 0.5,
        confidence: Double = 0.8,
    ) = VoiceFrame(
        metrics = VoiceMetrics(
            bounce = bounce, tempo = tempo, vowel = 0.3, articulation = 0.4,
            syllable = syllable, pitch = 0.5, energy = energy, resonance = resonance,
            attack = 0.3, weight = weight,
        ),
        pitchHz = pitchHz,
        smoothPitchHz = pitchHz,
        pitchConfidence = confidence,
        formantConfidence = confidence,
        spectralTiltConfidence = confidence,
        frameConfidence = confidence,
        reliableFrame = confidence >= 0.35,
        spectralTiltDb = -14.0,
        h1h2Db = 6.0,
        f1Hz = 500.0, f2Hz = 1500.0, f3Hz = 2700.0,
        gatedRms = 0.05,
        isCalibrated = true,
        tempoRate = tempo * 6,
        tempoVariance = tempoVariance,
    )

    private fun run(engine: FeedbackEngine, frame: VoiceFrame, secs: Double): List<AlertType> {
        val all = ArrayList<AlertType>()
        var t = 0.0
        while (t < secs) {
            all += engine.onFrame(frame, dt)
            t += dt
        }
        return all
    }

    @Test
    fun `no alerts while metrics stay in band`() {
        val engine = FeedbackEngine(
            FeedbackConfig(pitchMinHz = 150.0, pitchMaxHz = 250.0, energyMin = 0.1, energyMax = 0.9),
        )
        val fired = run(engine, frame(pitchHz = 180.0), 30.0)
        assertTrue(fired.isEmpty(), "unexpected alerts: $fired")
    }

    @Test
    fun `sustained low pitch fires once then respects cooldown`() {
        val engine = FeedbackEngine(
            FeedbackConfig(pitchMinHz = 170.0, alertDelaySecs = 4.0, cooldownSecs = 30.0),
        )
        // Build rolling history in band, then drift low
        run(engine, frame(pitchHz = 180.0), 5.0)
        val fired = run(engine, frame(pitchHz = 140.0), 20.0)
        assertEquals(listOf(AlertType.PITCH_LOW), fired, "should fire exactly once within cooldown window")
    }

    @Test
    fun `drift must be sustained before the alert fires`() {
        val engine = FeedbackEngine(FeedbackConfig(pitchMinHz = 170.0, alertDelaySecs = 4.0))
        run(engine, frame(pitchHz = 180.0), 5.0)
        // 2s of drift < alertDelaySecs: nothing fires
        val fired = run(engine, frame(pitchHz = 140.0), 2.0)
        assertTrue(fired.isEmpty(), "alert fired before delay elapsed: $fired")
    }

    @Test
    fun `alert re-arms only after returning in band`() {
        val engine = FeedbackEngine(
            FeedbackConfig(pitchMinHz = 170.0, alertDelaySecs = 2.0, cooldownSecs = 5.0, rearmSecs = 3.0),
        )
        run(engine, frame(pitchHz = 180.0), 5.0)
        val first = run(engine, frame(pitchHz = 140.0), 10.0)
        assertEquals(1, first.size, "expected single fire under continuous drift, got $first")

        // Return in band long enough for the 4s rolling mean to recover AND the
        // re-arm timer to elapse, then drift again -> second fire
        run(engine, frame(pitchHz = 180.0), 10.0)
        val second = run(engine, frame(pitchHz = 140.0), 10.0)
        assertEquals(1, second.size, "expected re-armed alert to fire again, got $second")
    }

    @Test
    fun `silence never triggers alerts`() {
        val engine = FeedbackEngine(FeedbackConfig(pitchMinHz = 170.0, energyMin = 0.2))
        run(engine, frame(pitchHz = 180.0), 5.0)
        // Unvoiced, low-confidence frames (user stopped talking)
        val fired = run(engine, frame(pitchHz = 0.0, energy = 0.0, confidence = 0.1), 60.0)
        assertTrue(fired.isEmpty(), "silence triggered: $fired")
    }

    @Test
    fun `monotone speech raises MONOTONE`() {
        val engine = FeedbackEngine(FeedbackConfig(monotoneBounceFloor = 0.12, alertDelaySecs = 3.0))
        val flat = frame(bounce = 0.03, tempoVariance = 0.05)
        val fired = run(engine, flat, 15.0)
        assertTrue(AlertType.MONOTONE in fired, "flat speech should read monotone, got $fired")
    }

    @Test
    fun `expressive speech does not read monotone`() {
        val engine = FeedbackEngine(FeedbackConfig(monotoneBounceFloor = 0.12))
        val lively = frame(bounce = 0.5, tempoVariance = 0.6)
        val fired = run(engine, lively, 20.0)
        assertTrue(AlertType.MONOTONE !in fired)
    }

    @Test
    fun `loud and quiet drift raise volume alerts`() {
        val engine = FeedbackEngine(
            FeedbackConfig(energyMin = 0.2, energyMax = 0.8, alertDelaySecs = 3.0, cooldownSecs = 5.0, rearmSecs = 2.0),
        )
        run(engine, frame(energy = 0.5), 5.0)
        val loud = run(engine, frame(energy = 0.95), 10.0)
        assertTrue(AlertType.TOO_LOUD in loud, "expected TOO_LOUD, got $loud")

        run(engine, frame(energy = 0.5), 6.0)
        val quiet = run(engine, frame(energy = 0.05), 10.0)
        assertTrue(AlertType.TOO_QUIET in quiet, "expected TOO_QUIET, got $quiet")
    }

    @Test
    fun `weight and resonance bands raise their alerts`() {
        val engine = FeedbackEngine(
            FeedbackConfig(
                weightMin = 0.3, weightMax = 0.7, resonanceMin = 0.3, resonanceMax = 0.7,
                alertDelaySecs = 3.0,
            ),
        )
        run(engine, frame(), 5.0)
        val heavyDark = run(engine, frame(weight = 0.95, resonance = 0.05), 10.0)
        assertTrue(AlertType.TOO_HEAVY in heavyDark, "expected TOO_HEAVY, got $heavyDark")
        assertTrue(AlertType.RESONANCE_DARK in heavyDark, "expected RESONANCE_DARK, got $heavyDark")
    }

    @Test
    fun `disabled bands never fire`() {
        val engine = FeedbackEngine(FeedbackConfig(monotoneBounceFloor = null))
        val fired = run(engine, frame(pitchHz = 60.0, bounce = 0.0, energy = 0.99, tempoVariance = 0.0), 30.0)
        assertTrue(fired.isEmpty(), "default config should monitor nothing, got $fired")
    }
}
