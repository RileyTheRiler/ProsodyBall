// @generated from dsp-constants.json by tools/gen-dsp-constants.mjs — DO NOT EDIT.
// Edit the spec, then run `npm run gen:constants`. CI fails on drift (check:constants).

// a-posteriori SNR at/above which readings are trusted freely (green tier). (dB)
export const SNR_GREEN_DB = 20.0;
// SNR below which trust collapses to the red tier; the green/yellow ramp spans yellow..green. (dB)
export const SNR_YELLOW_DB = 10.0;
// Low edge of the voice band SNR is measured over (excludes sub-300 Hz rumble). (Hz)
export const SNR_VOICE_BAND_LO_HZ = 300;
// High edge of the voice-band SNR window. (Hz)
export const SNR_VOICE_BAND_HI_HZ = 3500;
// Spectral over-subtraction factor in clean SNR (gentle; avoids musical noise).
export const OVERSUB_MIN = 1.0;
// Spectral over-subtraction factor at/below the red SNR edge (aggressive).
export const OVERSUB_MAX = 2.5;
// Per-pause EMA rate for re-tracking the per-bin noise profile.
export const NOISE_PROFILE_UPDATE_RATE = 0.08;
// Confidence at/above which the resonance estimate updates (D4).
export const UPDATE_CONF_GATE = 0.4;
// Confidence at/above which directional feedback (haptic/UI) fires (D4); stricter than UPDATE_CONF_GATE.
export const ALERT_CONF_GATE = 0.45;
// YIN CMND threshold for pitch detection (lower = stricter).
export const YIN_THRESHOLD = 0.15;
// LPC roots with bandwidth above this are rejected as non-formants. (Hz)
export const FORMANT_BW_REJECT_HZ = 600;
// Canonical tiltDb low-band low edge (D3: raw fixed band). (Hz)
export const TILT_LOW_LO_HZ = 80;
// Canonical tiltDb low-band high edge. (Hz)
export const TILT_LOW_HI_HZ = 1200;
// Canonical tiltDb high-band low edge. (Hz)
export const TILT_HIGH_LO_HZ = 2500;
// Canonical tiltDb high-band high edge. (Hz)
export const TILT_HIGH_HI_HZ = 5000;
// Spectral-centroid analysis band low edge. (Hz)
export const CENTROID_LO_HZ = 120;
// Spectral-centroid analysis band high edge. (Hz)
export const CENTROID_HI_HZ = 5000;
