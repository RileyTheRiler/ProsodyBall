export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function computeRawProsody(metrics, preset = null) {
  const wBounce = preset ? preset.bounce : 0.50;
  const wVowel = preset ? preset.vowel : 0.30;
  const wArtic = preset ? preset.artic : 0.20;
  return (
    metrics.bounce * wBounce +
    metrics.vowel * wVowel +
    metrics.articulation * wArtic
  );
}

export function smoothToward(current, target, factor) {
  return current + (target - current) * factor;
}

export function computeProsodyScore(previous, metrics, preset = null, smoothing = 0.12) {
  const raw = computeRawProsody(metrics, preset);
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

export function computeFrameReliability({ pitchConfidence = 0, formantConfidence = 0, voicedStrength = 0, spectralTiltConfidence = 0, wasLastFrameReliable = false }) {
  const confidenceGate = clamp01(Math.max(0.2, pitchConfidence * 0.55 + formantConfidence * 0.25 + spectralTiltConfidence * 0.2));
  const voicedGate = clamp01(Math.max(0.25, voicedStrength * 0.75 + pitchConfidence * 0.25));

  let reliableFrame;
  if (wasLastFrameReliable) {
    reliableFrame = (pitchConfidence > 0.25 || formantConfidence > 0.30) && voicedStrength > 0.15;
  } else {
    reliableFrame = (pitchConfidence > 0.35 || formantConfidence > 0.40) && voicedStrength > 0.25;
  }

  return { confidenceGate, voicedGate, reliableFrame };
}

export function computeWeightTarget({ tiltHeaviness = 0.5, tiltWeight = 1, h1h2Heaviness = 0.5, h1h2Weight = 0, f2Heaviness = 0.5, f2Weight = 0 }) {
  const wT = Math.max(0, tiltWeight);
  const wH = Math.max(0, h1h2Weight);
  const wF = Math.max(0, f2Weight);
  const total = wT + wH + wF;
  if (total <= 0) return clamp01(tiltHeaviness);
  return clamp01((tiltHeaviness * wT + h1h2Heaviness * wH + f2Heaviness * wF) / total);
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

// Base weights per cue id. Resonance + modal pitch dominate (hardest to fake); breathiness
// and the stereotype-based intonation cue contribute least.
export const DEFAULT_GENDER_CUE_WEIGHTS = {
  resonance: 0.30,
  modalF0: 0.26,
  dispersion: 0.16,
  pitch: 0.10,
  sibilant: 0.10,
  cpp: 0.08,
  intonation: 0.08,
};

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
// Anchors: male ~5 kHz, female ~8 kHz.
export function computeSibilantFemininity(centroidHz, { min = 5000, max = 8000 } = {}) {
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

// Combine per-cue {value, confidence} into a final 0..1 score plus an uncertainty (0..1).
// enabledMap[id] must be truthy for a cue to contribute (absent => disabled).
export function computeGenderScoreMulti({
  cues = {},
  weights = DEFAULT_GENDER_CUE_WEIGHTS,
  enabledMap = {},
} = {}) {
  let sumW = 0, sumWV = 0, sumWC = 0;
  const contribs = [];
  for (const id of Object.keys(cues)) {
    if (!enabledMap[id]) continue;
    const cue = cues[id];
    if (!cue) continue;
    const value = clamp01(cue.value);
    const conf = clamp01(cue.confidence);
    const base = weights[id] != null ? weights[id] : 0;
    const w = base * conf;
    if (w <= 0) continue;
    sumW += w;
    sumWV += w * value;
    sumWC += w * conf;
    contribs.push({ w, value });
  }
  if (sumW <= 1e-6) return { score: 0.5, uncertainty: 1 };
  const blended = sumWV / sumW;
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
