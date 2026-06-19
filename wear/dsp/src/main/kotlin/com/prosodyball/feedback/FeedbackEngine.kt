package com.prosodyball.feedback

import com.prosodyball.dsp.model.VoiceFrame

/**
 * Coaching alerts the watch can raise. Each maps to a distinct haptic pattern
 * and spoken/tone cue in the app layer.
 */
enum class AlertType {
    PITCH_LOW,
    PITCH_HIGH,
    MONOTONE,
    TOO_FAST,
    MUSHY,
    TOO_LOUD,
    TOO_QUIET,
    TOO_HEAVY,
    TOO_LIGHT,
    RESONANCE_DARK,
    RESONANCE_BRIGHT,
}

/**
 * Target bands and timing. Pitch targets are in Hz (compared against the
 * frame's smoothed pitch); everything else is in normalized [0,1] metric space.
 * A null bound disables that side of the band.
 */
data class FeedbackConfig(
    val pitchMinHz: Double? = null,
    val pitchMaxHz: Double? = null,
    /** Expressiveness floor: rolling bounce below this (with flat pacing) = MONOTONE. */
    val monotoneBounceFloor: Double? = 0.12,
    /** Tempo ceiling [0,1]; rolling tempo above this with weak syllables = TOO_FAST/MUSHY. */
    val tempoCeiling: Double? = null,
    /** Energy band vs the calibrated baseline. */
    val energyMin: Double? = null,
    val energyMax: Double? = null,
    /** Weight band (0 = light, 1 = heavy). */
    val weightMin: Double? = null,
    val weightMax: Double? = null,
    /** Resonance band (0 = dark, 1 = bright). */
    val resonanceMin: Double? = null,
    val resonanceMax: Double? = null,
    /** Only frames at/above this confidence feed the rolling means. */
    val minFrameConfidence: Double = 0.35,
    /** Drift must persist this long before an alert fires. */
    val alertDelaySecs: Double = 4.0,
    /** Per-alert cooldown after firing. */
    val cooldownSecs: Double = 30.0,
    /** Metric must sit back in band this long before the alert can re-arm. */
    val rearmSecs: Double = 5.0,
    /** Rolling-mean time constant for drift evaluation. */
    val rollingSecs: Double = 4.0,
    /** Deadband added outside the target bounds before drift counts. */
    val deadband: Double = 0.05,
)

/**
 * Pure drift-detection state machine: feeds per-frame analyzer output into
 * per-metric rolling means (reliable frames only) and raises an alert when a
 * metric stays out of its target band, with hysteresis and cooldowns so the
 * wrist isn't buzzing constantly. Android-free so it is JVM-unit-testable.
 */
class FeedbackEngine(@Volatile var config: FeedbackConfig = FeedbackConfig()) {

    private class AlertState {
        var driftTime = 0.0
        var inBandTime = 0.0
        var cooldownRemaining = 0.0
        var armed = true
    }

    private val states = AlertType.entries.associateWith { AlertState() }

    // Rolling means (EMA over rollingSecs) of the monitored quantities
    private var rollingPitchHz = Double.NaN
    private var rollingBounce = Double.NaN
    private var rollingTempo = Double.NaN
    private var rollingTempoVariance = Double.NaN
    private var rollingSyllable = Double.NaN
    private var rollingEnergy = Double.NaN
    private var rollingWeight = Double.NaN
    private var rollingResonance = Double.NaN
    private var voicedTime = 0.0

    /** Most recent rolling pitch for UI display. */
    val currentPitchHz: Double get() = if (rollingPitchHz.isNaN()) 0.0 else rollingPitchHz

    /**
     * Processes one analyzer frame. Returns alerts that fired this frame
     * (usually empty; at most a few per minute by construction).
     */
    fun onFrame(frame: VoiceFrame, dt: Double): List<AlertType> {
        val cfg = config
        for (state in states.values) {
            if (state.cooldownRemaining > 0) {
                state.cooldownRemaining = (state.cooldownRemaining - dt).coerceAtLeast(0.0)
            }
        }

        val reliable = frame.isCalibrated && frame.frameConfidence >= cfg.minFrameConfidence
        if (reliable && frame.pitchHz > 0) {
            val alpha = (dt / cfg.rollingSecs).coerceIn(0.0, 1.0)
            rollingPitchHz = ema(rollingPitchHz, frame.smoothPitchHz, alpha)
            rollingBounce = ema(rollingBounce, frame.metrics.bounce, alpha)
            rollingTempo = ema(rollingTempo, frame.metrics.tempo, alpha)
            rollingTempoVariance = ema(rollingTempoVariance, frame.tempoVariance, alpha)
            rollingSyllable = ema(rollingSyllable, frame.metrics.syllable, alpha)
            rollingEnergy = ema(rollingEnergy, frame.metrics.energy, alpha)
            rollingWeight = ema(rollingWeight, frame.metrics.weight, alpha)
            rollingResonance = ema(rollingResonance, frame.metrics.resonance, alpha)
            voicedTime += dt
        } else if (!reliable) {
            // Silence/unreliable: drift timers decay rather than accumulate, so a
            // pause in speaking never triggers a stale alert.
            for (state in states.values) {
                state.driftTime = (state.driftTime - dt * 0.5).coerceAtLeast(0.0)
            }
            return emptyList()
        }

        // Need some voiced history before judging anything
        if (voicedTime < cfg.rollingSecs) return emptyList()

        val fired = ArrayList<AlertType>(2)

        fun evaluate(type: AlertType, drifting: Boolean) {
            val state = states.getValue(type)
            if (drifting) {
                state.inBandTime = 0.0
                state.driftTime += dt
                if (state.armed && state.cooldownRemaining <= 0 && state.driftTime >= cfg.alertDelaySecs) {
                    fired.add(type)
                    state.armed = false
                    state.cooldownRemaining = cfg.cooldownSecs
                    state.driftTime = 0.0
                }
            } else {
                state.driftTime = (state.driftTime - dt).coerceAtLeast(0.0)
                state.inBandTime += dt
                if (!state.armed && state.inBandTime >= cfg.rearmSecs) {
                    state.armed = true
                }
            }
        }

        // Pitch band (Hz, deadband scaled to a few semitones' worth of Hz)
        val pitchDeadbandHz = 5.0
        cfg.pitchMinHz?.let { evaluate(AlertType.PITCH_LOW, rollingPitchHz < it - pitchDeadbandHz) }
        cfg.pitchMaxHz?.let { evaluate(AlertType.PITCH_HIGH, rollingPitchHz > it + pitchDeadbandHz) }

        // Monotone: flat pitch AND flat pacing variety
        cfg.monotoneBounceFloor?.let {
            evaluate(AlertType.MONOTONE, rollingBounce < it && rollingTempoVariance < 0.2)
        }

        // Pacing: rushed tempo, optionally with mushy (weak) syllable separation
        cfg.tempoCeiling?.let { ceiling ->
            val fast = rollingTempo > ceiling + cfg.deadband
            evaluate(AlertType.TOO_FAST, fast && rollingSyllable >= 0.15)
            evaluate(AlertType.MUSHY, fast && rollingSyllable < 0.15)
        }

        cfg.energyMax?.let { evaluate(AlertType.TOO_LOUD, rollingEnergy > it + cfg.deadband) }
        cfg.energyMin?.let { evaluate(AlertType.TOO_QUIET, rollingEnergy < it - cfg.deadband) }
        cfg.weightMax?.let { evaluate(AlertType.TOO_HEAVY, rollingWeight > it + cfg.deadband) }
        cfg.weightMin?.let { evaluate(AlertType.TOO_LIGHT, rollingWeight < it - cfg.deadband) }
        cfg.resonanceMin?.let { evaluate(AlertType.RESONANCE_DARK, rollingResonance < it - cfg.deadband) }
        cfg.resonanceMax?.let { evaluate(AlertType.RESONANCE_BRIGHT, rollingResonance > it + cfg.deadband) }

        return fired
    }

    fun reset() {
        for (state in states.values) {
            state.driftTime = 0.0
            state.inBandTime = 0.0
            state.cooldownRemaining = 0.0
            state.armed = true
        }
        rollingPitchHz = Double.NaN
        rollingBounce = Double.NaN
        rollingTempo = Double.NaN
        rollingTempoVariance = Double.NaN
        rollingSyllable = Double.NaN
        rollingEnergy = Double.NaN
        rollingWeight = Double.NaN
        rollingResonance = Double.NaN
        voicedTime = 0.0
    }

    private fun ema(prev: Double, value: Double, alpha: Double): Double =
        if (prev.isNaN()) value else prev + (value - prev) * alpha
}
