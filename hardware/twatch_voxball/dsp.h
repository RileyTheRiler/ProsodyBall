// VoxBall on-device DSP — a faithful C++ port of the prosody analysis the web app
// (app.js / dsp-utils.js) runs in the browser. Only the cues the standalone Vox Ball
// needs are ported: RMS energy, YIN pitch, the intonation "bounce" metric, and syllable
// onset. Constants are named identically to the JS so the two stay in sync.
//
// Pure, hardware-agnostic: feed it mono float frames in [-1, 1]; it knows nothing about
// I2S, the display, or Arduino. That keeps it unit-reasoned and reusable.
#pragma once

#include <stdint.h>
#include <stddef.h>

// ---- Frame / sample configuration ----
#define VOX_SAMPLE_RATE   16000  // PDM mic capture rate (Hz)
#define VOX_FRAME_SAMPLES 1024   // samples per analysis frame (~64 ms @ 16 kHz)

// ---- Constants ported 1:1 from the web app ----
#define YIN_THRESHOLD            0.15f  // CMND threshold for pitch detection (app.js:20)
#define PITCH_CONFIDENCE_FACTOR  3.0f   // CMND -> confidence scaling (app.js detectPitch)
#define INTONATION_ST_DIVISOR    6.0f   // semitone std-dev -> [0,1] bounce (app.js:22)
#define SYLLABLE_DEBOUNCE_SECS   0.08f  // min seconds between syllable onsets (app.js:32)
#define SYLLABLE_ON_MULT         0.6f   // energy-range mult for syllable-on (app.js:33)
#define SYLLABLE_OFF_MULT        0.15f  // energy-range mult for syllable-off (app.js:34)
#define SYLLABLE_IMPULSE_DECAY   0.88f  // per-frame decay of syllable impulse (app.js:35)

// ---- Voice pitch band (Hz) — bounds the YIN period search to keep it cheap ----
#define VOX_PITCH_MIN_HZ  80.0f
#define VOX_PITCH_MAX_HZ  300.0f

// Per-frame analysis result.
struct VoxResult {
  float rms;             // raw RMS energy of the frame (0..~1)
  float pitchHz;         // detected fundamental, 0 if silent/unvoiced
  float pitchPos;        // pitchHzToPosition(pitchHz, 80, 300) -> 0..1
  float bounce;          // intonation variability 0..1
  float syllableImpulse; // 0..1, spikes to 1 on a syllable onset then decays
  float confidence;      // pitch confidence 0..1
  bool  voiced;          // true when a pitch was found this frame
};

class VoxDsp {
public:
  VoxDsp();

  // Process one frame of VOX_FRAME_SAMPLES mono samples in [-1, 1].
  // dtSecs is the wall-clock time since the previous frame (for syllable debounce).
  VoxResult process(const float* frame, size_t n, float dtSecs);

  // Restart noise-floor calibration (e.g. on a screen tap when the room changes).
  void recalibrate();

  float noiseFloor() const { return _noiseFloor; }
  bool  calibrating() const { return _calibFrames < CALIB_TARGET_FRAMES; }

private:
  float detectPitch(const float* buf, size_t n, float rms);

  // --- calibration ---
  static const int CALIB_TARGET_FRAMES = 16; // ~1 s of quiet at ~64 ms/frame
  int   _calibFrames;
  float _calibSum;
  float _noiseFloor;

  // --- pitch post-processing ---
  float _pitchMedianBuf[7];
  int   _pitchMedianLen;
  float _confidence;

  // --- bounce: rolling voiced-pitch history + modal F0 ---
  static const int PITCH_HIST = 20;  // recent voiced pitches for variability
  static const int MODAL_HIST = 64;  // longer window for habitual (modal) F0
  float _pitchHist[PITCH_HIST];
  int   _pitchHistLen;
  float _modalHist[MODAL_HIST];
  int   _modalHistLen;
  int   _modalHistPos;

  // --- syllable onset state machine ---
  bool  _voicedState; // 'voiced' vs 'silent'
  float _syllableImpulse;
  float _timeSinceSyllable;

  // --- energy percentiles for dynamic syllable thresholds ---
  static const int ENERGY_HIST = 100; // ~6 s of gated RMS
  float _energyHist[ENERGY_HIST];
  int   _energyHistLen;
  int   _energyHistPos;
};
