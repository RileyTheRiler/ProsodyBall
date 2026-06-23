// @generated from dsp-constants.json by tools/gen-dsp-constants.mjs — DO NOT EDIT.
// Edit the spec, then run `npm run gen:constants`. CI fails on drift (check:constants).

#pragma once

// Cross-platform DSP constants generated from dsp-constants.json.
namespace dsp_constants {
  // a-posteriori SNR at/above which readings are trusted freely (green tier). (dB)
  constexpr float SNR_GREEN_DB = 20.0f;
  // SNR below which trust collapses to the red tier; the green/yellow ramp spans yellow..green. (dB)
  constexpr float SNR_YELLOW_DB = 10.0f;
  // Low edge of the voice band SNR is measured over (excludes sub-300 Hz rumble). (Hz)
  constexpr int SNR_VOICE_BAND_LO_HZ = 300;
  // High edge of the voice-band SNR window. (Hz)
  constexpr int SNR_VOICE_BAND_HI_HZ = 3500;
  // Spectral over-subtraction factor in clean SNR (gentle; avoids musical noise).
  constexpr float OVERSUB_MIN = 1.0f;
  // Spectral over-subtraction factor at/below the red SNR edge (aggressive).
  constexpr float OVERSUB_MAX = 2.5f;
  // Per-pause EMA rate for re-tracking the per-bin noise profile.
  constexpr float NOISE_PROFILE_UPDATE_RATE = 0.08f;
  // Confidence at/above which the resonance estimate updates (D4).
  constexpr float UPDATE_CONF_GATE = 0.4f;
  // Confidence at/above which directional feedback (haptic/UI) fires (D4); stricter than UPDATE_CONF_GATE.
  constexpr float ALERT_CONF_GATE = 0.45f;
  // YIN CMND threshold for pitch detection (lower = stricter).
  constexpr float YIN_THRESHOLD = 0.15f;
  // LPC roots with bandwidth above this are rejected as non-formants. (Hz)
  constexpr int FORMANT_BW_REJECT_HZ = 600;
  // Canonical tiltDb low-band low edge (D3: raw fixed band). (Hz)
  constexpr int TILT_LOW_LO_HZ = 80;
  // Canonical tiltDb low-band high edge. (Hz)
  constexpr int TILT_LOW_HI_HZ = 1200;
  // Canonical tiltDb high-band low edge. (Hz)
  constexpr int TILT_HIGH_LO_HZ = 2500;
  // Canonical tiltDb high-band high edge. (Hz)
  constexpr int TILT_HIGH_HI_HZ = 5000;
  // Spectral-centroid analysis band low edge. (Hz)
  constexpr int CENTROID_LO_HZ = 120;
  // Spectral-centroid analysis band high edge. (Hz)
  constexpr int CENTROID_HI_HZ = 5000;
  // Mic capture rate on the embedded/native ports. Web is browser-determined (often 48000) and intentionally omitted. (Hz)
  constexpr int CAPTURE_SAMPLE_RATE_HZ = 16000;
}  // namespace dsp_constants
