import * as DSP_CONST from './dsp-constants.generated.js';

export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function sanitizeUrl(url) {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    if (['http:', 'https:', 'blob:'].includes(parsed.protocol)) {
      return parsed.href;
    }
  } catch (e) {
    // invalid URL fallback
  }
  return 'about:blank';
}

export function computeRawProsody(metrics) {
  return (
    metrics.bounce * 0.50 +
    metrics.vowel * 0.30 +
    metrics.articulation * 0.20
  );
}

export function smoothToward(current, target, factor) {
  return current + (target - current) * factor;
}

export function computeProsodyScore(previous, metrics, smoothing = 0.12) {
  const raw = computeRawProsody(metrics);
  return clamp(smoothToward(previous, raw, smoothing), 0, 1);
}

export function pitchHzToPosition(hz, minHz = 80, maxHz = 300) {
  if (!Number.isFinite(hz)) return 0;
  return clamp((hz - minHz) / (maxHz - minHz), 0, 1);
}

// YIN octave-up correction. YIN picks the FIRST CMND dip below a strict threshold; when a voice
// has a weak fundamental, that first dip can land on the 2x harmonic (half the true period),
// reporting double the pitch. Re-examine integer multiples of the chosen period: if a longer
// period (m * bestTau) is itself a local CMND minimum that is below a RELAXED threshold AND is
// at least as deep as the chosen dip, it is the true fundamental that the greedy first-below-
// threshold rule skipped — return it. A very deep dip at bestTau (cmnd < 0.05) is confidently
// the fundamental and is never second-guessed, which protects clean strong voices from being
// pulled an octave DOWN onto a sub-harmonic. Smallest qualifying multiple wins (no over-shoot).
// Pure + synchronous so it can be unit-tested without audio.
export function correctOctaveError(cmnd, bestTau, { maxPeriod, relaxedThreshold = 0.35 } = {}) {
  if (!cmnd || !(bestTau > 0)) return bestTau;
  const limit = Number.isFinite(maxPeriod) ? Math.min(maxPeriod, cmnd.length - 1) : cmnd.length - 1;
  const baseVal = cmnd[bestTau];
  if (!(baseVal >= 0.05)) return bestTau; // confident (or invalid) dip — leave it alone
  for (let m = 2; m * bestTau <= limit; m++) {
    const tau = m * bestTau;
    const v = cmnd[tau];
    const isLocalMin = v <= cmnd[tau - 1] && (tau + 1 > limit || v <= cmnd[tau + 1]);
    // Below the relaxed gate and comparably deep (or deeper) than the harmonic YIN latched onto.
    if (isLocalMin && v < relaxedThreshold && v <= baseVal + 0.02) return tau;
  }
  return bestTau;
}

export async function ensureAudioContextRunning(ctx) {
  if (!ctx) return { ok: false };
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch (e) {
      console.warn('Failed to resume AudioContext', e);
      return { ok: false };
    }
  }
  return { ok: ctx.state === 'running' };
}

export async function getMicDiagnostics(ctx) {
  if (!ctx) return { ok: false, message: 'No audio context' };
  
  // Try to determine microphone permission status
  let permission = 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    permission = status.state;
  } catch (e) {
    // some browsers don't support permissions.query for microphone
  }

  return { 
    ok: ctx.state === 'running', 
    message: ctx.state,
    permission,
    audioState: ctx.state,
    secureContext: window.isSecureContext,
    inIframe: window.self !== window.top,
    mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  };
}

export function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function normalizeAgainstRange(value, min, max) {
  const denom = Math.max(1e-6, max - min);
  return clamp01((value - min) / denom);
}

export function normalizeAgainstPercentiles(value, p50, p90, gain = 1) {
  const spread = Math.max(0.0005, p90 - p50);
  return clamp01(((value - p50) / spread) * gain);
}

export function computeFrameReliability({ pitchConfidence = 0, formantConfidence = 0, voicedStrength = 0, spectralTiltConfidence = 0, snrConfidence = 1, wasLastFrameReliable = false }) {
  const baseGate = clamp01(Math.max(0.2, pitchConfidence * 0.55 + formantConfidence * 0.25 + spectralTiltConfidence * 0.2));
  // SNR couples in multiplicatively, so genuine noise can pull confidence below the
  // 0.2 floor (toward the red tier) instead of the gate pretending a noisy frame is
  // borderline-trustworthy. snrConfidence defaults to 1 (a no-op) for callers that
  // don't yet supply an SNR estimate, preserving prior behaviour and the fixtures.
  const confidenceGate = clamp01(baseGate * clamp01(snrConfidence));
  const voicedGate = clamp01(Math.max(0.25, voicedStrength * 0.75 + pitchConfidence * 0.25));

  let reliableFrame;
  if (wasLastFrameReliable) {
    reliableFrame = (pitchConfidence > 0.25 || formantConfidence > 0.30) && voicedStrength > 0.15;
  } else {
    reliableFrame = (pitchConfidence > 0.35 || formantConfidence > 0.40) && voicedStrength > 0.25;
  }

  return { confidenceGate, voicedGate, reliableFrame };
}

// ====== PER-FRAME SNR / NOISE TRUST ======
// Layer A feature-packet primitives (see docs/DSP_CONTRACT.md). These are the inputs
// that drive the confidence tier, SNR-adaptive over-subtraction, and (later) the graded
// watch/necklace haptics. Pure + unit-tested so the values are portable to the Kotlin/C++
// ports and seed dsp-constants.json.

// SNR(dB) tier edges + over-subtraction bounds + the pause noise-update rate now live in
// the cross-platform spec (dsp-constants.json) and are codegen'd into dsp-constants.generated.js
// (and the Kotlin/C++ equivalents). We import them here so this module stays the JS consumer
// of the single source of truth; re-export keeps app.js / tests importing them from dsp-utils.
export const { SNR_GREEN_DB, SNR_YELLOW_DB, OVERSUB_MIN, OVERSUB_MAX, NOISE_PROFILE_UPDATE_RATE,
  STEADY_PITCH_ST, STEADY_FORMANT_REL_DELTA, STEADY_WEIGHT_FLOOR } = DSP_CONST;

// a-posteriori SNR in dB from linear *power* (energy) terms.
export function aPosterioriSnrDb(signalEnergy, noiseEnergy) {
  const s = Math.max(0, signalEnergy);
  const n = Math.max(1e-12, noiseEnergy);
  return 10 * Math.log10((s + 1e-12) / n);
}

// Map SNR(dB) → 0..1 trust via a linear red→green ramp; drives confidence + UI vividness.
export function snrToConfidence(snrDb, redDb = SNR_YELLOW_DB, greenDb = SNR_GREEN_DB) {
  return normalizeAgainstRange(snrDb, redDb, greenDb);
}

// Coarse tier for UI/haptics: 'green' | 'yellow' | 'red'.
export function snrTier(snrDb, yellowDb = SNR_YELLOW_DB, greenDb = SNR_GREEN_DB) {
  if (snrDb >= greenDb) return 'green';
  if (snrDb >= yellowDb) return 'yellow';
  return 'red';
}

// SNR-adaptive over-subtraction factor. High SNR → OVERSUB_MIN (gentle); low SNR → up to
// OVERSUB_MAX. Replaces the hardcoded 1.5 at the spectral-subtraction sites.
export function adaptiveOverSubtraction(snrDb, {
  minFactor = OVERSUB_MIN, maxFactor = OVERSUB_MAX, redDb = SNR_YELLOW_DB, greenDb = SNR_GREEN_DB
} = {}) {
  const noisiness = 1 - normalizeAgainstRange(snrDb, redDb, greenDb); // 0 clean → 1 noisy
  return minFactor + (maxFactor - minFactor) * noisiness;
}

// Steady-state weight in [floor, 1]. 1 at a held vowel target; →floor during onsets,
// offsets, glides, and coarticulatory transitions — the frames no clinician would hand-
// measure. Combines short-window pitch stability (segment-local semitone deviation) with
// frame-to-frame formant motion (|dF1|/F1 + |dF2|/F2). Used to up-weight steady frames and
// down-weight (not discard) transition frames in the live per-frame resonance estimate.
export function steadyStateWeight({
  pitchSemitoneDev = 0,   // recent pitch deviation in semitones (segment-local std)
  formantRelDelta = 0,    // combined frame-to-frame |dF1|/F1 + |dF2|/F2
  pitchTol = STEADY_PITCH_ST,
  formantTol = STEADY_FORMANT_REL_DELTA,
  floor = STEADY_WEIGHT_FLOOR
} = {}) {
  const pitchSteady = clamp(1 - Math.abs(pitchSemitoneDev) / Math.max(1e-6, pitchTol), 0, 1);
  const formantSteady = clamp(1 - Math.abs(formantRelDelta) / Math.max(1e-6, formantTol), 0, 1);
  const steadiness = pitchSteady * formantSteady; // both must hold for a frame to count as steady
  return floor + (1 - floor) * steadiness;
}

// SNR-driven resonance-method selection for the 'auto' mode. Each of the four estimators
// degrades differently in noise: LPC root-solving is most precise in clean signal but its
// roots get unstable as noise rises; the cepstral envelope is smoother/more robust mid-SNR;
// the spectral centroid is the most noise-tolerant (no peak-picking) when SNR collapses.
export function selectResonanceMethod(snrDb, { greenDb = SNR_GREEN_DB, yellowDb = SNR_YELLOW_DB } = {}) {
  if (snrDb >= greenDb) return 'lpc';        // clean: root-solved precision
  if (snrDb >= yellowDb) return 'cepstral';  // moderate noise: smooth, robust
  return 'centroid';                          // heavy noise: most noise-tolerant
}

export function computeWeightTarget({ tiltHeaviness = 0.5, tiltWeight = 1, h1h2Heaviness = 0.5, h1h2Weight = 0, cppHeaviness = 0.5, cppWeight = 0 }) {
  const wT = Math.max(0, tiltWeight);
  const wH = Math.max(0, h1h2Weight);
  const wC = Math.max(0, cppWeight);
  const total = wT + wH + wC;
  if (total <= 0) return clamp01(tiltHeaviness);
  return clamp01((tiltHeaviness * wT + h1h2Heaviness * wH + cppHeaviness * wC) / total);
}

export function computeAttackHardness({ risePeak = 0, riseCeiling = 0.5, cleanliness = 1, onsetAbruptness = 0.5, abruptWeight = 0 }) {
  const ceil = Math.max(0.02, riseCeiling);
  const riseHardness = clamp01(risePeak / ceil);
  const wA = clamp01(abruptWeight);
  const combined = riseHardness * (1 - wA) + clamp01(onsetAbruptness) * wA;
  return clamp01(combined * (0.5 + 0.5 * clamp01(cleanliness)));
}

// ====== PERCEIVED-GENDER SCORE ======
// Perceived vocal gender is driven by BOTH fundamental pitch (F0) AND vocal-tract
// resonance (formants). Pitch alone misreads cases like a deep-voiced singer hitting
// high notes — high F0 but masculine resonance. We blend a normalized pitch with the
// resonance score (smoothResonance, already F1/F2/F3-based), and let confidence shift
// the balance: trust resonance more when formants are confident, trust pitch less when
// the pitch estimate is weak. When both cues are unreliable the score collapses toward
// 0.5 (androgynous) so noise reads as neutral rather than flickering between extremes.
//
// Returns 0..1: 0 = clearly masculine, 0.5 = androgynous/ambiguous, 1 = clearly feminine.
export function computeGenderScore({
  pitchHz = 0,
  resonance = 0.5,
  pitchConfidence = 0,
  formantConfidence = 0,
  pitchMinHz = 110,
  pitchMaxHz = 220,
} = {}) {
  const pitchNorm = pitchHz > 0
    ? normalizeAgainstRange(pitchHz, pitchMinHz, pitchMaxHz)
    : 0.5;
  const resNorm = clamp01(resonance);

  const pc = clamp01(pitchConfidence);
  const fc = clamp01(formantConfidence);

  // Base weights ~0.5/0.5, then scale each cue by its confidence so unreliable
  // cues defer to the confident one. Resonance gets a slight intrinsic edge — it is
  // the harder-to-fake gender cue and the whole point of this mode.
  const wPitch = 0.5 * (0.35 + 0.65 * pc);
  const wRes = 0.5 * (0.35 + 0.65 * fc) * 1.1;
  const totalW = wPitch + wRes;

  const blended = totalW > 1e-6
    ? (pitchNorm * wPitch + resNorm * wRes) / totalW
    : 0.5;

  // Collapse toward 0.5 when overall confidence is low.
  const overallConf = clamp01(Math.max(pc, fc));
  const score = 0.5 + (blended - 0.5) * overallConf;
  return clamp01(score);
}

// Map a 0..1 perceived-gender score to a hue.
// Normal palette: blue 210 (masculine) -> purple ~275 (androgynous/nonbinary center) -> pink 340 (feminine).
// Colorblind palette: luminance-mapped blue 220 -> yellow 55, paralleling the pitch-mode CB ramp.
export function genderScoreToHue(score, colorblind = false) {
  const s = clamp01(score);
  if (colorblind) {
    return 220 - s * 165; // 220 (blue) -> 55 (yellow)
  }
  return 210 + s * 130; // 210 (blue) -> 275 (purple) -> 340 (pink)
}

// ====== MULTI-CUE PERCEIVED-GENDER MODEL ======
// Each acoustic cue produces a 0..1 femininity value plus a 0..1 confidence. The combiner
// blends only ENABLED cues, weighting each by base*confidence. It also reports an uncertainty
// that rises with low confidence AND with cue disagreement, and shrinks the score toward 0.5
// (androgynous) as uncertainty rises. Cue anchors below come from voice-science norms
// (Hillenbrand 1995; Fitch 1997; Gelfer 2000; sibilant CoG literature).

// Goal-specific cue weights.
// - Dispersion and CPP are absorbed into Resonance and Weight respectively, so they
//   are no longer standalone cues in the combiner.
// - pitchZone replaces modalF0 + pitch: it is the absolute F0 position (110–230 Hz → 0–1),
//   computed from modal F0 so it reflects habitual pitch, not a momentary note.
// - weight (vocal heaviness/breathiness) is now a scored gender cue, not just biofeedback.
export const FEMINIZATION_CUE_WEIGHTS = {
  resonance: 0.35,  // aVTL-primary, vowel-robust
  pitchZone: 0.30,  // absolute F0 position; necessary but not sufficient
  weight: 0.15,     // lower weight (breathier) = more feminine
  sibilant: 0.10,   // /s/ COG; higher = more feminine
  intonation: 0.10, // ST variance; contested cue, kept low
};

export const MASCULINIZATION_CUE_WEIGHTS = {
  pitchZone: 0.40,  // F0 is the dominant transmasculine cue (T passively lowers it)
  resonance: 0.30,  // aVTL
  weight: 0.15,     // higher weight (pressed/modal) = more masculine
  intonation: 0.10,
  sibilant: 0.05,   // /s/ stays fronted despite testosterone; never penalise a high /s/
};

// Legacy alias — used by code that doesn't specify a goal.
export const DEFAULT_GENDER_CUE_WEIGHTS = FEMINIZATION_CUE_WEIGHTS;

// Modal (median) F0 over a voiced window -> femininity. Habitual pitch, not a momentary note.
// Anchors: male ~110 Hz, androgynous ~165 Hz, female ~220 Hz.
export function computeModalF0Femininity(medianHz, { min = 110, max = 220 } = {}) {
  if (!(medianHz > 0)) return 0.5;
  return normalizeAgainstRange(medianHz, min, max);
}

// Center-of-gravity (spectral centroid) over a magnitude band, in Hz. Returns 0 if no energy.
export function computeSpectralCentroid(magnitudes, binHz, loHz = 0, hiHz = Infinity) {
  if (!magnitudes || magnitudes.length === 0 || !(binHz > 0)) return 0;
  const startBin = Math.max(0, Math.floor(loHz / binHz));
  const endBin = Math.min(magnitudes.length - 1, Math.ceil(hiHz / binHz));
  let num = 0, den = 0;
  for (let i = startBin; i <= endBin; i++) {
    const m = magnitudes[i];
    if (m <= 0) continue;
    num += i * binHz * m;
    den += m;
  }
  return den > 0 ? num / den : 0;
}

// Sibilant /s/ centroid -> femininity. Higher CoG = shorter front cavity = feminine.
// Anchors: male ~4 kHz (deep /s/ sits here), female ~8.5 kHz.
// Widened from 5–8 kHz to capture masculine /s/ that sits below 5 kHz.
export function computeSibilantFemininity(centroidHz, { min = 4000, max = 8500 } = {}) {
  if (!(centroidHz > 0)) return 0.5;
  return normalizeAgainstRange(centroidHz, min, max);
}

// Mean adjacent formant spacing (dispersion, ΔF) from F1..Fn. Proxy for vocal-tract length.
export function computeFormantDispersion(formants) {
  if (!Array.isArray(formants)) return 0;
  const f = formants.filter((x) => x > 0);
  if (f.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < f.length; i++) sum += f[i] - f[i - 1];
  return sum / (f.length - 1);
}

// Formant dispersion -> femininity. Wider spacing = shorter tract = feminine.
// Anchors: male spacing ~900 Hz, female ~1200 Hz.
export function dispersionToFemininity(meanSpacingHz, { min = 900, max = 1200 } = {}) {
  if (!(meanSpacingHz > 0)) return 0.5;
  return normalizeAgainstRange(meanSpacingHz, min, max);
}

// Apparent vocal-tract length (cm) from mean formant spacing. c ~ 35000 cm/s in vocal tract.
export function dispersionToVtlCm(meanSpacingHz, c = 35000) {
  if (!(meanSpacingHz > 0)) return 0;
  return c / (2 * meanSpacingHz);
}

// Real cepstrum of a log-magnitude half-spectrum (length M, bins 0..Nyquist) via a type-I DCT.
// Returns c[q], q=0..maxQuefrency, where quefrency index q is a lag in samples at the original
// sampleRate. maxQuefrency bounds cost (the full transform is O(M^2)); only quefrencies up to the
// lowest F0 of interest are needed for CPP, so callers cap it (e.g. sampleRate/55 Hz).
export function computeCepstrum(logMag, maxQuefrency = logMag.length - 1) {
  const M = logMag.length;
  const denom = M - 1;
  const qMax = Math.min(maxQuefrency, denom);
  const cep = new Float64Array(qMax + 1);
  if (denom <= 0) return cep;
  for (let q = 0; q <= qMax; q++) {
    let sum = logMag[0] + (q % 2 === 0 ? logMag[denom] : -logMag[denom]);
    for (let k = 1; k < denom; k++) {
      sum += 2 * logMag[k] * Math.cos((Math.PI * q * k) / denom);
    }
    cep[q] = sum / (2 * denom);
  }
  return cep;
}

// Cepstral Peak Prominence: height of the cepstral peak near quefrency q0 above the
// least-squares regression line fit across the cepstrum. Higher CPP = more periodic (less breathy).
export function computeCPP(cepstrum, q0, { minQuefrency = 2, searchRadius = 0 } = {}) {
  const M = cepstrum.length;
  if (!(q0 > minQuefrency) || q0 >= M) return 0;
  // Least-squares line over [minQuefrency, M-1].
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let q = minQuefrency; q < M; q++) {
    const y = cepstrum[q];
    n++; sx += q; sy += y; sxx += q * q; sxy += q * y;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  // Peak in a window around q0.
  const radius = searchRadius > 0 ? searchRadius : Math.max(2, Math.round(q0 * 0.1));
  const lo = Math.max(minQuefrency, Math.floor(q0 - radius));
  const hi = Math.min(M - 1, Math.ceil(q0 + radius));
  let peakV = -Infinity, peakQ = lo;
  for (let q = lo; q <= hi; q++) {
    if (cepstrum[q] > peakV) { peakV = cepstrum[q]; peakQ = q; }
  }
  const baseline = intercept + slope * peakQ;
  return Math.max(0, peakV - baseline);
}

// CPP -> femininity. Lower CPP (breathier) reads more feminine, so invert.
// Anchors: breathy ~6, modal ~14 (in the cepstrum's log-mag units, which track dB).
export function cppToFemininity(cppDb, { min = 6, max = 14 } = {}) {
  return 1 - normalizeAgainstRange(cppDb, min, max);
}

// ====== VOICE MAP (2D pitch × resonance plane) ======
// Presentation-layer helpers (Layer B in docs/DSP_CONTRACT.md) for the Voice Map card: a
// constellation-style view of the session on the pitch (log-Hz, Y) × resonance (VTL score, X)
// plane. Pure + unit-tested (voice-map.test.mjs) so the mapping math stays portable.

// Log-frequency position: perceptually linear in semitones, so equal vertical steps are equal
// musical intervals. A linear-Hz axis crushes the low (masculine) half of the range into a
// sliver while stretching the top; log spacing gives both halves equal visual resolution.
export function pitchHzToLogPosition(hz, minHz = 80, maxHz = 400) {
  if (!(hz > 0)) return 0;
  const lo = Math.log2(minHz);
  const span = Math.log2(maxHz) - lo;
  return clamp01((Math.log2(hz) - lo) / Math.max(1e-6, span));
}

// Summarize a session cloud of {hz, res, w} samples (w = per-frame confidence weight, so
// shaky frames shape the home zone less than confident ones). Pitch statistics live in the
// log domain — the mean is a geometric mean in Hz and the spread is in semitones — so a
// wobbly low voice and a wobbly high voice report comparable spread. Returns null when empty.
export function summarizeVoiceCloud(points) {
  const pts = Array.isArray(points) ? points.filter((p) => p && p.hz > 0) : [];
  const n = pts.length;
  if (n === 0) return null;
  let wSum = 0, logSum = 0, resSum = 0;
  for (const p of pts) {
    const w = Math.max(1e-6, p.w != null ? p.w : 1);
    wSum += w;
    logSum += Math.log2(p.hz) * w;
    resSum += clamp01(p.res) * w;
  }
  const meanLog = logSum / wSum;
  const meanRes = resSum / wSum;
  let varLog = 0, varRes = 0;
  for (const p of pts) {
    const w = Math.max(1e-6, p.w != null ? p.w : 1);
    const dl = Math.log2(p.hz) - meanLog;
    const dr = clamp01(p.res) - meanRes;
    varLog += dl * dl * w;
    varRes += dr * dr * w;
  }
  const mid = (arr) => (arr.length % 2
    ? arr[(arr.length - 1) / 2]
    : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2);
  return {
    n,
    meanHz: Math.pow(2, meanLog),                    // geometric mean
    sdSemitones: Math.sqrt(varLog / wSum) * 12,      // log2-octaves → semitones
    meanRes,
    sdRes: Math.sqrt(varRes / wSum),
    medianHz: mid(pts.map((p) => p.hz).sort((a, b) => a - b)),
    medianRes: mid(pts.map((p) => clamp01(p.res)).sort((a, b) => a - b)),
  };
}

// Fit a personal min/max range from a sample set for adaptive (per-user) normalization.
// Uses a robust loPct–hiPct percentile band (default p05–p95, so octave-jump / outlier frames
// don't set the ends), enforces a minimum spread so a monotone speaker can't collapse the
// scale to a point, then pads outward by `pad`×spread so the observed range lands in the middle
// of the meter and leaves headroom to push past it. Clamped to [absMin, absMax]. Returns null
// on empty input. Pure + unit-tested so the pitch/tilt/resonance learners share one definition.
export function fitPersonalRange(values, {
  floorSpread = 0, absMin = -Infinity, absMax = Infinity, pad = 0.25, loPct = 0.05, hiPct = 0.95,
} = {}) {
  const sorted = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
  const lo = at(loPct);
  const hi = at(hiPct);
  // Expand the observed band symmetrically up to floorSpread, then pad outward. Doing the
  // floor on the *base band* (not just the padding term) is what guarantees a monotone speaker
  // gets a full floorSpread-wide usable range instead of a sliver; identical to lo±pad when the
  // real spread already exceeds the floor.
  const mid = (lo + hi) / 2;
  const spread = Math.max(floorSpread, hi - lo);
  const half = spread / 2;
  return {
    min: Math.max(absMin, mid - half - spread * pad),
    max: Math.min(absMax, mid + half + spread * pad),
  };
}

// Build a personal min/max range from two DELIBERATE extreme sample sets — the user's darkest
// and brightest held sounds during a guided setup. Unlike fitPersonalRange (which infers a range
// from ambient speech and pads outward for headroom), here the user intentionally produced the
// ends, so the medians ARE the ends: we take the median of each set, order them (a swap-guard in
// case the estimator read the "dark" sound higher), enforce a minimum spread, and pad only
// slightly so hitting the exact extreme reads as 0/100 rather than clipping. Returns null if
// either set is empty. Pure + unit-tested.
export function rangeFromExtremeSamples(darkVals, brightVals, {
  minSpread = 0, pad = 0.05, absMin = -Infinity, absMax = Infinity,
} = {}) {
  const median = (vals) => {
    const s = (Array.isArray(vals) ? vals : []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (s.length === 0) return null;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  let lo = median(darkVals);
  let hi = median(brightVals);
  if (lo == null || hi == null) return null;
  if (lo > hi) { const t = lo; lo = hi; hi = t; } // swap-guard: "dark" read brighter than "bright"
  const spread = Math.max(minSpread, hi - lo);
  const mid = (lo + hi) / 2;
  const half = spread / 2;
  return {
    min: Math.max(absMin, mid - half - spread * pad),
    max: Math.min(absMax, mid + half + spread * pad),
  };
}

// Derive a personal practice zone from the user's own vibration-alert rules — the map's target
// region comes from the user's configured goals, not a normative template. "Drops below T"
// means the user wants to stay ABOVE T (T becomes the zone floor); "goes above T" caps it.
// Resonance thresholds are configured as 0–100%, returned normalized to 0..1. An axis with no
// rule (or a contradictory pair) stays unbounded (null); returns null when nothing bounds the map.
export function voiceMapZoneFromRules(rules) {
  if (!Array.isArray(rules)) return null;
  let pitchMinHz = null, pitchMaxHz = null, resMin = null, resMax = null;
  for (const r of rules) {
    if (!r || !Number.isFinite(r.threshold)) continue;
    if (r.metric === 'pitch') {
      if (r.direction === 'below') pitchMinHz = Math.max(pitchMinHz ?? -Infinity, r.threshold);
      else if (r.direction === 'above') pitchMaxHz = Math.min(pitchMaxHz ?? Infinity, r.threshold);
    } else if (r.metric === 'resonance') {
      const t = clamp01(r.threshold / 100);
      if (r.direction === 'below') resMin = Math.max(resMin ?? -Infinity, t);
      else if (r.direction === 'above') resMax = Math.min(resMax ?? Infinity, t);
    }
  }
  if (pitchMinHz != null && pitchMaxHz != null && pitchMinHz >= pitchMaxHz) { pitchMinHz = null; pitchMaxHz = null; }
  if (resMin != null && resMax != null && resMin >= resMax) { resMin = null; resMax = null; }
  if (pitchMinHz == null && pitchMaxHz == null && resMin == null && resMax == null) return null;
  return { pitchMinHz, pitchMaxHz, resMin, resMax };
}

// Combine per-cue {value, confidence} into a final 0..1 score plus an uncertainty (0..1).
// enabledMap[id] must be truthy for a cue to contribute (absent => disabled).
// goalMode: 'feminization' | 'masculinization' (default 'feminization').
// modalF0Hz: current modal F0 in Hz, used for ambiguous-zone dynamic reweighting.
export function computeGenderScoreMulti({
  cues = {},
  weights = DEFAULT_GENDER_CUE_WEIGHTS,
  enabledMap = {},
  goalMode = 'feminization',
  modalF0Hz = 0,
} = {}) {
  // Work on a mutable copy so dynamic reweighting doesn't mutate the caller's object.
  const w = Object.assign({}, weights);

  // Dynamic reweighting in the ambiguous pitch zone (145–175 Hz):
  // when pitch doesn't reliably signal gender, shift weight toward resonance + weight.
  if (modalF0Hz > 145 && modalF0Hz < 175 && w.pitchZone != null) {
    const ambig = 1 - Math.abs(modalF0Hz - 160) / 15; // 0..1, peaks at 160 Hz
    const transfer = w.pitchZone * 0.5 * ambig;
    w.pitchZone -= transfer;
    if (w.resonance != null) w.resonance += transfer * 0.6;
    if (w.weight != null) w.weight += transfer * 0.4;
  }

  let sumW = 0, sumWV = 0, sumWC = 0;
  const contribs = [];
  for (const id of Object.keys(cues)) {
    if (!enabledMap[id]) continue;
    const cue = cues[id];
    if (!cue) continue;
    const value = clamp01(cue.value);
    const conf = clamp01(cue.confidence);
    const base = w[id] != null ? w[id] : 0;
    const cueW = base * conf;
    if (cueW <= 0) continue;
    sumW += cueW;
    sumWV += cueW * value;
    sumWC += cueW * conf;
    contribs.push({ w: cueW, value, id });
  }
  if (sumW <= 1e-6) return { score: 0.5, uncertainty: 1 };
  let blended = sumWV / sumW;

  // Incongruence guard (feminization): high absolute pitch + masculine resonance is a
  // "male falsetto" pattern — high F0 alone must not yield a fully-feminine reading.
  if (goalMode === 'feminization') {
    const pitchCue = cues.pitchZone;
    const resCue = cues.resonance;
    if (pitchCue && resCue) {
      const pitchPull = clamp01(pitchCue.value) * clamp01(pitchCue.confidence);
      const resonancePull = clamp01(resCue.value) * clamp01(resCue.confidence);
      if (pitchPull > 0.7 && resonancePull < 0.35) {
        const guard = 0.5 + resonancePull * 0.5;
        blended = Math.min(blended, guard);
      }
    }
  }

  let varAcc = 0;
  for (const c of contribs) varAcc += c.w * (c.value - blended) * (c.value - blended);
  const disagreement = Math.sqrt(varAcc / sumW);
  const meanConf = sumWC / sumW;
  // Keep the confidence term strong so genuinely low-confidence frames still collapse toward 0.5
  // (purple). Soften the disagreement penalty, and apply a mild decisiveness gain on the
  // deviation so confident, agreeing voices lean further toward the blue/pink ends instead of
  // stalling near purple. The gain multiplies (1 - uncertainty), so it has no effect when
  // uncertainty is high — low-confidence voices stay neutral.
  const uncertainty = clamp01((1 - meanConf) * 0.9 + disagreement * 0.9);
  const DECISIVENESS = 1.2;
  const score = clamp01(0.5 + (blended - 0.5) * (1 - uncertainty) * DECISIVENESS);
  return { score, uncertainty };
}
