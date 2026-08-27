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

// ---- Brightness/resonance cue ----
// Spectral centroid (a.k.a. "center of gravity", computeSpectralCentroid in dsp-utils.js)
// is a cheap, robust proxy for vocal brightness/resonance: a brighter, more forward voice
// pushes energy higher in the spectrum. It is NOT full formant tracking (that 4096-pt FFT +
// cepstrum port is still on the roadmap) but is a real, usable cue for colour/haptics.
#define VOX_BRIGHT_MIN_HZ 400.0f   // centroid mapped to brightness 0
#define VOX_BRIGHT_MAX_HZ 2200.0f  // centroid mapped to brightness 1
#define VOX_BRIGHT_LO_HZ  120.0f   // analysis band low edge (skip DC/hum)
#define VOX_BRIGHT_HI_HZ  5000.0f  // analysis band high edge

// ---- Formant / resonance / perceived-gender cue ----
// Harmonic-envelope formant estimation (F1/F2/F3) ported from app.js
// _resonanceHarmonicEnvelope + _peakPickFormants, then resonance from formant dispersion
// (apparent vocal-tract length) and a perceived-gender blend of pitch + resonance
// (computeGenderScore in dsp-utils.js). Returns 0=masculine .. 1=feminine.
#define VOX_GENDER_PITCH_MIN_HZ 110.0f
#define VOX_GENDER_PITCH_MAX_HZ 220.0f

// Per-frame analysis result.
// ---- Formant dispersion, and the scale/pattern split (RESONANCE_REDESIGN.md, Phase 6) ----
//
// This port was still computing ΔF as an endpoint difference over a COMPACTED formant list --
// (F3-F1)/2, with F2-F1 substituted whenever F3 went missing -- long after the web app and the
// T-Watch port were both moved onto the least-squares uniform-tube fit. docs/DSP_CONTRACT.md
// said "both ports" were fixed; "both" meant web and the watch, and this third port was never
// in that count and had no host test to notice.
//
// Both halves of that were the same bug: array POSITION was being read as adjacency rather than
// as formant number. A dropped F2 doubled ΔF, halving the apparent tract length and pinning
// resonance at the bright rail off one bad frame; a dropped F3 silently swapped in F2-F1, one
// of the most vowel-dependent quantities in the spectrum (~2200 Hz on /i/, ~700 Hz on /u/), as
// a "vocal-tract length". On a device whose whole output is a vibration motor and an LED, that
// fires the wrong haptic against the wrong vocal target.
//
// Declared (not file-static) so test/dsp_host_test.cpp can assert the same input->output
// vectors dsp-golden.test.mjs pins on the web side and the T-Watch port already reproduces.

// Least-squares fit of F_i = (2i-1)*ΔF/2 through the origin. Pass 0 for a formant the estimator
// did not find: the SLOT is the formant number. Returns 0 below two formants.
float voxFitFormantDispersion(float f1, float f2, float f3);

// The upper-formant-weighted scale fit. w_i = 1/(CV_i*Fbar_i)^2 with the CVs published in the
// redesign: F1 and F2 define the vowel and so carry almost no leverage in a tract-SIZE
// estimate, while F3 is the only one of the three that is more speaker- than vowel-determined.
extern const float VOX_FORMANT_SCALE_CV[4];
extern const float VOX_FORMANT_SCALE_CENTRE_HZ[4];
float voxFormantScaleWeight(int i);
float voxFitFormantScale(float f1, float f2, float f3, float f4);

// FORMANT PATTERN: r_i = F_i / ((i-0.5)*ΔF), written into out[4]; 0 in a slot means "not
// measured", never "a residual of zero".
void voxFormantPatternResiduals(float f1, float f2, float f3, float f4, float deltaF, float out[4]);

// rho = sum(L_i*r_i), exactly 1 when ΔF was fitted to the same frame's formants.
float voxResidualScaleFactor(const float r[4], int limit);

#define VOX_RESONANCE_V2_REF_DELTA_F_HZ 1078.0f
float voxResonanceAbsolute(float deltaFScaleHz);

struct VoxResult {
  float rms;             // raw RMS energy of the frame (0..~1)
  float pitchHz;         // detected fundamental, 0 if silent/unvoiced
  float pitchPos;        // pitchHzToPosition(pitchHz, 80, 300) -> 0..1
  float bounce;          // intonation variability 0..1
  float syllableImpulse; // 0..1, spikes to 1 on a syllable onset then decays
  float confidence;      // pitch confidence 0..1
  float brightness;      // spectral-centroid resonance proxy 0..1 (smoothed)
  float centroidHz;      // raw spectral centroid in Hz (0 if silent)
  float f1, f2, f3;      // estimated formants in Hz (0 if unavailable)
  float resonance;       // dispersion/VTL-based resonance 0..1 (dark..bright)
  // The scale/pattern split, computed per frame and displayed nowhere on this port yet --
  // `resonance` above still drives the motor and the LED. Unpooled here: this port has no
  // rolling-window state and adding one is a separate change from fixing the fit.
  float formantScaleHz;    // upper-formant-weighted ΔF for this frame (Hz), 0 if unavailable
  float resonanceAbsolute; // ΔF_scale / (2*1078 Hz), 0 = no reading
  float formantConf;     // formant estimate confidence 0..1
  float weight;          // vocal weight 0..1 (0 light/breathy .. 1 heavy/pressed), H1-H2
  float genderScore;     // perceived gender 0..1 (0 masc .. 1 fem), smoothed
  float genderHue;       // 210 (blue/masc) .. 340 (pink/fem)
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
  void  computeSpectrum(const float* buf, size_t n);  // one windowed FFT -> _mag/_logmag
  float brightnessFromSpectrum();                      // spectral centroid -> 0..1
  // Harmonic-envelope formants; fills f1/f2/f3 (Hz) and a 0..1 confidence.
  void  computeFormants(float f0, float* f1, float* f2, float* f3, float* conf);
  // Vocal weight (heaviness) from the H1-H2 breathiness measure, 0 light .. 1 heavy.
  float computeWeight(float f0);

  // --- shared per-frame spectrum (linear magnitude + dB), bins 0..N/2 ---
  float _mag[VOX_FRAME_SAMPLES / 2 + 1];
  float _logmag[VOX_FRAME_SAMPLES / 2 + 1];
  bool  _specValid;

  // --- brightness / gender / weight smoothing ---
  float _smoothBright;
  float _smoothGender;
  float _smoothWeight;

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
