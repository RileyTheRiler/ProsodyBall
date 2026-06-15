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

static inline float binToHz(int bin) {
  return (float)bin * (float)VOX_SAMPLE_RATE / (float)VOX_FRAME_SAMPLES;
}

// One Hann-windowed FFT per frame -> linear magnitude (_mag) and dB (_logmag), bins 0..N/2.
// Shared by the brightness (centroid) and formant estimators so we only transform once.
void VoxDsp::computeSpectrum(const float* buf, size_t n) {
  static float re[VOX_FRAME_SAMPLES];
  static float im[VOX_FRAME_SAMPLES];
  const int N = (int)n;
  for (int i = 0; i < N; i++) {
    float w = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * i / (N - 1)));
    re[i] = buf[i] * w;
    im[i] = 0.0f;
  }
  fftRadix2(re, im, N);
  for (int i = 0; i <= N / 2; i++) {
    float m = sqrtf(re[i] * re[i] + im[i] * im[i]);
    _mag[i] = m;
    _logmag[i] = m > 1e-10f ? 20.0f * log10f(m) : -200.0f;
  }
  _specValid = true;
}

// Spectral centroid (Hz) over [VOX_BRIGHT_LO_HZ, VOX_BRIGHT_HI_HZ] -> 0..1 brightness.
// Ported from computeSpectralCentroid() in dsp-utils.js.
float VoxDsp::brightnessFromSpectrum() {
  const int N = VOX_FRAME_SAMPLES;
  const float binHz = binToHz(1);
  int loBin = (int)(VOX_BRIGHT_LO_HZ / binHz);
  int hiBin = (int)(VOX_BRIGHT_HI_HZ / binHz);
  if (loBin < 1) loBin = 1;
  if (hiBin > N / 2) hiBin = N / 2;

  float num = 0.0f, den = 0.0f;
  for (int i = loBin; i <= hiBin; i++) {
    num += (i * binHz) * _mag[i];
    den += _mag[i];
  }
  float centroid = den > 0.0f ? num / den : 0.0f;
  float bright = clamp01f((centroid - VOX_BRIGHT_MIN_HZ) /
                          (VOX_BRIGHT_MAX_HZ - VOX_BRIGHT_MIN_HZ));
  _smoothBright += (bright - _smoothBright) * 0.25f;
  return _smoothBright;
}

// Harmonic-envelope formant estimation. Ported from app.js _resonanceHarmonicEnvelope +
// _peakPickFormants: sample the dB spectrum at each harmonic of f0 (with local peak search
// + parabolic amplitude interp), apply +6 dB/oct tilt compensation, Gaussian-smooth into an
// envelope over harmonics, then pick F1/F2/F3 as the strongest local maxima within bands.
void VoxDsp::computeFormants(float f0, float* f1, float* f2, float* f3, float* conf) {
  *f1 = 0; *f2 = 0; *f3 = 0; *conf = 0;
  if (!(f0 > 0.0f) || !_specValid) return;

  const float binHz = binToHz(1);
  const int   nBins = VOX_FRAME_SAMPLES / 2;
  const float maxHarmonicHz = 5500.0f;
  int numH = (int)(maxHarmonicHz / f0);
  if (numH > 40) numH = 40;
  if (numH < 4) return;

  static float amps[40];
  static float env[40];
  const int searchRange = (int)fmaxf(1.0f, floorf(f0 / binHz * 0.3f));
  for (int h = 0; h < numH; h++) {
    float hFreq = f0 * (h + 1);
    int binInt = (int)floorf(hFreq / binHz);
    if (binInt < 1 || binInt + 1 >= nBins) { amps[h] = -200.0f; continue; }
    int peakBin = binInt; float peakVal = _logmag[binInt];
    for (int s = -searchRange; s <= searchRange; s++) {
      int idx = binInt + s;
      if (idx >= 0 && idx < nBins && _logmag[idx] > peakVal) { peakVal = _logmag[idx]; peakBin = idx; }
    }
    if (peakBin > 0 && peakBin < nBins - 1) {
      float a = _logmag[peakBin - 1], b = _logmag[peakBin], c = _logmag[peakBin + 1];
      float denom = a - 2 * b + c;
      amps[h] = fabsf(denom) > 0.001f ? b - (a - c) * (a - c) / (8 * denom) : b;
    } else {
      amps[h] = peakVal;
    }
    amps[h] += 6.0f * log2f(hFreq / f0); // +6 dB/oct tilt compensation
  }

  // 5-point Gaussian smoothing (sigma ~1 harmonic).
  const float gW[5] = {0.06f, 0.24f, 0.40f, 0.24f, 0.06f};
  for (int i = 0; i < numH; i++) {
    float sum = 0, wSum = 0;
    for (int k = -2; k <= 2; k++) {
      int j = i + k;
      if (j >= 0 && j < numH) { sum += amps[j] * gW[k + 2]; wSum += gW[k + 2]; }
    }
    env[i] = sum / wSum;
  }

  // Peak-pick F1/F2/F3 within frequency bands with a minimum separation.
  const float minF1 = 200, maxF1 = 1100, minF2 = 600, maxF2 = 3500;
  const float minF3 = 2200, maxF3 = 4200, minSep = 300;
  float F1 = 0, F2 = 0, F3 = 0, a1 = -1e30f, a2 = -1e30f, a3 = -1e30f;
  float envMin = env[0], envMax = env[0];
  for (int i = 1; i < numH; i++) { if (env[i] < envMin) envMin = env[i]; if (env[i] > envMax) envMax = env[i]; }

  for (int i = 1; i < numH - 1; i++) {
    if (env[i] > env[i - 1] && env[i] > env[i + 1]) {
      float a = env[i - 1], b = env[i], c = env[i + 1];
      float denom = a - 2 * b + c;
      float refinedIdx = i, refinedAmp = b;
      if (fabsf(denom) > 0.001f) {
        float delta = 0.5f * (a - c) / denom;
        if (delta < -0.5f) delta = -0.5f;
        if (delta > 0.5f) delta = 0.5f;
        refinedIdx = i + delta;
        refinedAmp = b - (a - c) * (a - c) / (8 * denom);
      }
      float freq = f0 * (refinedIdx + 1);
      if (freq >= minF1 && freq <= maxF1 && refinedAmp > a1) { a1 = refinedAmp; F1 = freq; }
    }
  }
  float f2Floor = fmaxf(minF2, F1 + minSep);
  float f3Floor = fmaxf(minF3, 0);
  for (int i = 1; i < numH - 1; i++) {
    if (env[i] > env[i - 1] && env[i] > env[i + 1]) {
      float a = env[i - 1], b = env[i], c = env[i + 1];
      float denom = a - 2 * b + c;
      float refinedIdx = i, refinedAmp = b;
      if (fabsf(denom) > 0.001f) {
        float delta = 0.5f * (a - c) / denom;
        if (delta < -0.5f) delta = -0.5f;
        if (delta > 0.5f) delta = 0.5f;
        refinedIdx = i + delta;
        refinedAmp = b - (a - c) * (a - c) / (8 * denom);
      }
      float freq = f0 * (refinedIdx + 1);
      if (freq >= f2Floor && freq <= maxF2 && refinedAmp > a2) { a2 = refinedAmp; F2 = freq; }
    }
  }
  f3Floor = fmaxf(minF3, F2 + minSep);
  for (int i = 1; i < numH - 1; i++) {
    if (env[i] > env[i - 1] && env[i] > env[i + 1]) {
      float a = env[i - 1], b = env[i], c = env[i + 1];
      float denom = a - 2 * b + c;
      float refinedAmp = (fabsf(denom) > 0.001f) ? b - (a - c) * (a - c) / (8 * denom) : b;
      float freq = f0 * (i + 1);
      if (freq >= f3Floor && freq <= maxF3 && refinedAmp > a3) { a3 = refinedAmp; F3 = freq; }
    }
  }
  if (F1 <= 0) F1 = 500;   // neutral fallbacks
  if (F2 <= 0) F2 = 1500;

  float envRange = envMax - envMin;
  float prom = 0;
  if (envRange > 0) {
    float p1 = clamp01f((a1 - envMin) / envRange);
    float p2 = clamp01f((a2 - envMin) / envRange);
    prom = (p1 + p2) * 0.5f;
  }
  *f1 = F1; *f2 = F2; *f3 = F3;
  *conf = clamp01f(prom * _confidence); // gate by pitch confidence (vowel-like, voiced)
}

// Peak dB of the spectrum near a target frequency (local search, like the formant sampler).
static float harmonicPeakDb(const float* logmag, int nBins, float freq) {
  const float binHz = binToHz(1);
  int bin = (int)floorf(freq / binHz);
  if (bin < 1 || bin >= nBins) return -200.0f;
  int range = (int)fmaxf(1.0f, floorf(freq / binHz * 0.15f));
  float peak = logmag[bin];
  for (int s = -range; s <= range; s++) {
    int idx = bin + s;
    if (idx >= 0 && idx < nBins && logmag[idx] > peak) peak = logmag[idx];
  }
  return peak;
}

// Vocal weight from the H1-H2 measure (amplitude of the 1st vs 2nd harmonic, dB). Breathy
// voices have H1 >> H2 (large H1-H2 -> light); pressed/modal voices have small H1-H2 -> heavy.
// This is the breathiness cue behind computeWeightTarget's h1h2Heaviness in dsp-utils.js.
float VoxDsp::computeWeight(float f0) {
  if (!(f0 > 0.0f) || !_specValid) return _smoothWeight;
  const int nBins = VOX_FRAME_SAMPLES / 2;
  float h1 = harmonicPeakDb(_logmag, nBins, f0);
  float h2 = harmonicPeakDb(_logmag, nBins, 2.0f * f0);
  if (h1 <= -199.0f || h2 <= -199.0f) return _smoothWeight;
  float h1h2 = h1 - h2;                                  // dB
  float heaviness = clamp01f((15.0f - h1h2) / 20.0f);    // +15 dB -> 0 light, -5 dB -> 1 heavy
  _smoothWeight += (heaviness - _smoothWeight) * 0.15f;
  return _smoothWeight;
}

// dispersionToFemininity(meanSpacingHz, 900, 1200) from dsp-utils.js.
static float dispersionToFemininity(float meanSpacingHz) {
  if (!(meanSpacingHz > 0)) return 0.5f;
  return clamp01f((meanSpacingHz - 900.0f) / (1200.0f - 900.0f));
}

// computeGenderScore(pitch + resonance blend, confidence-weighted) from dsp-utils.js.
static float computeGenderScore(float pitchHz, float resonance, float pitchConf, float formantConf) {
  float pitchNorm = pitchHz > 0
      ? clamp01f((pitchHz - VOX_GENDER_PITCH_MIN_HZ) /
                 (VOX_GENDER_PITCH_MAX_HZ - VOX_GENDER_PITCH_MIN_HZ))
      : 0.5f;
  float resNorm = clamp01f(resonance);
  float pc = clamp01f(pitchConf), fc = clamp01f(formantConf);
  float wPitch = 0.5f * (0.35f + 0.65f * pc);
  float wRes   = 0.5f * (0.35f + 0.65f * fc) * 1.1f; // resonance gets a slight edge
  float totalW = wPitch + wRes;
  float blended = totalW > 1e-6f ? (pitchNorm * wPitch + resNorm * wRes) / totalW : 0.5f;
  float overallConf = fmaxf(pc, fc);
  return clamp01f(0.5f + (blended - 0.5f) * overallConf);
}

VoxDsp::VoxDsp() {
  recalibrate();
  _smoothBright = 0.0f;
  _smoothGender = 0.5f;
  _smoothWeight = 0.5f;
  _specValid = false;
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

  // --- spectrum-derived cues (one FFT shared by brightness + formants) ---
  float silenceThreshold = calibrating() ? 0.015f : _noiseFloor * 2.5f;
  _specValid = false;
  if (rms >= silenceThreshold) computeSpectrum(frame, n);

  // Brightness (spectral centroid). Holds last value during silence.
  if (_specValid) { r.brightness = brightnessFromSpectrum(); }
  else            { r.brightness = _smoothBright; }
  r.centroidHz = 0.0f; // (centroid Hz no longer surfaced separately)

  // Formants -> resonance (vocal-tract length via formant dispersion) -> perceived gender.
  computeFormants(hz, &r.f1, &r.f2, &r.f3, &r.formantConf);
  float meanSpacing = 0.0f;
  if (r.f1 > 0 && r.f2 > 0 && r.f3 > 0) meanSpacing = (r.f3 - r.f1) * 0.5f;
  else if (r.f1 > 0 && r.f2 > 0)        meanSpacing = (r.f2 - r.f1);
  r.resonance = dispersionToFemininity(meanSpacing);

  // Vocal weight (breathy/light .. pressed/heavy) from H1-H2.
  r.weight = computeWeight(hz);

  float genderTarget = computeGenderScore(hz, r.resonance, _confidence, r.formantConf);
  // Only let confident, voiced frames move the smoothed score; else drift toward neutral.
  if (r.voiced && r.formantConf > 0.05f) _smoothGender += (genderTarget - _smoothGender) * 0.15f;
  else                                   _smoothGender += (0.5f - _smoothGender) * 0.02f;
  r.genderScore = _smoothGender;
  r.genderHue = 210.0f + clamp01f(_smoothGender) * 130.0f; // genderScoreToHue (blue->pink)

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
