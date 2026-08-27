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

// Formant dispersion (ΔF): the least-squares fit of the uniform-tube series
// F_i = (2i-1)*ΔF/2 over whichever of F1/F2/F3 were measured this frame. Pass 0 for a formant
// the estimator did not find — array SLOT is the formant number, so a missing F2 must not be
// mistaken for "F1 and F3 are adjacent". Returns 0 when fewer than two formants are available.
//
// Exposed (rather than kept file-static in dsp.cpp) so the host test can assert the same
// input->output vectors dsp-golden.test.mjs pins on the web side. Per DSP_CONTRACT D1 the
// resonance scale must mean the same thing on the watch as on the ball, and constant codegen
// alone cannot catch a formula diverging — only shared golden vectors can.
float voxFitFormantDispersion(float f1, float f2, float f3);

// ---- Resonance construct redesign: the scale/pattern split (Phase 6) --------------------
// docs/RESONANCE_REDESIGN.md. The web app no longer collapses one frame's F1-F3 into a single
// number: it separates how large the tract is (FORMANT SCALE) from what shape it is currently
// in (FORMANT PATTERN), because measured against Peterson & Barney norms the un-split score
// moved ~3x more with which vowel was spoken than with who was speaking. Phase 4 made the
// split's output the metric the ball displays, so by DSP_CONTRACT D1 the watch has to compute
// the same thing or "resonance 50%" means a different vocal target on each surface -- the
// exact miscoaching D1 exists to prevent.
//
// Everything below is a direct port of dsp-utils.js and is golden-tested against the same
// vectors dsp-golden.test.mjs pins on the web side.

// Per-formant weights for the scale regression. Ordinary weighted least squares: in the model
// F_i = x_i*dF + e_i the efficient weight is w_i = 1/sigma_i^2, and here the scatter around the
// model IS the vowel-induced excursion of F_i, whose relative size the redesign publishes as a
// coefficient of variation. So sigma_i = CV_i * Fbar_i. No free parameters. F1 and F2 define the
// vowel (CV 32% / 38%) and so carry almost no leverage in a tract-SIZE estimate; F3 is the only
// one of the three that is more speaker-determined than vowel-determined (CV 8%).
extern const float VOX_FORMANT_SCALE_CV[4];        // {0.32, 0.38, 0.08, 0.08}
extern const float VOX_FORMANT_SCALE_CENTRE_HZ[4]; // {500, 1500, 2500, 3500}

// w_i = 1/(CV_i * Fbar_i)^2, for slot i in 0..3. Exposed rather than kept file-static because
// the weights ARE the canonical definition of the scale fit: a port that hardcoded them and
// then let the CVs drift would still pass every residual vector below and would fail only
// here. dsp-golden.test.mjs pins the same derivation on the JS side.
float voxFormantScaleWeight(int i);

// Weighted zero-intercept fit of the uniform-tube series, the FORMANT SCALE stage:
//     dF = sum(w_i * x_i * F_i) / sum(w_i * x_i^2),   x_i = (2i-1)/2
// ARRAY SLOT IS THE FORMANT NUMBER, exactly as in voxFitFormantDispersion: 0 means "not
// measured this frame", never "the list is shorter". f4 may be 0 -- the F4-unavailable case is
// a supported operating point, not a degraded one, and this port has no F4 estimator at all
// (the ESP32/T-Watch path is harmonic-envelope, which resolves no fourth formant).
// Returns 0 when fewer than two formants are available.
float voxFitFormantScale(float f1, float f2, float f3, float f4);

// FORMANT PATTERN: the scale-normalised residuals r_i = F_i / ((i-0.5)*dF), written into
// out[4]. Each r_i says how far formant i sits from where a uniform tube of the speaker's own
// measured scale would put it -- tract shape, with tract size divided out. A formant that was
// not measured yields 0 in its slot; callers must treat that as "no residual", not as a
// residual of zero.
void voxFormantPatternResiduals(float f1, float f2, float f3, float f4, float deltaF, float out[4]);

// rho = sum(L_i * r_i) with L_i = w_i*x_i^2 / sum(w_j*x_j^2), over the first `limit` slots.
// This is EXACTLY 1 whenever dF was fitted to the same frame's formants -- an algebraic
// identity of the fit, which is why an n-formant residual vector carries only n-1 free
// dimensions. It departs from 1 only when dF came from somewhere else (a pooled window), and
// how far it departs is the rhotic signal the web app's vowel stage reads. Exposed so the host
// test can assert the identity rather than trust it.
float voxResidualScaleFactor(const float r[4], int limit);

// resonanceAbsolute: the speaker's apparent formant dispersion as a fraction of twice the adult
// population's, so 0.5 is an apparent tract the length of the population mean. One constant, and
// it is a published population location rather than a tuning knob: the Peterson & Barney grand
// mean upper-formant-weighted dispersion over both sexes.
#define VOX_RESONANCE_V2_REF_DELTA_F_HZ 1078.0f
float voxResonanceAbsolute(float deltaFScaleHz);

// Weighted median of a window of per-frame scales -- the pooling stage. Returns 0 when the
// window holds fewer than `minSamples` usable entries: "no scale yet", never "a short tract".
// Port of poolFormantScale in dsp-utils.js; the host test asserts the two agree.
#define VOX_SCALE_POOL_MAX 32
float voxPoolFormantScale(const float* deltaF, const float* weight, int n, int minSamples);

// Per-frame analysis result.
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
  // ---- the scale/pattern split (RESONANCE_REDESIGN.md, Phase 6) ----
  // Computed every frame, golden-tested against the web vectors, and DISPLAYED NOWHERE on this
  // port yet -- `resonance` above is still what drives the LED, the haptics and the gender
  // blend. See the note on _scalePool in this header for why the display switch is not part
  // of this change.
  float formantScaleHz;  // pooled, upper-formant-weighted dF (Hz) -- the tract SIZE. 0 = none yet.
  float apparentVtlCm;   // 35000 / (2*formantScaleHz), 0 when there is no pooled scale
  float resonanceAbsolute; // dF_scale / (2*1078 Hz) -- the population axis. 0 = no reading.
  float formantPattern[4]; // r_i = F_i/((i-0.5)*dF_pooled) -- the tract SHAPE. 0 = not measured.
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

  // --- pooled formant scale (RESONANCE_REDESIGN.md Phase 1, ported in Phase 6) ---
  // The scale is a property of the speaker, not of the frame. Fitting it per frame and then
  // comparing frames is the error the whole redesign exists to fix: one frame is one vowel and
  // one vowel is not a speaker, so a single speaker's apparent tract length swings 13.8-21.7 cm
  // across the vowel set. Pooling over a window that spans several vowels averages the shape
  // excursion out and leaves the size. Weighted MEDIAN, not mean, so one formant-tracking
  // failure dilutes instead of dragging.
  //
  // 26 frames is ~1.7 s at this port's ~64 ms frame -- the same span as the web app's 100
  // frames at 60 fps, which is what matters, not the frame count.
  //
  // WHY THIS IS NOT WIRED TO THE DISPLAY YET. Two reasons, both recorded in DSP_CONTRACT:
  //   1. This port's formants come from harmonic-envelope peak-picking, a documented
  //      approximation tier with no LPC and no F4. The scale fit is F3-dominated by design, so
  //      its accuracy here is bounded by an F3 nobody has measured on this path. Switching the
  //      displayed value onto an unmeasured F3 is exactly the "more valid, less available"
  //      trap the redesign's risk section warns about.
  //   2. The web app displays resonanceCONTROL (personally calibrated), not resonanceABSOLUTE.
  //      The absolute axis is deliberately shallow -- a speaker's whole across-vowel excursion
  //      occupies ~14 points -- and this port has no calibration to restore display travel.
  //      Whether the watch/necklace threshold belongs on absolute or control is open question
  //      #3 in RESONANCE_REDESIGN.md and is a product call, not a porting detail.
  // So Phase 6 lands the canonical computation and the shared golden vectors; the Layer B
  // display switch waits on those two.
  static const int SCALE_POOL = 26;
  float _scalePoolDeltaF[SCALE_POOL];
  float _scalePoolWeight[SCALE_POOL];
  int   _scalePoolLen;
  int   _scalePoolPos;
  float _pooledScaleHz;
};
