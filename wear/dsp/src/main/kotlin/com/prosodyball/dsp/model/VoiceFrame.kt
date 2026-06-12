package com.prosodyball.dsp.model

/**
 * Per-frame analyzer output: normalized metrics plus raw values and the
 * confidence fields games/feedback must use to gate decisions
 * (see docs/ANALYZER_API.md "Confidence contract").
 */
data class VoiceFrame(
    val metrics: VoiceMetrics,
    /** Last detected fundamental (Hz); 0 while unvoiced. */
    val pitchHz: Double,
    /** Exponentially smoothed fundamental (Hz). */
    val smoothPitchHz: Double,
    val pitchConfidence: Double,
    val formantConfidence: Double,
    val spectralTiltConfidence: Double,
    /** Overall frame confidence for downstream gating. */
    val frameConfidence: Double,
    val reliableFrame: Boolean,
    /** Smoothed spectral tilt in dB (mic-baseline corrected). */
    val spectralTiltDb: Double,
    /** Smoothed H1-H2 in dB. */
    val h1h2Db: Double,
    val f1Hz: Double,
    val f2Hz: Double,
    val f3Hz: Double,
    /** Noise-gated RMS for this frame. */
    val gatedRms: Double,
    /** True once the noise-floor calibration window has completed. */
    val isCalibrated: Boolean,
    /** Tempo: syllable transitions per second over the tracker window. */
    val tempoRate: Double = 0.0,
    /** Coefficient of variation of inter-onset intervals (pacing variety). */
    val tempoVariance: Double = 0.0,
)
