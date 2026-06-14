#include "dsp.h"
#include <math.h>
#include <string.h>

// ---- small helpers (mirror dsp-utils.js) ----
static inline float clamp01f(float v) {
  if (v < 0.0f) return 0.0f;
  if (v > 1.0f) return 1.0f;
  return v;
}

// pitchHzToPosition(hz, 80, 300) from dsp-utils.js:22
static inline float pitchHzToPosition(float hz, float minHz, float maxHz) {
  if (!isfinite(hz)) return 0.0f;
  return clamp01f((hz - minHz) / (maxHz - minHz));
}

// Upper bound for the scratch buffers below — must be >= the largest history window.
#define VOX_MAX_HIST 128

// Median of a copied float array (small n) via insertion sort — n <= VOX_MAX_HIST.
static float medianOf(const float* src, int n) {
  if (n <= 0) return 0.0f;
  float tmp[VOX_MAX_HIST];
  for (int i = 0; i < n; i++) tmp[i] = src[i];
  for (int i = 1; i < n; i++) {
    float key = tmp[i];
    int j = i - 1;
    while (j >= 0 && tmp[j] > key) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = key;
  }
  return tmp[n / 2];
}

// Percentile p in [0,1] of a copied array (insertion sort, small n).
static float percentileOf(const float* src, int n, float p) {
  if (n <= 0) return 0.0f;
  float tmp[VOX_MAX_HIST];
  for (int i = 0; i < n; i++) tmp[i] = src[i];
  for (int i = 1; i < n; i++) {
    float key = tmp[i];
    int j = i - 1;
    while (j >= 0 && tmp[j] > key) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = key;
  }
  int k = (int)((n - 1) * p);
  if (k < 0) k = 0;
  if (k > n - 1) k = n - 1;
  return tmp[k];
}

// YIN octave-up correction — ported from correctOctaveError() in dsp-utils.js:36.
static int correctOctaveError(const float* cmnd, int bestTau, int maxPeriod,
                              float relaxedThreshold = 0.35f) {
  if (!cmnd || bestTau <= 0) return bestTau;
  int limit = maxPeriod;
  float baseVal = cmnd[bestTau];
  if (!(baseVal >= 0.05f)) return bestTau; // confident dip — leave it alone
  for (int m = 2; m * bestTau <= limit; m++) {
    int tau = m * bestTau;
    float v = cmnd[tau];
    bool isLocalMin = (v <= cmnd[tau - 1]) && (tau + 1 > limit || v <= cmnd[tau + 1]);
    if (isLocalMin && v < relaxedThreshold && v <= baseVal + 0.02f) return tau;
  }
  return bestTau;
}

// In-place iterative radix-2 Cooley-Tukey FFT. n must be a power of two.
static void fftRadix2(float* re, float* im, int n) {
  // Bit-reversal permutation.
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      float tr = re[i]; re[i] = re[j]; re[j] = tr;
      float ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (int len = 2; len <= n; len <<= 1) {
    float ang = -2.0f * (float)M_PI / (float)len;
    float wlen_r = cosf(ang), wlen_i = sinf(ang);
    for (int i = 0; i < n; i += len) {
      float w_r = 1.0f, w_i = 0.0f;
      for (int k = 0; k < len / 2; k++) {
        int a = i + k, b = i + k + len / 2;
        float v_r = re[b] * w_r - im[b] * w_i;
        float v_i = re[b] * w_i + im[b] * w_r;
        re[b] = re[a] - v_r; im[b] = im[a] - v_i;
        re[a] += v_r;        im[a] += v_i;
        float nw_r = w_r * wlen_r - w_i * wlen_i;
        w_i = w_r * wlen_i + w_i * wlen_r;
        w_r = nw_r;
      }
    }
  }
}

// Spectral centroid (Hz) over [VOX_BRIGHT_LO_HZ, VOX_BRIGHT_HI_HZ], normalized to a 0..1
// brightness/resonance proxy. Ported from computeSpectralCentroid() in dsp-utils.js.
float VoxDsp::computeBrightness(const float* buf, size_t n, float rms, float* centroidHzOut) {
  *centroidHzOut = 0.0f;
  float silenceThreshold = calibrating() ? 0.015f : _noiseFloor * 2.5f;
  if (rms < silenceThreshold) return _smoothBright; // hold last value during silence

  static float re[VOX_FRAME_SAMPLES];
  static float im[VOX_FRAME_SAMPLES];
  const int N = (int)n;
  // Hann window to limit spectral leakage, then FFT.
  for (int i = 0; i < N; i++) {
    float w = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * i / (N - 1)));
    re[i] = buf[i] * w;
    im[i] = 0.0f;
  }
  fftRadix2(re, im, N);

  const float binHz = (float)VOX_SAMPLE_RATE / (float)N;
  int loBin = (int)(VOX_BRIGHT_LO_HZ / binHz);
  int hiBin = (int)(VOX_BRIGHT_HI_HZ / binHz);
  if (loBin < 1) loBin = 1;
  if (hiBin > N / 2) hiBin = N / 2;

  float num = 0.0f, den = 0.0f;
  for (int i = loBin; i <= hiBin; i++) {
    float mag = sqrtf(re[i] * re[i] + im[i] * im[i]);
    num += (i * binHz) * mag;
    den += mag;
  }
  float centroid = den > 0.0f ? num / den : 0.0f;
  *centroidHzOut = centroid;

  float bright = clamp01f((centroid - VOX_BRIGHT_MIN_HZ) /
                          (VOX_BRIGHT_MAX_HZ - VOX_BRIGHT_MIN_HZ));
  _smoothBright += (bright - _smoothBright) * 0.25f; // light EMA for stability
  return _smoothBright;
}

VoxDsp::VoxDsp() {
  recalibrate();
  _smoothBright = 0.0f;
  _pitchMedianLen = 0;
  _confidence = 0.0f;
  _pitchHistLen = 0;
  _modalHistLen = 0;
  _modalHistPos = 0;
  _voicedState = false;
  _syllableImpulse = 0.0f;
  _timeSinceSyllable = 999.0f;
  _energyHistLen = 0;
  _energyHistPos = 0;
}

void VoxDsp::recalibrate() {
  _calibFrames = 0;
  _calibSum = 0.0f;
  _noiseFloor = 0.015f; // fallback until calibration completes (app.js silence default)
}

// YIN pitch detector — ported from app.js detectPitch() (lines ~530-664).
float VoxDsp::detectPitch(const float* buf, size_t n, float rms) {
  const float sampleRate = (float)VOX_SAMPLE_RATE;

  // Silence gate (app.js:544): noiseFloor*2.5 once calibrated, else 0.015.
  float silenceThreshold = calibrating() ? 0.015f : _noiseFloor * 2.5f;
  if (rms < silenceThreshold) { _confidence = 0.0f; return 0.0f; }

  // 2x decimation with averaging low-pass (app.js:549-556).
  const float dsRate = sampleRate / 2.0f;
  const int dsN = (int)(n / 2);
  static float ds[VOX_FRAME_SAMPLES / 2];
  for (int i = 0; i < dsN; i++) ds[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5f;

  // Period bounds from the voice band, with the JS safety buffers (app.js:560-566).
  float safeMinHz = fmaxf(40.0f, VOX_PITCH_MIN_HZ * 0.85f);
  float safeMaxHz = fminf(600.0f, VOX_PITCH_MAX_HZ * 1.15f);
  int minPeriod = (int)fmaxf(2.0f, floorf(dsRate / safeMaxHz));
  int maxPeriod = (int)fminf(floorf(dsRate / safeMinHz), floorf(dsN / 2.0f));
  if (maxPeriod <= minPeriod) { _confidence = 0.0f; return 0.0f; }
  const int W = maxPeriod; // integration window

  // Difference function d(tau) + cumulative mean normalized difference d'(tau).
  // Running-sum-of-squares optimization, matching app.js:570-597.
  static float cmnd[VOX_FRAME_SAMPLES / 2 + 1];
  cmnd[0] = 1.0f;
  float runningSum = 0.0f;
  float sumSq0 = 0.0f;
  for (int i = 0; i < W; i++) sumSq0 += ds[i] * ds[i];
  float currentSumSqTau = 0.0f;
  for (int i = 0; i < W; i++) currentSumSqTau += ds[i + 1] * ds[i + 1];

  for (int tau = 1; tau <= maxPeriod; tau++) {
    float crossCorr = 0.0f;
    for (int i = 0; i < W; i++) crossCorr += ds[i] * ds[i + tau];
    float diff = sumSq0 + currentSumSqTau - 2.0f * crossCorr;
    if (diff < 0.0f) diff = 0.0f;
    runningSum += diff;
    cmnd[tau] = diff * tau / (runningSum != 0.0f ? runningSum : 1.0f);
    if (tau < maxPeriod) {
      float removeVal = ds[tau];
      float addVal = ds[tau + W];
      currentSumSqTau = currentSumSqTau - removeVal * removeVal + addVal * addVal;
    }
  }

  // Absolute threshold — first dip below YIN_THRESHOLD, then walk to local min.
  int bestTau = -1;
  for (int tau = minPeriod; tau <= maxPeriod; tau++) {
    if (cmnd[tau] < YIN_THRESHOLD) {
      while (tau + 1 <= maxPeriod && cmnd[tau + 1] < cmnd[tau]) tau++;
      bestTau = tau;
      break;
    }
  }
  // Fallback: global minimum; reject if still high (unvoiced).
  if (bestTau < 0) {
    float minVal = INFINITY;
    for (int tau = minPeriod; tau <= maxPeriod; tau++) {
      if (cmnd[tau] < minVal) { minVal = cmnd[tau]; bestTau = tau; }
    }
    if (minVal > 0.4f) { _confidence = 0.0f; return 0.0f; }
  }

  bestTau = correctOctaveError(cmnd, bestTau, maxPeriod);

  // Parabolic interpolation for sub-sample accuracy (app.js:633-645).
  float period = (float)bestTau;
  float cmndAtBest = cmnd[bestTau];
  if (bestTau > 0 && bestTau < maxPeriod) {
    float a = cmnd[bestTau - 1];
    float b = cmnd[bestTau];
    float c = cmnd[bestTau + 1];
    float denom = 2.0f * (2.0f * b - a - c);
    if (fabsf(denom) > 1e-10f) period = bestTau + (a - c) / denom;
  }

  float rawHz = dsRate / period;

  _confidence = clamp01f(1.0f - cmndAtBest * PITCH_CONFIDENCE_FACTOR);

  // Median filter over the last 7 raw detections (app.js:653-663).
  if (_pitchMedianLen < 7) {
    _pitchMedianBuf[_pitchMedianLen++] = rawHz;
  } else {
    for (int i = 1; i < 7; i++) _pitchMedianBuf[i - 1] = _pitchMedianBuf[i];
    _pitchMedianBuf[6] = rawHz;
  }
  if (_pitchMedianLen >= 3) return medianOf(_pitchMedianBuf, _pitchMedianLen);
  return rawHz;
}

VoxResult VoxDsp::process(const float* frame, size_t n, float dtSecs) {
  VoxResult r = {};

  // --- RMS energy (app.js update()) ---
  float rms = 0.0f;
  for (size_t i = 0; i < n; i++) rms += frame[i] * frame[i];
  rms = sqrtf(rms / (float)n);
  r.rms = rms;

  // --- noise-floor calibration over the first ~1 s of (assumed quiet) frames ---
  if (_calibFrames < CALIB_TARGET_FRAMES) {
    _calibSum += rms;
    _calibFrames++;
    if (_calibFrames >= CALIB_TARGET_FRAMES) {
      _noiseFloor = fmaxf(0.0005f, _calibSum / (float)CALIB_TARGET_FRAMES);
    }
  }

  // --- pitch ---
  float hz = detectPitch(frame, n, rms);
  r.voiced = hz > 0.0f;
  r.pitchHz = hz;
  r.confidence = _confidence;
  r.pitchPos = pitchHzToPosition(hz, VOX_PITCH_MIN_HZ, VOX_PITCH_MAX_HZ);

  // --- brightness / resonance proxy (spectral centroid) ---
  float centroidHz = 0.0f;
  r.brightness = computeBrightness(frame, n, rms, &centroidHz);
  r.centroidHz = centroidHz;

  // --- bounce: semitone std-dev of recent voiced pitch vs modal F0 (app.js:1134-1151) ---
  if (r.voiced) {
    // Append to both rolling histories.
    if (_pitchHistLen < PITCH_HIST) {
      _pitchHist[_pitchHistLen++] = hz;
    } else {
      for (int i = 1; i < PITCH_HIST; i++) _pitchHist[i - 1] = _pitchHist[i];
      _pitchHist[PITCH_HIST - 1] = hz;
    }
    _modalHist[_modalHistPos] = hz;
    _modalHistPos = (_modalHistPos + 1) % MODAL_HIST;
    if (_modalHistLen < MODAL_HIST) _modalHistLen++;
  }
  float modalF0 = _modalHistLen > 0 ? medianOf(_modalHist, _modalHistLen) : 0.0f;
  if (_pitchHistLen > 3 && modalF0 > 0.0f) {
    float stSum = 0.0f;
    for (int i = 0; i < _pitchHistLen; i++) stSum += 12.0f * log2f(_pitchHist[i] / modalF0);
    float stMean = stSum / _pitchHistLen;
    float stSqSum = 0.0f;
    for (int i = 0; i < _pitchHistLen; i++) {
      float d = 12.0f * log2f(_pitchHist[i] / modalF0) - stMean;
      stSqSum += d * d;
    }
    r.bounce = clamp01f(sqrtf(stSqSum / _pitchHistLen) / INTONATION_ST_DIVISOR);
  } else {
    r.bounce = 0.0f;
  }

  // --- syllable onset (app.js:1206-1224) ---
  // gatedRms: energy above the noise floor.
  float gatedRms = fmaxf(0.0f, rms - _noiseFloor);

  // Track gated energy for dynamic percentile thresholds.
  _energyHist[_energyHistPos] = gatedRms;
  _energyHistPos = (_energyHistPos + 1) % ENERGY_HIST;
  if (_energyHistLen < ENERGY_HIST) _energyHistLen++;
  float p50 = percentileOf(_energyHist, _energyHistLen, 0.50f);
  float p90 = percentileOf(_energyHist, _energyHistLen, 0.90f);
  float baseEnergyRange = fmaxf(0.001f, p90 - p50);

  float syllableOnThreshold = fmaxf(0.005f, p50 + baseEnergyRange * SYLLABLE_ON_MULT);
  float syllableOffThreshold = fmaxf(0.002f, p50 + baseEnergyRange * SYLLABLE_OFF_MULT);

  _timeSinceSyllable += dtSecs;
  if (gatedRms > syllableOnThreshold && !_voicedState) {
    if (_timeSinceSyllable > SYLLABLE_DEBOUNCE_SECS) {
      _timeSinceSyllable = 0.0f;
      _syllableImpulse = 1.0f;
    }
    _voicedState = true;
  } else if (gatedRms < syllableOffThreshold) {
    _voicedState = false;
  }
  r.syllableImpulse = _syllableImpulse;
  _syllableImpulse *= SYLLABLE_IMPULSE_DECAY;

  return r;
}
