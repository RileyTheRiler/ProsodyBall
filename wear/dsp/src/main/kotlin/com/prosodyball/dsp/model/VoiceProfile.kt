package com.prosodyball.dsp.model

/**
 * Learned per-user calibration state so a session can restore prior learning
 * instead of re-learning from scratch (web app re-learns every session;
 * on-watch we persist this via the app's ProfileStore).
 */
data class VoiceProfile(
    val pitchMinHz: Double = 80.0,
    val pitchMaxHz: Double = 380.0,
    val pitchLearned: Boolean = false,
    val tiltMinDb: Double = -34.0,
    val tiltMaxDb: Double = -4.0,
    val tiltLearned: Boolean = false,
    val noiseFloor: Double = 0.015,
    val hfNoiseFloor: Double = 0.0,
    val micTiltBaselineDb: Double = 0.0,
)
