// @generated from dsp-constants.json by tools/gen-dsp-constants.mjs — DO NOT EDIT.
// Edit the spec, then run `npm run gen:constants`. CI fails on drift (check:constants).

package com.voxarcade.wear

/** Cross-platform DSP constants generated from dsp-constants.json. */
object DspConstants {
    /** a-posteriori SNR at/above which readings are trusted freely (green tier). (dB) */
    const val SNR_GREEN_DB: Double = 20.0
    /** SNR below which trust collapses to the red tier; the green/yellow ramp spans yellow..green. (dB) */
    const val SNR_YELLOW_DB: Double = 10.0
    /** Low edge of the voice band SNR is measured over (excludes sub-300 Hz rumble). (Hz) */
    const val SNR_VOICE_BAND_LO_HZ: Int = 300
    /** High edge of the voice-band SNR window. (Hz) */
    const val SNR_VOICE_BAND_HI_HZ: Int = 3500
    /** Spectral over-subtraction factor in clean SNR (gentle; avoids musical noise). */
    const val OVERSUB_MIN: Double = 1.0
    /** Spectral over-subtraction factor at/below the red SNR edge (aggressive). */
    const val OVERSUB_MAX: Double = 2.5
    /** Per-pause EMA rate for re-tracking the per-bin noise profile. */
    const val NOISE_PROFILE_UPDATE_RATE: Double = 0.08
    /** Short-window pitch deviation (semitones) at which the steady-state weight's pitch term hits 0 (full glide/onset). Below it, frames count as held. (ST) */
    const val STEADY_PITCH_ST: Double = 1.5
    /** Combined frame-to-frame |dF1|/F1 + |dF2|/F2 at which the steady-state weight's formant term hits 0 (coarticulatory transition). */
    const val STEADY_FORMANT_REL_DELTA: Double = 0.25
    /** Lower bound of the steady-state weight so transition frames still nudge the live resonance estimate (down-weighted, not discarded). */
    const val STEADY_WEIGHT_FLOOR: Double = 0.3
    /** Confidence at/above which the resonance estimate updates (D4). */
    const val UPDATE_CONF_GATE: Double = 0.4
    /** Confidence at/above which directional feedback (haptic/UI) fires (D4); stricter than UPDATE_CONF_GATE. */
    const val ALERT_CONF_GATE: Double = 0.45
    /** YIN CMND threshold for pitch detection (lower = stricter). */
    const val YIN_THRESHOLD: Double = 0.15
    /** Maps YIN CMND to confidence: conf = 1 - cmnd * factor. Canonical = web's value; the C++ ports' 3.0 was drift, reconciled here (adopt on next C++ sync). */
    const val PITCH_CONFIDENCE_FACTOR: Double = 3.3
    /** LPC roots with bandwidth above this are rejected as non-formants. (Hz) */
    const val FORMANT_BW_REJECT_HZ: Int = 600
    /** Canonical tiltDb low-band low edge (D3: raw fixed band). (Hz) */
    const val TILT_LOW_LO_HZ: Int = 80
    /** Canonical tiltDb low-band high edge. (Hz) */
    const val TILT_LOW_HI_HZ: Int = 1200
    /** Canonical tiltDb high-band low edge. (Hz) */
    const val TILT_HIGH_LO_HZ: Int = 2500
    /** Canonical tiltDb high-band high edge. (Hz) */
    const val TILT_HIGH_HI_HZ: Int = 5000
    /** Spectral-centroid analysis band low edge. (Hz) */
    const val CENTROID_LO_HZ: Int = 120
    /** Spectral-centroid analysis band high edge. (Hz) */
    const val CENTROID_HI_HZ: Int = 5000
    /** Mic capture rate on the embedded/native ports. Web is browser-determined (often 48000) and intentionally omitted. (Hz) */
    const val CAPTURE_SAMPLE_RATE_HZ: Int = 16000
    /** LPC order for the formant envelope. Web derives it adaptively from the downsampled rate; the C++ ports use a harmonic envelope (no LPC) today, so both are omitted (D2). */
    const val LPC_ORDER: Int = 14
}
