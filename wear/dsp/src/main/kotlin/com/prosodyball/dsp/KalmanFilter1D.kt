package com.prosodyball.dsp

/**
 * 1D constant-velocity Kalman filter for formant continuity, ported from
 * VoiceAnalyzer._kalmanUpdate (app.js:399-443). State is [frequency, velocity];
 * dt is fixed at one frame, matching the JS.
 */
class KalmanFilter1D {
    private var x0 = 0.0 // frequency
    private var x1 = 0.0 // velocity
    private var p00 = 10000.0
    private var p01 = 0.0
    private var p10 = 0.0
    private var p11 = 1000.0
    private val q00 = 100.0
    private val q11 = 10.0
    var initialized = false
        private set

    fun update(measurement: Double, measurementNoise: Double): Double {
        if (!initialized) {
            x0 = measurement
            x1 = 0.0
            p00 = 10000.0; p01 = 0.0; p10 = 0.0; p11 = 1000.0
            initialized = true
            return measurement
        }

        // Predict: x_pred = F x, P_pred = F P F^T + Q (dt = 1)
        val xPred0 = x0 + x1
        val xPred1 = x1
        val pp00 = p00 + p10 + (p01 + p11) + q00
        val pp01 = p01 + p11
        val pp10 = p10 + p11
        val pp11 = p11 + q11

        // Update with H = [1, 0]
        val y = measurement - xPred0
        val s = pp00 + measurementNoise
        val k0 = pp00 / s
        val k1 = pp10 / s

        x0 = xPred0 + k0 * y
        x1 = xPred1 + k1 * y
        p00 = (1 - k0) * pp00
        p01 = (1 - k0) * pp01
        p10 = -k1 * pp00 + pp10
        p11 = -k1 * pp01 + pp11

        return x0
    }

    fun reset() {
        initialized = false
        x0 = 0.0; x1 = 0.0
        p00 = 10000.0; p01 = 0.0; p10 = 0.0; p11 = 1000.0
    }
}
