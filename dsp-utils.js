import * as DSP_CONST from './dsp-constants.generated.js';

// Security enhancement: Sanitize untrusted or dynamic URLs to prevent DOM-based XSS.
export function sanitizeUrl(urlStr) {
  if (!urlStr) return 'about:blank';
  const str = String(urlStr).trim();
  let parsed;
  try {
    parsed = new URL(str);
  } catch (e) {
    try {
      parsed = new URL(str, 'http://localhost');
      if (str.match(/^[a-zA-Z0-9+.-]+:/) || str.startsWith('://')) {
        return 'about:blank';
      }
    } catch (e2) {
      return 'about:blank';
    }
  }

  const protocol = parsed.protocol.toLowerCase();
  const safeProtocols = ['http:', 'https:', 'mailto:', 'tel:', 'blob:', 'file:'];
  if (!safeProtocols.includes(protocol)) {
    return 'about:blank';
  }

  return str;
}

export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
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

// Shared confidence assembly for the four resonance estimators.
//
// Each estimator measures "how much formant structure is in this frame" in its own currency:
// harmonic/cepstral use peak prominence against the envelope's dynamic range, LPC uses pole
// bandwidth, centroid uses spectral concentration. Those numbers are NOT comparable — measured
// on clean read speech the same frame scored ~0.69 (harmonic), ~0.33 (LPC before its ad-hoc
// ×2.5), ~0.70 (cepstral) and ~0.23 (centroid). They all fed one `formantConfidence` and the
// same downstream gates, so switching estimator silently changed how much the app trusted
// itself: the centroid could not clear even the 0.2 display gate, which left the whole
// resonance readout frozen for anyone the SNR ladder routed to it.
//
// `gain` maps each estimator's native structure measure onto the shared scale, and is the ONLY
// place that calibration lives. Between-method *precision* is expressed once, separately, by
// the Kalman measurement-noise trust factor — previously precision was double-counted here and
// there, inconsistently and in opposite directions.
export function formantEstimateConfidence({
  structure = 0,          // 0..1, method-native "formant structure present" measure
  gain = 1,               // per-method calibration onto the shared scale
  pitchConfidence = 0,    // periodicity — no periodicity, no formant estimate worth having
  vowelLikelihood = 0,    // vowel-like spectra are where formants are measurable
} = {}) {
  const s = Math.max(0, structure) * Math.max(0, gain);
  return clamp01(s * clamp01(pitchConfidence) * (clamp01(vowelLikelihood) + 0.3));
}

// SNR-driven resonance-method selection for the 'auto' mode. Each of the four estimators
// degrades differently in noise: LPC root-solving is most precise in clean signal but its
// roots get unstable as noise rises; the cepstral envelope is smoother/more robust mid-SNR;
// the spectral centroid is the most noise-tolerant (no peak-picking) when SNR collapses.
// `current` + `hysteresisDb` add switching hysteresis. Without it the thresholds are exact
// equalities, so an SNR sitting on a tier edge — which is precisely what an ordinary room does
// — flips the estimator every frame. The estimators do not agree perfectly (each carries its
// own bias), so every flip is a visible step in the reported resonance that the speaker did
// nothing to cause. Requiring the SNR to clear a threshold by a margin before switching turns
// that chatter into a single deliberate handover. Called without `current` it is the plain
// memoryless mapping, which is what the golden/unit tests pin.
export function selectResonanceMethod(snrDb, { greenDb = SNR_GREEN_DB, yellowDb = SNR_YELLOW_DB, hysteresisDb = 2, current = null } = {}) {
  const plain = snrDb >= greenDb ? 'lpc'      // clean: root-solved precision
    : snrDb >= yellowDb ? 'cepstral'          // moderate noise: smooth, robust
    : 'centroid';                             // heavy noise: most noise-tolerant
  if (!current || current === plain) return plain;
  const h = Math.max(0, hysteresisDb);
  if (h === 0) return plain;
  // Hold the incumbent until the SNR clears the boundary it would have to cross by `h` dB.
  const rank = { centroid: 0, cepstral: 1, lpc: 2 };
  if (rank[current] === undefined) return plain;
  if (rank[plain] > rank[current]) {
    // Promoting (cleaner): require SNR above the upper edge of the incumbent's band + margin.
    const edge = current === 'centroid' ? yellowDb : greenDb;
    return snrDb >= edge + h ? plain : current;
  }
  // Demoting (noisier): require SNR below the lower edge of the incumbent's band - margin.
  const edge = current === 'lpc' ? greenDb : yellowDb;
  return snrDb <= edge - h ? plain : current;
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
  // cues defer to the confident one. Resonance carries a slight intrinsic edge (×1.1).
  // PROVISIONAL: that edge is a product choice — resonance is what this mode is built to
  // train — not an evidence-derived weighting. F0 is the strongest single predictor of
  // perceived gender in the literature, so the edge is not justified by accuracy, and it
  // is not a claim that resonance is harder to fake or falsify.
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
//
// PROVISIONAL HEURISTICS — not evidence-derived. These numbers were chosen by hand to feel
// right in the app; no listener-rating study, regression, or published weighting produced
// them, and none of them has been validated against perceived gender. Treat them as a
// starting configuration, not as a finding.
//
// What the evidence does say: **F0 is the strongest single predictor of perceived gender**,
// across both the 2018 meta-analysis and the 2025 review. It is necessary but not sufficient
// — Hillenbrand & Clark found that shifting F0 *or* formants alone was usually ineffective
// while both together reached ~82% — but nothing in that literature supports ranking a
// formant-derived cue *above* F0. The feminization ordering below (resonance 0.35 >
// pitchZone 0.30) is therefore **unsupported**: it inverts the one ordering the evidence is
// clear about. It is left in place here because Phase 0 changes no numbers; re-deriving the
// weights from published norms is Phase 4 work (see docs/RESONANCE_REDESIGN.md §3.3, which
// also explains why fitting them to listener ratings is out of reach for a client-side,
// no-data-collection app).
//
// Structure notes:
// - Dispersion and CPP are absorbed into Resonance and Weight respectively, so they
//   are no longer standalone cues in the combiner.
// - pitchZone replaces modalF0 + pitch: it is the absolute F0 position (110–230 Hz → 0–1),
//   computed from modal F0 so it reflects habitual pitch, not a momentary note.
// - weight (vocal heaviness/breathiness) is now a scored gender cue, not just biofeedback.
export const FEMINIZATION_CUE_WEIGHTS = {
  resonance: 0.35,  // aVTL-primary; provisional, and ranked above F0 without support
  pitchZone: 0.30,  // absolute F0 position; the best-evidenced single cue, necessary not sufficient
  weight: 0.15,     // lower weight (breathier) = more feminine
  sibilant: 0.10,   // /s/ COG; higher = more feminine
  intonation: 0.10, // ST variance; contested cue, kept low
};

export const MASCULINIZATION_CUE_WEIGHTS = {
  pitchZone: 0.40,  // F0 is the dominant transmasculine cue (T passively lowers it)
  resonance: 0.30,  // aVTL; provisional
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
//
// ARRAY POSITION IS THE FORMANT NUMBER. `formants[i]` is F(i+1); a 0/NaN entry means that
// formant was not measured this frame, NOT that the list is shorter. This distinction is the
// whole point: the previous implementation compacted the array and took (last-first)/(count-1),
// so a dropped F2 in [F1, 0, F3] was read as two *adjacent* formants and returned F3-F1 —
// exactly double the true spacing, which halves the apparent vocal-tract length and pins the
// resonance score at "maximally feminine" off a single dropout. It also ignored F2 entirely
// whenever all three were present, leaving the app's primary resonance driver hostage to F3,
// the least reliably estimated of the three.
//
// Instead, fit the uniform-tube model F_i = (2i-1)·ΔF/2 (Fitch/Reby) by least squares through
// the origin over whichever formants are present:
//
//     ΔF = Σ(x_i · F_i) / Σ(x_i²),  x_i = (2i-1)/2
//
// This uses every measured formant, weights them by the model's own leverage, degrades
// gracefully when one is missing (the surviving formants keep their true slot numbers), and
// on ideal data agrees exactly with the mean-adjacent-spacing definition. Against independent
// per-formant error it carries roughly a quarter of the endpoint estimator's variance.
export function computeFormantDispersion(formants) {
  return fitFormantDispersion(formants).deltaF;
}

// Full fit behind computeFormantDispersion: the ΔF estimate plus the diagnostics needed to
// tell a trustworthy reading from a lucky one. `n` is how many formants were actually
// measured; `residualHz` is the RMS deviation of those formants from the fitted uniform-tube
// series, and `fitQuality` maps it to 0..1 (1 = the formants sit exactly on the model).
// A frame whose formants don't fit a tube at all is a frame whose ΔF means nothing, so
// callers fold fitQuality into confidence rather than trusting every ΔF equally.
export function fitFormantDispersion(formants, { residualToleranceHz = 350 } = {}) {
  const empty = { deltaF: 0, n: 0, residualHz: 0, fitQuality: 0 };
  if (!Array.isArray(formants)) return empty;
  let sxy = 0, sxx = 0, n = 0;
  for (let i = 0; i < formants.length; i++) {
    const f = formants[i];
    if (!(f > 0)) continue;          // 0/NaN/undefined = this formant was not measured
    const x = (2 * (i + 1) - 1) / 2; // F1 -> 0.5, F2 -> 1.5, F3 -> 2.5, ...
    sxy += x * f;
    sxx += x * x;
    n++;
  }
  // One formant cannot distinguish tract length from vowel identity — F1 alone is mostly a
  // statement about jaw opening. Require two.
  if (n < 2 || sxx <= 0) return empty;
  const deltaF = sxy / sxx;
  let sq = 0;
  for (let i = 0; i < formants.length; i++) {
    const f = formants[i];
    if (!(f > 0)) continue;
    const predicted = ((2 * (i + 1) - 1) / 2) * deltaF;
    const d = f - predicted;
    sq += d * d;
  }
  const residualHz = Math.sqrt(sq / n);
  const fitQuality = clamp01(1 - residualHz / Math.max(1e-6, residualToleranceHz));
  return { deltaF, n, residualHz, fitQuality };
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

// Summarize per-clip metric samples captured during recording (one sample per recorder tick:
// { hz, conf, voiced, res, prosody }). Only samples that are voiced with a confident pitch
// (voiced && hz > 0 && conf >= minConf) contribute to the stats, so silence, coughs, and
// shaky frames can't skew a take's numbers. Returns null when fewer than minVoiced samples
// qualify — the UI renders that as "no voice data" instead of junk stats. Values are left
// unrounded; formatting is a render-time concern. Pure + unit-tested (clip-metrics.test.mjs).
//
// RESONANCE IS AVERAGED OVER ITS OWN DENOMINATOR, and that is a Phase 4 correction rather than
// a refinement. `voiced` is a PITCH judgement — the frame had a periodic source — and since
// Phase 4 the resonance reading can be absent on a frame that is unambiguously voiced: 11.4% of
// clean read speech, 36.9% at 12 dB (docs/RESONANCE_REDESIGN.md §5, Phase 4). Folding those in
// as `res = 0` would drag a take's resonance average toward the dark end in proportion to how
// noisy the room was, which is the substituted-value failure D1 names, arriving through an
// arithmetic default instead of through a fallback estimator.
//
// `resonanceAvg` is therefore null, not 0, when the clip produced no resonance reading at all —
// the same rule the live path follows, for the same reason. `resonanceSamples` is returned so a
// caller can say "over 40 of 55 voiced frames" rather than implying the average covers the whole
// take.
export function summarizeClipMetrics(samples, { minConf = 0.35, minVoiced = 5 } = {}) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  let voicedCount = 0;
  let pitchSum = 0, pitchMin = Infinity, pitchMax = -Infinity;
  let resSum = 0, resCount = 0, prosodySum = 0;
  for (const s of samples) {
    if (!s || !s.voiced || !(s.hz > 0) || !(s.conf >= minConf)) continue;
    voicedCount++;
    pitchSum += s.hz;
    if (s.hz < pitchMin) pitchMin = s.hz;
    if (s.hz > pitchMax) pitchMax = s.hz;
    if (Number.isFinite(s.res)) { resSum += clamp01(s.res); resCount++; }
    prosodySum += clamp01(Number.isFinite(s.prosody) ? s.prosody : 0);
  }
  if (voicedCount < Math.max(1, minVoiced)) return null;
  return {
    pitchAvgHz: pitchSum / voicedCount,
    pitchMinHz: pitchMin,
    pitchMaxHz: pitchMax,
    resonanceAvg: resCount > 0 ? resSum / resCount : null,
    resonanceSamples: resCount,
    prosodyAvg: prosodySum / voicedCount,
    voicedRatio: voicedCount / samples.length,
    sampleCount: samples.length,
  };
}

// ============================================================
// PHRASE TAKE ANALYSIS (word-by-word)
// The practice flow records the user reading a KNOWN phrase. No ASR is available in the
// sandboxed iframe, so word-level stats come from signal-driven segmentation instead:
// the per-tick metric snapshots ({ hz, conf, voiced, res, prosody, energy, syl }) are
// split into speech runs at energy dips, the runs are aligned to the phrase's words,
// and each word slice is summarized with the same gates as whole-clip metrics.
// All pure + unit-tested (phrase-analysis.test.mjs).
// ============================================================

// Segmentation tuning. Web-only (not in dsp-constants.json — that file is reserved for
// constants shared with the kotlin/cpp ports). onMult is deliberately lower than the live
// syllable detector's SYLLABLE_ON_MULT (0.6): we want whole word envelopes, not nuclei.
export const PHRASE_SEG_DEFAULTS = {
  onMult: 0.35,        // energy-range multiplier for the run-entry threshold
  offMult: 0.12,       // hysteresis exit threshold (lower → runs survive mid-word dips)
  minGapSec: 0.12,     // gaps shorter than this are intra-word stop closures (/t/, /k/) → merge
  minRunSec: 0.09,     // shorter runs are dropped unless loud or voiced (clicks, breaths)
  minEnergyRange: 0.003, // minimum p90−floor spread so near-silence can't produce hair-trigger thresholds
  minConf: 0.35,       // pitch-confidence gate for treating a frame as voiced (matches summarizeClipMetrics)
};

// Split per-tick snapshots into speech runs. Thresholds are self-calibrating from the take's
// own energy percentiles (p20 floor, p90 ceiling) because the analyzer may be uncalibrated
// when recording starts; an explicit noiseFloor only ever raises the floor. A frame opens a
// run when its energy clears the on-threshold (or it is confidently voiced — quiet but voiced
// tails belong to the word), stays in the run while it clears the lower off-threshold
// (hysteresis), and the run closes on the first frame that does neither. Runs separated by
// sub-minGapSec gaps are merged; tiny quiet unvoiced runs are pruned. Frame times are
// index × tickSec (sample-exact against the encoded WAV — setInterval wall-clock jitter
// never enters the timeline).
export function segmentSpeechRuns(samples, {
  tickSec = 512 / 44100,
  noiseFloor = 0,
  onMult = PHRASE_SEG_DEFAULTS.onMult,
  offMult = PHRASE_SEG_DEFAULTS.offMult,
  minGapSec = PHRASE_SEG_DEFAULTS.minGapSec,
  minRunSec = PHRASE_SEG_DEFAULTS.minRunSec,
  minEnergyRange = PHRASE_SEG_DEFAULTS.minEnergyRange,
  minConf = PHRASE_SEG_DEFAULTS.minConf,
} = {}) {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const energy = samples.map((s) => (s && Number.isFinite(s.energy) ? s.energy : 0));
  const sorted = [...energy].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
  const floor = Math.max(noiseFloor, at(0.2));
  const range = Math.max(at(0.9) - floor, minEnergyRange);
  const on = floor + range * onMult;
  const off = floor + range * offMult;
  const isVoiced = (i) => {
    const s = samples[i];
    return !!(s && s.voiced && s.hz > 0 && s.conf >= minConf);
  };

  // Hysteresis state machine over frames → [startIdx, endIdx) spans.
  const spans = [];
  let start = -1;
  for (let i = 0; i < samples.length; i++) {
    const speechy = energy[i] >= (start < 0 ? on : off) || isVoiced(i);
    if (start < 0) {
      if (speechy) start = i;
    } else if (!speechy) {
      spans.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) spans.push([start, samples.length]);

  // Merge spans separated by gaps too short to be inter-word pauses.
  const merged = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && (span[0] - prev[1]) * tickSec < minGapSec) prev[1] = span[1];
    else merged.push(span.slice());
  }

  const runs = [];
  for (const [s0, s1] of merged) {
    let peakEnergy = 0;
    let voicedCount = 0;
    for (let i = s0; i < s1; i++) {
      if (energy[i] > peakEnergy) peakEnergy = energy[i];
      if (isVoiced(i)) voicedCount++;
    }
    const durSec = (s1 - s0) * tickSec;
    // Prune only when short AND quiet AND unvoiced — keeps real short words ("a", "I").
    if (durSec < minRunSec && peakEnergy < on * 1.2 && voicedCount < 2) continue;
    runs.push({
      startIdx: s0,
      endIdx: s1,
      startSec: s0 * tickSec,
      endSec: s1 * tickSec,
      durSec,
      peakEnergy,
      voicedCount,
    });
  }
  return runs;
}

// Rough syllable count: maximal vowel groups (y counts as a vowel), minus a silent
// trailing 'e' (but not '-le', which is syllabic). Used as a word's duration weight when
// splitting a blended run across words, and for phrase pace. Deliberately simple — the
// tests pin its answers on the actual practice-phrase words so drift is visible.
export function estimateSyllables(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 0;
  if (count > 1 && w.endsWith('e') && !w.endsWith('le')) count--;
  return Math.max(1, count);
}

// Align detected speech runs to the known words of the phrase.
//   equal counts  → 1:1 ('exact', all matched)
//   more runs     → repeatedly merge the adjacent pair with the smallest gap ('merged') —
//                   the smallest gaps are intra-word closures the segmenter's merge pass missed
//   fewer runs    → give each run a contiguous word group (cumulative syllable weight vs
//                   cumulative run duration), then cut multi-word runs at interior boundaries,
//                   preferring a syllable-onset frame near the proportional point, else the
//                   local energy minimum ('split'; split words are matched:false = estimated)
//   no runs       → unmatched slots ('fallback')
// lowConfidence flags a raw run/word count mismatch over 50% so the UI can caveat harder.
export function alignRunsToWords(runs, words, { samples = [], tickSec = 512 / 44100 } = {}) {
  const runCount = Array.isArray(runs) ? runs.length : 0;
  const wordCount = Array.isArray(words) ? words.length : 0;
  const lowConfidence = wordCount > 0 && Math.abs(runCount - wordCount) / wordCount > 0.5;
  if (wordCount === 0) return { slots: [], status: 'fallback', runCount, lowConfidence: false };
  const slotFromSpan = (word, startIdx, endIdx, matched) => ({
    word,
    startIdx,
    endIdx,
    startSec: startIdx * tickSec,
    endSec: endIdx * tickSec,
    durSec: (endIdx - startIdx) * tickSec,
    matched,
  });
  if (runCount === 0) {
    return {
      slots: words.map((word) => ({ word, startIdx: -1, endIdx: -1, startSec: 0, endSec: 0, durSec: 0, matched: false })),
      status: 'fallback',
      runCount,
      lowConfidence,
    };
  }

  let work = runs.map((r) => ({ startIdx: r.startIdx, endIdx: r.endIdx }));

  if (work.length > wordCount) {
    while (work.length > wordCount) {
      let best = 0;
      let bestGap = Infinity;
      for (let i = 0; i + 1 < work.length; i++) {
        const gap = work[i + 1].startIdx - work[i].endIdx;
        if (gap < bestGap) { bestGap = gap; best = i; }
      }
      work.splice(best, 2, { startIdx: work[best].startIdx, endIdx: work[best + 1].endIdx });
    }
    return {
      slots: work.map((r, k) => slotFromSpan(words[k], r.startIdx, r.endIdx, true)),
      status: 'merged',
      runCount,
      lowConfidence,
    };
  }

  if (work.length === wordCount) {
    return {
      slots: work.map((r, k) => slotFromSpan(words[k], r.startIdx, r.endIdx, true)),
      status: 'exact',
      runCount,
      lowConfidence,
    };
  }

  // Fewer runs than words: distribute words over runs, monotone and contiguous.
  const weights = words.map(estimateSyllables);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const durs = work.map((r) => r.endIdx - r.startIdx);
  const totalDur = durs.reduce((a, b) => a + b, 0) || 1;
  const runEndFrac = [];
  {
    let acc = 0;
    for (const d of durs) { acc += d; runEndFrac.push(acc / totalDur); }
  }
  const groups = work.map(() => []);
  {
    let accW = 0;
    for (let k = 0; k < wordCount; k++) {
      const mid = (accW + weights[k] / 2) / totalW;
      accW += weights[k];
      let r = runEndFrac.findIndex((f) => mid < f);
      if (r < 0) r = work.length - 1;
      groups[r].push(k);
    }
  }
  // Repair: every run needs ≥1 word. Shift words along the chain from the nearest
  // multi-word group; word indices stay contiguous and ordered.
  for (let r = 0; r < groups.length; r++) {
    if (groups[r].length > 0) continue;
    let donor = -1;
    for (let d = 1; d < groups.length; d++) {
      if (r - d >= 0 && groups[r - d].length > 1) { donor = r - d; break; }
      if (r + d < groups.length && groups[r + d].length > 1) { donor = r + d; break; }
    }
    if (donor < 0) continue;
    if (donor < r) {
      for (let i = donor; i < r; i++) groups[i + 1].unshift(groups[i].pop());
    } else {
      for (let i = donor; i > r; i--) groups[i - 1].push(groups[i].shift());
    }
  }

  const slots = new Array(wordCount);
  for (let r = 0; r < work.length; r++) {
    const g = groups[r];
    const run = work[r];
    if (g.length === 0) continue;
    if (g.length === 1) {
      slots[g[0]] = slotFromSpan(words[g[0]], run.startIdx, run.endIdx, true);
      continue;
    }
    const span = run.endIdx - run.startIdx;
    const wSum = g.reduce((a, k) => a + weights[k], 0);
    const bounds = [run.startIdx];
    let acc = 0;
    let prevCut = run.startIdx;
    for (let j = 0; j < g.length - 1; j++) {
      acc += weights[g[j]];
      const target = run.startIdx + Math.round((span * acc) / wSum);
      const window = Math.max(1, Math.round((span / g.length) * 0.25));
      const lo = Math.max(prevCut + 1, target - window);
      const hi = Math.min(run.endIdx - 1, target + window);
      let cut = Math.min(Math.max(target, prevCut + 1), run.endIdx - 1);
      if (lo <= hi) {
        let onsetAt = -1;
        let minAt = lo;
        let minE = Infinity;
        for (let i = lo; i <= hi; i++) {
          const s = samples[i];
          const p = samples[i - 1];
          const syl = s && Number.isFinite(s.syl) ? s.syl : 0;
          const psyl = p && Number.isFinite(p.syl) ? p.syl : 0;
          if (onsetAt < 0 && syl >= 0.9 && psyl < 0.9) onsetAt = i;
          const e = s && Number.isFinite(s.energy) ? s.energy : 0;
          if (e < minE) { minE = e; minAt = i; }
        }
        cut = onsetAt >= 0 ? onsetAt : minAt;
      }
      cut = Math.max(cut, prevCut); // degenerate tiny spans: allow empty slices, never regress
      bounds.push(cut);
      prevCut = cut;
    }
    bounds.push(run.endIdx);
    for (let j = 0; j < g.length; j++) {
      slots[g[j]] = slotFromSpan(words[g[j]], bounds[j], Math.max(bounds[j + 1], bounds[j]), false);
    }
  }
  return { slots, status: 'split', runCount, lowConfidence };
}

// Per-word stats: each slot's snapshot slice goes through the same summarizeClipMetrics
// gates as the whole clip, with minVoiced lowered (a 250 ms word is only ~20 ticks).
// relLoudness is the word's mean energy relative to the phrase's voiced-frame average, so
// the UI can show relative emphasis without absolute-level meaning.
export function summarizeWordMetrics(samples, slots, { tickSec = 512 / 44100, minVoiced = 2, minConf = 0.35 } = {}) {
  const all = Array.isArray(samples) ? samples : [];
  const list = Array.isArray(slots) ? slots : [];
  let eSum = 0;
  let eN = 0;
  for (const s of all) {
    if (s && s.voiced && s.hz > 0 && Number.isFinite(s.energy)) { eSum += s.energy; eN++; }
  }
  const phraseEnergyAvg = eN > 0 ? eSum / eN : 0;
  return list.map((slot) => {
    const valid = !!slot && slot.startIdx >= 0 && slot.endIdx > slot.startIdx;
    const slice = valid ? all.slice(slot.startIdx, slot.endIdx) : [];
    let wSum = 0;
    let wN = 0;
    for (const s of slice) {
      if (s && Number.isFinite(s.energy)) { wSum += s.energy; wN++; }
    }
    const energyAvg = wN > 0 ? wSum / wN : 0;
    return {
      word: slot ? slot.word : '',
      matched: !!(slot && slot.matched),
      startSec: valid ? slot.startSec : 0,
      endSec: valid ? slot.endSec : 0,
      durSec: valid ? slot.durSec : 0,
      metrics: valid ? summarizeClipMetrics(slice, { minConf, minVoiced }) : null,
      energyAvg,
      relLoudness: phraseEnergyAvg > 0 ? energyAvg / phraseEnergyAvg : 0,
    };
  });
}

// End-to-end phrase-take analysis: tokenize the known phrase, segment → align → per-word
// summarize, and extend the whole-clip summary with phrase-level stats (duration, speech
// vs pause time, pace, pitch range, coarse contour). Returns overall: null (and
// segmentation 'fallback') for an all-silent take, mirroring summarizeClipMetrics.
export function summarizePhraseTake(samples, phrase, { tickSec = 512 / 44100, noiseFloor = 0, seg = {} } = {}) {
  const all = Array.isArray(samples) ? samples : [];
  // Keep letters/digits/apostrophes/hyphens; drops bare punctuation tokens like "—".
  const words = String(phrase || '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'’-]/gu, ''))
    .filter(Boolean);
  const runs = segmentSpeechRuns(all, { tickSec, noiseFloor, ...seg });
  const align = alignRunsToWords(runs, words, { samples: all, tickSec });
  const wordSummaries = summarizeWordMetrics(all, align.slots, { tickSec });
  let overall = summarizeClipMetrics(all);
  if (overall) {
    const speechSec = runs.reduce((a, r) => a + r.durSec, 0);
    let pauseCount = 0;
    let pauseTotalSec = 0;
    for (let i = 1; i < runs.length; i++) {
      const gap = runs[i].startSec - runs[i - 1].endSec;
      if (gap > 0) { pauseCount++; pauseTotalSec += gap; }
    }
    const sylTotal = words.reduce((a, w) => a + estimateSyllables(w), 0);
    // Coarse contour: median voiced pitch of the last third vs the first third, ±1 st band.
    const voicedHz = [];
    for (const s of all) {
      if (s && s.voiced && s.hz > 0 && s.conf >= PHRASE_SEG_DEFAULTS.minConf) voicedHz.push(s.hz);
    }
    let contour = 'flat';
    if (voicedHz.length >= 6) {
      const median = (arr) => {
        const a2 = [...arr].sort((x, y) => x - y);
        const m = a2.length >> 1;
        return a2.length % 2 ? a2[m] : (a2[m - 1] + a2[m]) / 2;
      };
      const third = Math.floor(voicedHz.length / 3);
      const st = 12 * Math.log2(median(voicedHz.slice(-third)) / median(voicedHz.slice(0, third)));
      if (st > 1) contour = 'rising';
      else if (st < -1) contour = 'falling';
    }
    overall = {
      ...overall,
      durationSec: all.length * tickSec,
      speechSec,
      pauseCount,
      pauseTotalSec,
      paceWps: speechSec > 0 ? words.length / speechSec : 0,
      paceSylPerSec: speechSec > 0 ? sylTotal / speechSec : 0,
      pitchRangeSemitones: overall.pitchMinHz > 0 ? 12 * Math.log2(overall.pitchMaxHz / overall.pitchMinHz) : 0,
      contour,
    };
  }
  return {
    phrase: String(phrase || ''),
    words: wordSummaries,
    overall,
    segmentation: {
      status: align.status,
      runCount: align.runCount,
      wordCount: words.length,
      lowConfidence: align.lowConfidence,
    },
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

// Cap the blended feminization score when the two strongest cues disagree: a high absolute
// pitch sitting on top of a dark (long-tract) resonance reading. High F0 alone must not
// produce a fully-feminine score when the filter has not moved with it.
//
// NAMING — this is `incongruencePenalty`, deliberately not "strainGuard". What it detects is
// *acoustic incongruence between two measured cues*. It is not a strain detector: strain is a
// phonatory construct (effortful or hyperfunctional voicing, laryngeal tension) that this app
// does not measure at all — there is no EGG, no contact quotient, no perceptual effort rating,
// and nothing in the signal chain that distinguishes an effortfully produced high F0 from a
// comfortable one. Calling it a strain guard would tell the user the app can see something it
// cannot, and could pathologise a voice that is merely mid-transition.
//
// PROVISIONAL: the trigger thresholds (0.7 / 0.35) and the ceiling shape (0.5 + 0.5·resonance)
// are hand-tuned, not derived from listener data. They are recorded here so the next revision
// changes a named, documented rule rather than an anonymous inline `if`.
//
// Returns `blended` unchanged when the rule does not apply, so it is a no-op on every path it
// does not explicitly cap.
export function incongruencePenalty(blended, { goalMode = 'feminization', pitchCue, resonanceCue } = {}) {
  if (goalMode !== 'feminization') return blended;
  if (!pitchCue || !resonanceCue) return blended;
  const pitchPull = clamp01(pitchCue.value) * clamp01(pitchCue.confidence);
  const resonancePull = clamp01(resonanceCue.value) * clamp01(resonanceCue.confidence);
  if (pitchPull > 0.7 && resonancePull < 0.35) {
    const ceiling = 0.5 + resonancePull * 0.5;
    return Math.min(blended, ceiling);
  }
  return blended;
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

  blended = incongruencePenalty(blended, {
    goalMode,
    pitchCue: cues.pitchZone,
    resonanceCue: cues.resonance,
  });

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

// ============================================================================
// RESONANCE CONSTRUCT REDESIGN — Phase 1 (docs/RESONANCE_REDESIGN.md §5)
//
// Phase 1 decomposes the single 0..1 resonance number into the two things it was
// conflating: how large the tract is (FORMANT SCALE) and what shape it is currently
// in (FORMANT PATTERN). Everything below is v2. Nothing here feeds the displayed
// metric — `smoothResonance` (v1) is untouched and still drives the ball, HUD,
// haptics, gender score, necklace and bulb. v2 is instrumented only.
// ============================================================================

// --- Per-formant weights for the scale regression (§3.2) --------------------
//
// v1 fits the uniform-tube series F_i = (2i-1)·ΔF/2 with *equal* leverage on F1..F3.
// That is the configuration measured at d′ = 0.81 in §1.3: F1 and F2 define the vowel
// (across-vowel CV 32% and 38% against a male→female shift of 16% and 19%), so giving
// them equal say in a tract-*size* estimate asks them to do the opposite of their job.
// F3 is the only one of the three that is more speaker-determined than vowel-determined
// (CV 8%, shift 17%, ratio 2.12 — §1.2), and F3 alone reaches d′ = 1.67.
//
// The weights are not hand-picked toward that result. They are ordinary weighted
// least squares: in the model F_i = x_i·ΔF + ε_i, the efficient weight is w_i = 1/σ_i²
// where σ_i is the scatter of the observation around the model. Here that scatter *is*
// the vowel-induced excursion of F_i, whose relative size §1.2 publishes as a CV. So
//
//     σ_i = CV_i · F̄_i,     w_i = 1 / σ_i²
//
// with F̄ the nominal adult formant centres. The x_i² factor in the normal equations
// then supplies the leverage term, so formant i's effective say in ΔF is x_i²/σ_i².
// No free parameters, and it generalises to F4 the moment F4 is available.
//
// F4 has no CV in §1.2 because no estimator produced one; it is assigned F3's 8%,
// which is conservative (F4 is if anything more vowel-independent than F3) and lands
// it at the same effective leverage as F3 rather than dominating on an assumption.
export const FORMANT_SCALE_CV = [0.32, 0.38, 0.08, 0.08];      // §1.2 (F4: F3's, see above)
export const FORMANT_SCALE_CENTRE_HZ = [500, 1500, 2500, 3500]; // nominal adult centres
export const FORMANT_SCALE_WEIGHTS = FORMANT_SCALE_CV.map((cv, i) => {
  const sigma = cv * FORMANT_SCALE_CENTRE_HZ[i];
  return 1 / (sigma * sigma);
});

// Weighted zero-intercept fit of the uniform-tube series — the FORMANT SCALE stage.
//
// Same estimator as fitFormantDispersion (Reby & McComb; §1.5 confirms the method is
// right) with the weight vector above:
//
//     ΔF = Σ(w_i · x_i · F_i) / Σ(w_i · x_i²),   x_i = (2i-1)/2
//
// ARRAY POSITION IS THE FORMANT NUMBER, exactly as in fitFormantDispersion: a 0/NaN
// entry means "not measured this frame", not "the list is shorter". Passing
// [F1, F2, F3, 0] is the F4-unavailable fallback and is a supported operating point,
// not a degraded one — §5 gates F4 on measured availability.
//
// `leverage` reports each formant's share of ∂ΔF/∂F_i, which is what the per-formant
// sensitivity table in §1.4 is differentiating. It is returned rather than recomputed
// so the test asserts against the fit's own arithmetic.
export function fitFormantScale(formants, {
  weights = FORMANT_SCALE_WEIGHTS,
  residualToleranceHz = 350,
} = {}) {
  const empty = { deltaF: 0, n: 0, residualHz: 0, fitQuality: 0, leverage: [] };
  if (!Array.isArray(formants)) return empty;
  let sxy = 0, sxx = 0, n = 0;
  for (let i = 0; i < formants.length; i++) {
    const f = formants[i];
    if (!(f > 0)) continue;
    const w = weights[i];
    if (!(w > 0)) continue;
    const x = (2 * (i + 1) - 1) / 2;
    sxy += w * x * f;
    sxx += w * x * x;
    n++;
  }
  // Same floor as the unweighted fit: one formant cannot separate tract length from
  // vowel identity. With this weight vector a lone F1 would in any case carry almost
  // no leverage, so admitting it would be worse than admitting nothing.
  if (n < 2 || sxx <= 0) return empty;
  const deltaF = sxy / sxx;
  const leverage = [];
  let sq = 0, wsum = 0;
  for (let i = 0; i < formants.length; i++) {
    const f = formants[i];
    const w = weights[i];
    const x = (2 * (i + 1) - 1) / 2;
    leverage[i] = (f > 0 && w > 0) ? (w * x) / sxx : 0;
    if (!(f > 0) || !(w > 0)) continue;
    const d = f - x * deltaF;
    // Residual weighted the same way the fit is, so a large but expected F1/F2
    // excursion does not read as a bad fit while a small F3 excursion reads as a good one.
    sq += w * d * d;
    wsum += w;
  }
  const residualHz = Math.sqrt(sq / wsum);
  const fitQuality = clamp01(1 - residualHz / Math.max(1e-6, residualToleranceHz));
  return { deltaF, n, residualHz, fitQuality, leverage };
}

// --- FORMANT PATTERN: scale-normalised residuals (§4, §5) -------------------
//
//     r_i = F_i / ((i − 0.5)·ΔF)
//
// Each r_i says how far formant i sits from where a uniform tube of the speaker's own
// measured scale would put it. Dividing by that speaker's own ΔF is what makes the
// vector speaker-independent by construction: it is the tract *shape*, with tract
// *size* divided out. Phase 2 classifies the vowel from this vector, which is why it
// is returned as a vector and must not be collapsed into a scalar — a scalar summary
// would throw away exactly the dimension the vowel lives in.
//
// Measured on Peterson & Barney means with the weighted fit above, r₁ travels
// 0.46 (/i/) → 1.47 (/ɑ/) across vowels while moving 0.02–0.12 between the male and
// female norms for the same vowel. Vowel identity is nearly all of the signal here,
// and speaker sex nearly none — the exact inverse of what the scale carries.
//
// Missing formants come back as null, not 0: "not measured" and "sits at zero" are
// different statements, and Phase 2 must not classify from a fabricated residual.
export function formantPatternResiduals(formants, deltaF) {
  if (!Array.isArray(formants) || !(deltaF > 0)) return [];
  return formants.map((f, i) => {
    if (!(f > 0)) return null;
    const x = (2 * (i + 1) - 1) / 2;
    return f / (x * deltaF);
  });
}

// --- resonanceAbsolute v2 ---------------------------------------------------
//
// One path. ΔF_scale is the ONLY input, so every formant reaches the score through the
// weighted regression and nowhere else. v1's `vtlScore*0.55 + f1Score*0.25 + f2Score*0.20`
// routes F1 and F2 in twice — once inside vtlScore's ΔF fit, once as their own terms —
// which is why differentiating it gives 30/31/39 rather than the published 55/25/20 (§1.4).
// Adding an F1 or F2 term back on top of ΔF_scale would reintroduce exactly that; the shape
// information those formants carry is `formantPattern`, which is a separate output.
//
// THE SCALE. The score is the speaker's apparent formant dispersion as a fraction of twice
// the adult population's:
//
//     score = ΔF_scale / (2 · ΔF_ref)
//
// so 0.5 is an apparent vocal tract the length of the adult population mean, 1.0 is one half
// that length, and 0 is one unboundedly long. There is one constant and it is a published
// population location, not a tuning knob.
//
// This is a deliberately much shallower axis than v1's, for two reasons:
//
//   1. It cannot clamp on any human voice. v1's 17 cm → 14 cm anchors put *five of the seven*
//      Peterson & Barney adult-male vowels on a rail (/i/ at 1, /æ ɑ ʊ u/ at 0). A rail is
//      not a measurement — it discards the difference between /ɑ/ and /u/ entirely.
//   2. A frame is one vowel and one vowel is not a speaker. v1 spends its whole display over
//      a 21% band of ΔF (~5 score points per 1% of ΔF error, per DSP_CONTRACT), which is why
//      changing vowel moves the meter 73 points. Here a single speaker's whole across-vowel
//      excursion — 313 Hz of ΔF, measured on P&B — occupies 14.5 points.
//
// The consequence is that the male→female separation on this axis is ~8 points rather than
// v1's 27, and real adults sit in a band around the middle. That is the right shape for an
// *absolute* population axis: discriminability is what d′ measures (1.73 here against v1's
// 0.86), and it is unchanged by how the axis is scaled. Restoring full display travel is
// `resonanceControl`'s job — personal normalisation, Phase 4 — not an absolute scale steep
// enough to put /i/ and /u/ from one mouth at opposite ends.
//
// ΔF_ref is the Peterson & Barney adult grand-mean upper-formant-weighted dispersion, pooled
// over both sexes and the seven §1.1 benchmark vowels: 1078 Hz (≈16.2 cm apparent tract).
// resonance-dprime.test.mjs recomputes it from the committed fixture so it cannot drift away
// from the norms it claims to come from.
export const RESONANCE_V2_REFERENCE_DELTA_F_HZ = 1078;

export function resonanceAbsoluteV2(deltaFScaleHz, referenceDeltaFHz = RESONANCE_V2_REFERENCE_DELTA_F_HZ) {
  if (!(deltaFScaleHz > 0)) return 0;
  return clamp01(deltaFScaleHz / (2 * referenceDeltaFHz));
}

// --- Rolling-window pooling of the scale (§5: "pooled over a rolling window") -
//
// The scale is a property of the speaker, not of the frame. Estimating it per frame and
// then comparing frames is the §1.1 error in miniature — each frame is one vowel, and one
// vowel's apparent tract length is not the speaker's. Pooling over a window that spans
// several vowels averages the shape excursion out while leaving the size intact.
//
// The pool takes the weighted MEDIAN, not the mean: a single formant-tracking failure
// (an F3 that locked onto F4, a spurious low-bandwidth pole) produces an outlier ΔF that
// a mean would carry into the pooled value in proportion to its size. Weights are the
// caller's per-frame confidence, so unreliable frames dilute rather than vote.
//
// Returns 0 when the window holds too little to pool — an explicit "no scale yet",
// which callers must not read as "a very short tract".
export function poolFormantScale(entries, { minSamples = 8 } = {}) {
  if (!Array.isArray(entries)) return { deltaF: 0, n: 0, weight: 0 };
  const usable = entries.filter((e) => e && e.deltaF > 0 && e.weight > 0);
  if (usable.length < minSamples) return { deltaF: 0, n: usable.length, weight: 0 };
  const sorted = usable.slice().sort((a, b) => a.deltaF - b.deltaF);
  const total = sorted.reduce((s, e) => s + e.weight, 0);
  let acc = 0;
  for (const e of sorted) {
    acc += e.weight;
    if (acc >= total / 2) return { deltaF: e.deltaF, n: sorted.length, weight: total };
  }
  const last = sorted[sorted.length - 1];
  return { deltaF: last.deltaF, n: sorted.length, weight: total };
}

// --- resonanceAbsolute v1, as a pure function ------------------------------
//
// The population-anchor branch of `VoiceAnalyzer.update`'s resonance stage, lifted out
// verbatim so the benchmark can score Peterson & Barney means through the *actual*
// displayed function rather than a copy of it that could drift away from the real one.
// app.js calls this; the arithmetic, the clamp order and the 0.55/0.25/0.20 weights are
// unchanged, and the golden vectors and eval-harness ranges are the proof.
//
// It is left exactly as it is because v1 stays the displayed metric through Phase 1.
// Its two known defects are measured, not fixed here:
//   - F1 and F2 enter twice, once inside `deltaFHz`'s fit and once as their own terms,
//     so the real sensitivity split is 30/31/39 rather than 55/25/20 (§1.4).
//   - The 17 cm → 14 cm anchors clamp five of the seven P&B adult-male vowels to a rail
//     and swing 73 points across the vowel set (§1.1).
// Both are what v2 above exists to answer.
export function resonanceScoreV1({ deltaFHz = 0, f1 = 0, f2 = 0, vowelLike = false } = {}) {
  const aVtlCm = deltaFHz > 0 ? 35000 / (2 * deltaFHz) : 0;
  const vtlScore = aVtlCm > 0 ? clamp01((17 - aVtlCm) / 3) : 0;
  const f1Score = Math.max(0, Math.min(1, (f1 - 300) / 600));
  const f2Score = vowelLike ? clamp01((f2 - 1000) / 1400) : vtlScore;
  return { score: vtlScore * 0.55 + f1Score * 0.25 + f2Score * 0.20, vtlScore, f1Score, f2Score, aVtlCm };
}

// ============================================================================
// RESONANCE CONSTRUCT REDESIGN — Phase 2 (docs/RESONANCE_REDESIGN.md §5)
//
// Phase 1 split the construct into tract SIZE (`formantScale`) and tract SHAPE
// (`formantPattern`). Phase 2 reads the shape: it names the vowel, and then uses that
// name to condition F2. Still instrumented only — `smoothResonance` (v1) remains the
// number the ball, HUD, haptics, gender score, necklace and bulb all read.
//
// §3.1 is the argument this phase exists to satisfy: raw F2 is the WORST measure on the
// benchmark (d′ 0.38) because it mostly reports which vowel was spoken. The conditioning
// is the entire feature, not a qualifier on it.
// ============================================================================

// --- How many dimensions the residual vector actually has -------------------
//
// Phase 1 handed Phase 2 a warning: r₃ ≈ 1.0 for every vowel and both sexes (0.963–1.035),
// so "don't assume three dimensions of information; measure how many you actually have."
// Measured, the answer is exact rather than approximate, and it depends on where ΔF came from.
//
// WHEN ΔF IS FITTED TO THE SAME FRAME'S FORMANTS, the residuals obey an algebraic identity.
// The weighted zero-intercept fit is ΔF = Σ(w_i x_i F_i)/Σ(w_i x_i²) with x_i = i − 0.5, and
// r_i = F_i/(x_i ΔF). Substituting,
//
//     Σ_i L_i · r_i ≡ 1,        L_i = w_i x_i² / Σ(w_j x_j²)
//
// — one exact linear constraint, verified to twelve decimal places on all ten P&B vowels in
// resonance-dprime.test.mjs. So an n-formant residual vector carries exactly n−1 free
// dimensions: F1–F3 gives TWO, F1–F4 gives THREE. r₃ is not merely uninformative there, it is
// algebraically determined by r₁ and r₂. Principal components over the P&B set confirm it:
// variance shares 62.8% / 37.2% / 0.0%, third eigenvalue −4.9e-17.
//
// WHEN ΔF IS POOLED OVER A WINDOW — which is what the app actually does (§5, and Phase 1's
// rolling 100-frame weighted median) — the constraint is broken, because the scale no longer
// comes from the frame being normalised. The third dimension opens up: variance shares become
// 62.0% / 33.8% / 4.2%, and r₃ spans 0.695–1.244 instead of 0.963–1.035.
//
// That 4.2% is small but it is not noise, and it is where /ɝ/ lives. See VOWEL_TEMPLATES.
// (`vowelDimsFor` below is where this becomes the classifier's dimension count.)

// --- Making the residual independent of what the pooling window contained ----
//
// The identity above has a consequence that only shows up in the app, never on the benchmark.
// ΔF is POOLED over a rolling window (Phase 1), so what a residual vector means depends on
// what that window contained:
//
//   CONNECTED SPEECH — the window spans several vowels, ΔF is the speaker's, and each frame's
//   residual carries both the vowel's shape AND how far that vowel's own apparent scale sits
//   from the speaker's. Σ L_i r_i ranges 0.73–1.22 over the P&B set.
//
//   A SUSTAINED HOLD — the window contains one vowel, so ΔF converges on THAT VOWEL's own fit
//   and the identity reasserts itself: Σ L_i r_i → 1 for every vowel.
//
// Both are first-class operating points — a held vowel is the exercise mode the ball runs —
// and a classifier calibrated to one silently fails on the other. Measured: a held /i/ lands
// 1.011 away from a pooled-window /i/ template, well outside any sane gate, so a classifier
// built in the pooled frame abstains through most of a sustained vowel.
//
// The fix is to classify in the frame that does not depend on the window. A mismatch between
// the pooled scale and the frame's own scale is a single multiplicative factor on every r_i —
// it moves the vector along a ray through the origin — so dividing it out normalises the two
// operating points onto each other:
//
//     ρ = Σ L_i r_i,      r′_i = r_i / ρ        (so Σ L_i r′_i ≡ 1)
//
// r′ is what the classifier matches. THE COST IS EXPLICIT AND IT IS /ɝ/: ρ is exactly the
// dimension a rhotic's lowered F3 shows up in (0.73 against 0.90–1.22 for every other vowel),
// and it is exactly the dimension a pooling-window mismatch also moves. They are the same
// number, so a classifier cannot use one without being broken by the other. Reading /ɝ/ off ρ
// requires knowing what the window contained — a frame-validity and estimator-discipline
// question, which is Phase 3. It is not smuggled in here. §5's Phase 2 entry records both the
// measurement (/ɝ/ is 1.18 from its nearest neighbour in the pooled frame, the most isolated
// vowel in the set, against 0.40 in this one) and the hand-off.
export function residualScaleFactor(residuals, weights = FORMANT_SCALE_WEIGHTS, limit = Infinity) {
  if (!Array.isArray(residuals)) return 0;
  let sxx = 0, acc = 0;
  for (let i = 0; i < Math.min(residuals.length, limit); i++) {
    const r = residuals[i];
    const w = weights[i];
    if (r == null || !(r > 0) || !(w > 0)) continue;
    const x = (2 * (i + 1) - 1) / 2;
    sxx += w * x * x;
    acc += w * x * x * r;
  }
  return sxx > 0 ? acc / sxx : 0;
}

// Returns the vector normalised onto Σ L_i r′_i = 1, preserving nulls. `scaleFactor` is
// returned alongside because it is not noise — it is the rhotic signal, and Phase 3 will want
// it once it can tell a rhotic from a stale window.
export function normalizeResidualScale(residuals, weights = FORMANT_SCALE_WEIGHTS, limit = Infinity) {
  const rho = residualScaleFactor(residuals, weights, limit);
  if (!(rho > 0)) return { residuals: [], scaleFactor: 0 };
  return { residuals: residuals.map((r) => (r == null || !(r > 0) ? null : r / rho)), scaleFactor: rho };
}

// The classifier's frame is F1-F3 and nothing else, because that is what the templates measure:
// Peterson & Barney published no F4, so there is no r₄ column and no honest way to invent one.
//
// This has to be pinned rather than left to whatever the frame happened to yield. Σ L_i r′_i = 1
// is a DIFFERENT constraint surface for three formants than for four, so normalising a 4-element
// residual and then matching it against 3-formant templates compares vectors that live on two
// different surfaces. Measured cost of getting it wrong: under the `lpc` estimator, which
// produces F4 on 92.4% of frames, the vowel was named on 40.8% of estimator frames instead of
// 76.6% — the classifier was abstaining on most of a clean recording because its own input had
// been normalised in the wrong frame.
//
// F4 keeps doing its Phase 1 job of sharpening `formantScale`; it simply cannot reach the
// classifier, and §5's "improve or at least not degrade when F4 is present" is satisfied on the
// "not degrade" side by construction. Phase 5's real-vowel validation is where a measured r₄
// could come from.
export const VOWEL_TEMPLATE_FORMANTS = 3;

// --- Vowel templates in residual space --------------------------------------
//
// r′ for each Peterson & Barney vowel, averaged over the two sexes. Because r′ is normalised
// onto Σ L_i r′ = 1, these are identical to the residuals of a scale fitted to each vowel
// alone — which is what makes them the same whether the speaker is holding one vowel or
// talking. resonance-dprime.test.mjs recomputes every number here from
// fixtures/peterson-barney-1952.json, so they cannot drift from the norms they claim.
//
// The two sexes are averaged rather than kept apart because the residuals are very nearly the
// same for both — Phase 1's measured result, and the whole reason a classifier built on them
// is speaker-independent. The averaging is checked, not assumed: the test classifies one sex
// using templates built ONLY from the other, across a 16.5% difference in pooled tract scale.
export const VOWEL_TEMPLATES = {
  i: [0.4663, 1.3595, 1.0174],
  'ɪ': [0.7341, 1.3264, 1.0022],
  'ɛ': [1.0307, 1.2511, 0.9870],
  'æ': [1.3934, 1.1565, 0.9685],
  'ɑ': [1.4778, 0.7212, 0.9825],
  'ɔ': [1.1462, 0.5788, 1.0095],
  'ʊ': [0.9429, 0.7509, 1.0146],
  u: [0.7047, 0.6415, 1.0343],
  'ʌ': [1.3351, 0.8236, 0.9869],
  'ɝ': [1.3162, 1.3170, 0.9662],
};

// Per-dimension across-vowel SD over the template set. Distances are divided by these, so one
// unit of distance is one across-vowel SD whichever dimension it is in.
//
// r₃'s SD is 0.0219 — two orders below r₁'s and r₂'s — which is the rank identity showing up
// as a number: with three formants r₃ is not an observation, it is r₁ and r₂ rearranged. The
// classifier therefore runs on TWO dimensions by default, and that is a derivation rather than
// a tuning choice. A fourth formant makes r₃ a real observation again (four formants, three
// free dimensions) and DEFAULT_VOWEL_DIMS rises with it.
export const VOWEL_RESIDUAL_SD = [0.3325, 0.3092, 0.0219];

// How many residual dimensions to match on, given how many formants the fit had. n formants,
// n−1 free dimensions, capped at the three the templates cover.
export function vowelDimsFor(nFormants) {
  return Math.max(0, Math.min(3, nFormants - 1));
}

// The measured across-SPEAKER scatter: the mean distance, in the metric above, between the
// male and female norms FOR THE SAME VOWEL. 0.195, against a mean nearest-other-vowel template
// spacing of 0.50. This is the classifier's natural noise scale — how far a genuine production
// of a vowel sits from the template because the speaker is a different person — so it is what
// the posterior is widened by. A measurement, not a knob.
export const VOWEL_SPEAKER_SCATTER = 0.195;

// Abstention gates (§6: "It must degrade to 'no F2 feature this frame' rather than guess —
// the same discipline applied to the centroid's fabricated F3"). Two independent ways to
// decline, because there are two independent ways to be wrong:
//
//   DISTANCE — the vector is not near any vowel. Three across-speaker scatters from the
//   nearest template is further than any genuine cross-speaker production was measured to sit.
//   Beyond it the frame is a transition, a nasal, a fricative or a tracking failure, and
//   naming a vowel would be fabrication.
//
//   POSTERIOR — the vector is near two vowels at once. 0.5 is the point where the winning
//   vowel stops being more probable than every alternative combined.
//
// Neither was chosen by looking at the accuracy it produced. Both are stated in units that
// mean something (scatters; probability), and the accuracy AND the abstention rate are
// reported together — the only honest way to read a classifier that can decline.
export const VOWEL_ABSTAIN_MAX_DISTANCE = 3 * VOWEL_SPEAKER_SCATTER;   // 0.585
export const VOWEL_ABSTAIN_MIN_POSTERIOR = 0.5;

// Distance between a residual vector and a template, in across-vowel SD units, averaged over
// however many dimensions are present. Averaging rather than summing keeps a 2-dimension
// frame's distances on the same scale as a 3-dimension frame's, so one set of thresholds
// covers both.
function residualDistance(r, template, dims) {
  let s = 0, n = 0;
  for (let i = 0; i < dims; i++) {
    if (r[i] == null || !(r[i] > 0)) continue;
    const d = (r[i] - template[i]) / VOWEL_RESIDUAL_SD[i];
    s += d * d; n++;
  }
  return n > 0 ? { d: Math.sqrt(s / n), n } : { d: Infinity, n: 0 };
}

// --- The classifier ---------------------------------------------------------
//
// Nearest template in the normalised residual space, softened into a posterior so that
// "which vowel" and "how sure" come out of the same arithmetic rather than being bolted
// together afterwards.
//
// The input is normalised onto the scale-invariant frame first (`preNormalized: true` skips
// that when the caller has already done it). Returns `vowel: null` — never a guess — whenever
// either gate fires, with `reason` naming which, so the abstention RATE can be reported next
// to the accuracy and the two failure modes told apart.
export function classifyVowel(residuals, {
  templates = VOWEL_TEMPLATES,
  maxDistance = VOWEL_ABSTAIN_MAX_DISTANCE,
  minPosterior = VOWEL_ABSTAIN_MIN_POSTERIOR,
  scatter = VOWEL_SPEAKER_SCATTER,
  dims = null,
  preNormalized = false,
} = {}) {
  const none = (reason) => ({ vowel: null, posterior: 0, distance: Infinity, runnerUp: null, dims: 0, scaleFactor: 0, reason });
  if (!Array.isArray(residuals)) return none('no-residuals');
  const view = residuals.slice(0, VOWEL_TEMPLATE_FORMANTS);
  const norm = preNormalized
    ? { residuals: view, scaleFactor: 1 }
    : normalizeResidualScale(view, FORMANT_SCALE_WEIGHTS, VOWEL_TEMPLATE_FORMANTS);
  const r = norm.residuals;
  if (!r.length) return none('no-residuals');
  const nFormants = r.filter((x) => x != null && x > 0).length;
  const useDims = dims == null ? vowelDimsFor(nFormants) : dims;
  // Two residual dimensions is the floor: with one, every template is reachable by rescaling.
  if (useDims < 2) return none('insufficient-dimensions');
  const ranked = [];
  for (const [v, t] of Object.entries(templates)) {
    const { d } = residualDistance(r, t, useDims);
    if (Number.isFinite(d)) ranked.push([v, d]);
  }
  if (!ranked.length) return none('insufficient-dimensions');
  ranked.sort((a, b) => a[1] - b[1]);
  const [best, bestD] = ranked[0];
  const runnerUp = ranked.length > 1 ? ranked[1][0] : null;
  const common = { distance: bestD, dims: useDims, scaleFactor: norm.scaleFactor };
  if (bestD > maxDistance) {
    return { vowel: null, posterior: 0, runnerUp: best, reason: 'not-a-vowel', ...common };
  }
  let z = 0;
  for (const [, d] of ranked) z += Math.exp(-(d * d) / (2 * scatter * scatter));
  const posterior = z > 0 ? Math.exp(-(bestD * bestD) / (2 * scatter * scatter)) / z : 0;
  if (!(posterior >= minPosterior)) {
    return { vowel: null, posterior, runnerUp, reason: 'ambiguous', ...common };
  }
  return { vowel: best, posterior, runnerUp, reason: 'ok', ...common };
}

// --- f2Position -------------------------------------------------------------
//
// §5: "`f2Position` = F2 relative to the expected F2 for that vowel at that speaker's scale."
//
//     expected F2 = r₂_template(vowel) · 1.5 · ΔF_scale
//     f2Position  = F2_measured / expected F2
//
// 1.0 means "exactly where the published norms put this vowel for a tract of your size".
// Above 1.0 is a fronter/brighter F2 than the vowel requires; below is backer/darker. It is
// dimensionless and it is a RATIO of two frequencies, so it carries no tract length.
//
// THAT IS THE POINT, AND IT IS ALSO THE COST. Dividing by the speaker's own scale is what
// makes this the trainable quantity: tract length is not trainable, tongue and lip posture is,
// and the GAVT result §1.5 cites (F2 1847 → 1961 Hz) is a within-speaker change at a fixed
// tract length. It is also what stops f2Position re-reporting what `formantScale` already
// reports — the population-relative alternative (divide by a fixed reference ΔF instead of the
// speaker's) correlates r = 0.95 with resonanceAbsoluteV2 across the P&B points, which is the
// §1.4 double count coming back through a different door.
//
// The consequence, measured and NOT worked around: on the benchmark's male-vs-female contrast
// f2Position scores d′ −0.29, below raw F2's 0.38, because P&B's two populations differ in
// tract SIZE and barely in vowel POSTURE, and this feature has size divided out by
// construction. Measured on the contrast it is actually for — the same published training
// shift, through the same d′ arithmetic — it scores 2.09 against raw F2's 0.16. Both numbers
// are asserted in resonance-dprime.test.mjs and printed by tools/resonance-benchmark.mjs.
// See §5's Phase 2 entry for the full accounting.
export function expectedF2Hz(vowel, deltaFFrameHz, templates = VOWEL_TEMPLATES) {
  const t = templates[vowel];
  if (!t || !(deltaFFrameHz > 0)) return 0;
  return t[1] * 1.5 * deltaFFrameHz;
}

// `deltaFFrameHz` is THIS FRAME's own weighted ΔF, not the pooled one, for the same reason the
// classifier normalises: it is the only choice that means the same thing during a sustained
// hold and during running speech. The two agree wherever the pooled scale is valid — by the
// identity ΔF_frame = ρ·ΔF_pooled, and the templates' own ρ is what converts between the two
// frames — and only this one stays correct when the pooling window has collapsed onto a single
// vowel. Equivalently, and this is how the app computes it: r′₂ / r₂_template(vowel).
//
// Returns 0 for "no reading", never a fabricated 1.0: an abstained frame and a frame whose F2
// happens to sit exactly on the norm are different statements, and §6 requires them to stay
// different. Callers test `> 0`.
export function f2Position({ f2Hz = 0, vowel = null, deltaFFrameHz = 0, templates = VOWEL_TEMPLATES } = {}) {
  if (!(f2Hz > 0) || !vowel) return 0;
  const expected = expectedF2Hz(vowel, deltaFFrameHz, templates);
  if (!(expected > 0)) return 0;
  return f2Hz / expected;
}

// The same quantity straight from a scale-normalised residual vector, which is what the live
// path already has in hand.
export function f2PositionFromResidual(normalizedResiduals, vowel, templates = VOWEL_TEMPLATES) {
  const t = templates[vowel];
  if (!t || !Array.isArray(normalizedResiduals)) return 0;
  const r2 = normalizedResiduals[1];
  if (r2 == null || !(r2 > 0) || !(t[1] > 0)) return 0;
  return r2 / t[1];
}

// Display mapping for later phases. f2Position is a ratio centred on 1.0; this puts it on the
// app's 0..1 convention with 0.5 at the norm. The ±25% span is set from the measured range —
// the P&B vowel set spans ±3% around its own templates and the GAVT training shift is +6.2%,
// so ±25% holds every real reading well clear of the rails, which is what Phase 1's §5 note
// about v1's clamping requires. Nothing displays this in Phase 2; d′ is invariant to any
// affine rescaling that does not clamp, so this mapping cannot change a benchmark number.
export const F2_POSITION_DISPLAY_SPAN = 0.25;
export function f2PositionToDisplay(ratio, span = F2_POSITION_DISPLAY_SPAN) {
  if (!(ratio > 0)) return 0;
  return clamp01(0.5 + (ratio - 1) / (2 * span));
}

// --- Two aggregation modes (§5, §2.9) ---------------------------------------
//
// The same per-frame feature stream summarised two ways, because "how am I doing at this
// exercise" and "how do I sound when I talk" are different questions and a single average
// answers neither well.
//
//   EXERCISE — steady-state weighted, the app's current behaviour. Every frame contributes,
//   scaled by how held it is. Holding a target for four seconds is the exercise, so four
//   seconds of it SHOULD dominate: that is motor learning, and the ball keeps this mode.
//
//   SPEECH — one value per vowel nucleus, nuclei weighted equally. Connected speech is mostly
//   transitions and short reduced vowels; a mode that rewards duration would report a person's
//   ability to sustain a posture rather than their ability to use it while talking. §2.9's
//   "ecological" aggregation. Session statistics use this mode.
//
// The difference is not cosmetic. A clip of one long hold plus running speech is the case that
// separates them, and tools/resonance-aggregation.mjs builds exactly that clip and reports both
// numbers: the hold is ~63% of exercise-mode weight and one nucleus in forty under speech mode.
//
// A NUCLEUS is a maximal run of consecutive frames carrying the same classified vowel. It ends
// at a vowel change, at an abstention, or at a gap in the frame index — all three are the
// boundary of "one vowel was produced here". Its value is the MEDIAN over the run, so the
// onset and offset frames at its edges cannot drag it, and short runs are dropped rather than
// admitted as noisy one-frame nuclei.
export function aggregateExercise(samples) {
  if (!Array.isArray(samples)) return { value: 0, n: 0, weight: 0 };
  let sw = 0, sv = 0, n = 0;
  for (const s of samples) {
    if (!s || !(s.value > 0) || !(s.weight > 0)) continue;
    sv += s.value * s.weight; sw += s.weight; n++;
  }
  return { value: sw > 0 ? sv / sw : 0, n, weight: sw };
}

// The single definition of "one vowel was produced here", shared by the array form below and
// the streaming form further down so a session's numbers and a fixture's cannot diverge.
export function nucleusFromRun(run, { minFrames = 3 } = {}) {
  if (!Array.isArray(run) || run.length < minFrames) return null;
  const vs = run.map((s) => s.value).sort((a, b) => a - b);
  const mid = vs.length >> 1;
  return {
    vowel: run[0].vowel,
    frames: run.length,
    value: vs.length % 2 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2,
    startIndex: run[0].index,
  };
}

// True when `s` cannot continue the nucleus `prev` belongs to: a different vowel, or a gap in
// the frame index (frames the caller never submitted are frames with no vowel in them).
export function breaksNucleus(prev, s) {
  if (!prev) return false;
  return prev.vowel !== s.vowel || (s.index != null && prev.index != null && s.index !== prev.index + 1);
}

export function findVowelNuclei(samples, { minFrames = 3 } = {}) {
  if (!Array.isArray(samples)) return [];
  const nuclei = [];
  let run = [];
  const flush = () => {
    const nuc = nucleusFromRun(run, { minFrames });
    if (nuc) nuclei.push(nuc);
    run = [];
  };
  for (const s of samples) {
    if (!s || !s.vowel || !(s.value > 0)) { flush(); continue; }
    if (breaksNucleus(run[run.length - 1], s)) flush();
    run.push(s);
  }
  flush();
  return nuclei;
}

export function aggregateSpeech(samples, { minFrames = 3 } = {}) {
  const nuclei = findVowelNuclei(samples, { minFrames });
  if (!nuclei.length) return { value: 0, n: 0, nuclei: 0, heldFrames: 0 };
  // Equal weight per nucleus — the whole point. A 240-frame hold and a 4-frame /ɪ/ in
  // "the rain" each contribute exactly one number.
  const value = nuclei.reduce((a, x) => a + x.value, 0) / nuclei.length;
  return { value, n: nuclei.length, nuclei: nuclei.length, heldFrames: nuclei.reduce((a, x) => a + x.frames, 0) };
}

// Convenience: both modes over one stream, so a caller cannot accidentally compute them from
// two different frame sets and then compare them.
export function aggregateBothModes(samples, opts = {}) {
  return { exercise: aggregateExercise(samples), speech: aggregateSpeech(samples, opts) };
}

// Streaming form of the two modes, for a live session that cannot buffer every frame.
// An hour of speech is ~216,000 frames; this keeps O(1) state plus the nucleus currently
// open, and produces the same numbers as the array functions above on the same stream —
// asserted in resonance-aggregation.test.mjs rather than assumed, since a session summary
// and a fixture report disagreeing would be exactly the kind of drift DSP_CONTRACT exists
// to prevent.
export class ResonanceAggregator {
  constructor({ minFrames = 3 } = {}) {
    this.minFrames = minFrames;
    this.reset();
  }

  reset() {
    this._exSum = 0; this._exWeight = 0; this._exN = 0;
    this._spSum = 0; this._spN = 0; this._spFrames = 0;
    this._run = [];
  }

  // `sample` = { value, weight, vowel, index }. A frame with no classified vowel still
  // contributes to exercise mode (it is a frame of phonation) but closes any open nucleus,
  // because §6 forbids carrying an unclassified frame into a vowel-conditioned statistic.
  push(sample) {
    if (!sample || !(sample.value > 0)) { this._closeRun(); return; }
    if (sample.weight > 0) {
      this._exSum += sample.value * sample.weight;
      this._exWeight += sample.weight;
      this._exN++;
    }
    if (!sample.vowel) { this._closeRun(); return; }
    if (breaksNucleus(this._run[this._run.length - 1], sample)) this._closeRun();
    this._run.push(sample);
  }

  _closeRun() {
    const nuc = nucleusFromRun(this._run, { minFrames: this.minFrames });
    if (nuc) { this._spSum += nuc.value; this._spN++; this._spFrames += nuc.frames; }
    this._run = [];
  }

  // Reading the speech-mode value must not discard the nucleus in progress, and must not
  // double-count it on the next read either, so the open run is summarised without closing.
  exercise() {
    return { value: this._exWeight > 0 ? this._exSum / this._exWeight : 0, n: this._exN, weight: this._exWeight };
  }

  speech() {
    const open = nucleusFromRun(this._run, { minFrames: this.minFrames });
    const sum = this._spSum + (open ? open.value : 0);
    const n = this._spN + (open ? 1 : 0);
    return { value: n > 0 ? sum / n : 0, n, nuclei: n, heldFrames: this._spFrames + (open ? open.frames : 0) };
  }
}

// ============================================================================
// PHASE 3 — ESTIMATOR DISCIPLINE (docs/RESONANCE_REDESIGN.md §5)
// ============================================================================
//
// Phase 1 split the construct, Phase 2 read the shape. Neither touched the question of WHICH
// estimator produced the formants both were built on, and §3.4 says that question is not a
// detail: the four estimators carry systematic bias (lpc −0.3, cepstral −1.7, centroid +5.0,
// harmonic −11.9 score points against a known vowel), and `auto` swaps between three of them
// mid-session on room noise. A user watching the ball cannot tell a posture change from a
// handover. This section is the arithmetic that ends that.
//
// The rule, in one line: ONE estimator defines the measurement; the others check it.

// --- Frame validity gates (§5) ----------------------------------------------
//
// Five independent ways an LPC frame can be wrong, each with its own test, because they fail
// for different reasons and a single scalar "quality" cannot tell them apart:
//
//   ORDER      F1 < F2 < F3 < F4 with a minimum separation. A violation is not a bad
//              measurement, it is a mis-ASSIGNMENT — the same poles in the wrong slots — and
//              the scale fit reads it as a different tract, not as a noisier one.
//   BANDWIDTH  A pole whose bandwidth is a large fraction of its own frequency is not a
//              formant, it is the model spending a pole pair on spectral slope or on noise.
//              The bound is proportional (Praat's own admission rule is of this shape)
//              rather than a flat Hz cap, because a 400 Hz bandwidth means something very
//              different at F1 = 300 Hz than at F4 = 3800 Hz.
//   CONTINUITY Formants are the resonances of a physical tract with mass. They can move fast
//              at a transition, but a step of tens of percent in 16.7 ms is a tracking
//              failure, not an articulation.
//   MODEL FIT  The Levinson residual: what fraction of the frame's energy the all-pole model
//              failed to predict. High residual means the frame is not well described by an
//              all-pole source-filter model at all — a fricative, a click, a noise burst.
//   SWAP       The failure the continuity gate cannot see: the whole formant SET has shifted by
//              one slot — F2 reading where F1 was, F3 where F2 was — so the ΔF fit has silently
//              changed formant number while every individual pole still looks plausible. Stated
//              as a COMPARISON rather than a threshold: the current formants match the previous
//              ones better after a one-slot shift than they do in place. That has no constant
//              in it to get wrong, and it is genuinely independent of the continuity bound,
//              which the first draft of this gate was not — it required each formant's move to
//              exceed the continuity bound as well, so it could never reject a frame continuity
//              had not already rejected.
//
// The thresholds are stated in units that mean something and are NOT tuned against any
// benchmark: the §5 constraint is explicit that a gate which costs more than it buys is
// reported and left off, not narrowed until a number moves. tools/frame-validity.mjs reports
// precision and recall for each gate separately, against synthetic frames whose true formants
// are known, so the cost of each is visible next to its benefit.

// Minimum separation between adjacent formants, Hz. Below this the two poles are not
// resolvable as separate resonances at the analysis bandwidths this path uses.
export const FORMANT_MIN_SEPARATION_HZ = 150;
// A pole is admitted as formant i only if bw < max(BW_FLOOR_HZ, BW_FRACTION·freq + BW_OFFSET_HZ).
//
// The floor is Praat's published rejection rule — a flat 400 Hz at every formant — and the
// proportional part only ever LOOSENS it, above 1000 Hz. That shape is measured rather than
// assumed: on the Rainbow Passage the LPC bandwidths of F1 and F2 have nearly the same
// distribution (median 155 and 154 Hz) while F3 and F4 run systematically wider (231 and
// 260 Hz), so a flat cap that is right for F1 rejects real upper poles.
//
// The first draft of this gate dropped the 400 Hz floor and used the proportional part alone,
// which made it TIGHTER than the published rule at F1 (250 Hz at F1 = 400 Hz) and rejected 19
// frames of ordinary read speech on F1 bandwidths of 280–380 Hz — poles Praat's own criterion
// admits. Being stricter than the established rule is not conservatism, it is a different rule
// with no evidence behind it.
export const FORMANT_MAX_BW_FRACTION = 0.25;
export const FORMANT_MAX_BW_OFFSET_HZ = 150;
export const FORMANT_MAX_BW_FLOOR_HZ = 400;
// Largest formant velocity admitted as articulation rather than tracking failure, in Hz per
// second. This is a RATE, not a fraction of the formant's own frequency, and the first draft of
// this gate got that wrong at a measurable cost: a proportional bound is simultaneously far too
// loose on F1 (25% of 400 Hz is 100 Hz) and far too tight on F2 (25% of 1500 Hz is 375 Hz,
// which a real glide transition reaches), and on the Rainbow Passage it rejected 74% of frames
// of ordinary read speech. Formant velocity is bounded by how fast tongue and lips can move,
// which is a rate in Hz/s that does not scale with which formant is moving.
//
// 30 Hz/ms is set above the fastest published transitions — F2 in /j/ and /w/ glides is
// reported at 10–25 Hz/ms — so no real articulation trips it, while a pole jumping to a
// different formant (typically 500–1500 Hz in one frame) does. It is stated in Hz/s and
// multiplied by the caller's own frame interval, so it means the same thing at the 60 fps live
// rate and at the golden harness's 93 ms hop; the previous fraction meant different things at
// the two rates without saying so.
export const FORMANT_MAX_STEP_HZ_PER_SEC = 30000;
// Frame interval assumed when the caller does not supply one: the app's 60 fps update rate.
export const FORMANT_FRAME_SEC = 1 / 60;
// Normalised LPC residual (E_final / E_0) above which the all-pole model is not describing this
// frame. 0.5 is the point where the model fails to predict MORE THAN HALF the frame's energy,
// which is a statement about the model rather than a level chosen from a distribution.
//
// The first draft used 0.35 on the claim that "a clean voiced vowel at order 13 sits well below
// 0.1". Measured, that claim is false: on the Rainbow Passage the median residual over voiced
// frames is 0.161 and the 90th percentile 0.337, so 0.35 was rejecting ordinary voiced speech
// on a mis-stated expectation. At 0.5 the gate fires on ~1% of voiced frames, which is what a
// gate meant to catch fricatives, clicks and noise bursts should do.
export const LPC_MAX_RESIDUAL = 0.5;
// A shifted alignment must beat the in-place one by this factor before the frame is called a
// swap. Strictly greater than 1 so that near-ties — which is what a genuinely ambiguous frame
// produces — are resolved in favour of believing the assignment rather than rejecting the
// frame. 1.5 says "half again as good", which is the smallest margin that is not a tie.
export const FORMANT_SWAP_MARGIN = 1.5;

// Known systematic ΔF bias per estimator, as a fraction, from DSP_CONTRACT's measured
// per-estimator accuracy table (lpc −0%, cepstral −1%, centroid +2%, harmonic −4% on a
// synthesized vowel whose ΔF is known by construction).
//
// This has to be divided out before a cross-check is read as disagreement, and getting it
// wrong is not a small error: the harmonic envelope quantises F2/F3 to the nearest harmonic and
// therefore reports ΔF ~4% low BY CONSTRUCTION, so a working harmonic estimator scored against
// an uncorrected LPC value looks like a 4% disagreement forever. Measured on the Rainbow
// Passage, correcting for the published biases moves mean agreement from 0.29 to 0.71 — the
// same estimators, the same audio; the 0.29 was reporting a bias the table had already measured.
export const ESTIMATOR_DELTA_F_BIAS = { lpc: 0, cepstral: -0.01, centroid: 0.02, harmonic: -0.04 };

// `formants` and `bandwidths` are indexed by formant NUMBER − 1, exactly as everywhere else in
// this file: a 0/null entry means "not measured this frame", never "the list is shorter".
// `previous` is the last VALID OBSERVATION of each formant (not the last frame's), so a single
// rejected frame does not become the reference a whole run of frames is then judged against —
// and `previousAgeFrames` says how old each of those observations is, because a velocity bound
// applied to a reference several frames old is not a velocity bound. Getting that wrong is
// measurable: judging a 12-frame-old reference against a one-frame step rejected half of the
// Rainbow Passage's frames on its own.
//
// REJECTION IS PER FORMANT WHERE THE EVIDENCE IS PER FORMANT. A frame in which F3 jumped
// 900 Hz still contains a perfectly good F1 and F2, and throwing them away because a different
// pole misbehaved buys nothing: measured on the Rainbow Passage, a quarter of connected-speech
// frames contain at least one formant step that cannot be articulation (F2/F3/F4 steps of
// 500–1565 Hz in 16.7 ms, against an F1 that never exceeds 345 Hz), and rejecting all of them
// wholesale cost 10 points of vowel yield for no gain in what was rejected.
//
// So the result has two levels:
//   FRAME-level failures  — order, model residual, formant swap. These are statements about
//                           the assignment or the model, and there is no single formant to
//                           blame: if F2 < F1 + 150 Hz, which of the two is wrong?
//   FORMANT-level failures — bandwidth, continuity. These name a pole, and only that pole is
//                           withheld; the rest of the frame is still a measurement.
//
// Returns which gates fired rather than a single boolean, because "this frame was rejected" and
// "this frame was rejected because the model does not fit voiced speech" support different
// downstream decisions, and because the per-gate cost cannot be reported without it.
export function frameValidity(formants, {
  bandwidths = [],
  previous = null,
  previousAgeFrames = null,   // per formant; defaults to 1 frame (i.e. the immediately preceding)
  residual = null,
  minSeparationHz = FORMANT_MIN_SEPARATION_HZ,
  maxBwFraction = FORMANT_MAX_BW_FRACTION,
  maxBwOffsetHz = FORMANT_MAX_BW_OFFSET_HZ,
  maxBwFloorHz = FORMANT_MAX_BW_FLOOR_HZ,
  maxStepHzPerSec = FORMANT_MAX_STEP_HZ_PER_SEC,
  frameSec = FORMANT_FRAME_SEC,
  maxResidual = LPC_MAX_RESIDUAL,
  swapMargin = FORMANT_SWAP_MARGIN,
} = {}) {
  const maxStepHz = maxStepHzPerSec * Math.max(1e-6, frameSec);
  const failed = [];
  const perFormant = [[], [], [], []];
  const f = Array.isArray(formants) ? formants : [];
  const present = [];
  for (let i = 0; i < f.length; i++) if (f[i] > 0) present.push(i);

  // ORDER — frame level. Over whichever formants are present, in formant-number order.
  for (let k = 1; k < present.length; k++) {
    const lo = f[present[k - 1]], hi = f[present[k]];
    if (!(hi > lo + minSeparationHz)) { failed.push('order'); break; }
  }

  // MODEL FIT — frame level. Normalised prediction-error energy from the Levinson recursion.
  if (residual != null && Number.isFinite(residual) && residual > maxResidual) failed.push('residual');

  // BANDWIDTH — per formant. Only where a bandwidth was actually reported; a missing bandwidth
  // is not a failure, and the cepstral and harmonic paths do not produce one at all.
  for (const i of present) {
    const bw = bandwidths[i];
    if (bw == null || !(bw > 0)) continue;
    if (bw > Math.max(maxBwFloorHz, maxBwFraction * f[i] + maxBwOffsetHz)) perFormant[i].push('bandwidth');
  }

  // CONTINUITY and SWAP both need a previous valid observation; on the first frame of a run
  // there is nothing to be discontinuous with, and calling that invalid would mean the tracker
  // could never start.
  if (Array.isArray(previous)) {
    const ageOf = (i) => {
      const a = previousAgeFrames ? previousAgeFrames[i] : 1;
      return Number.isFinite(a) && a >= 1 ? a : 1;
    };
    // CONTINUITY — per formant.
    for (const i of present) {
      const p = previous[i];
      if (!(p > 0)) continue;
      if (Math.abs(f[i] - p) > maxStepHz * ageOf(i)) perFormant[i].push('continuity');
    }
    // SWAP — frame level. Does the current set match the previous one better shifted by one
    // slot than in place? Distances are in log-frequency so a 300 Hz discrepancy at F1 and at
    // F4 are not treated as the same size of error.
    const align = (shift) => {
      let sum = 0, n = 0;
      for (let i = 0; i < 4; i++) {
        const cur = f[i + shift], prev = previous[i];
        if (!(cur > 0) || !(prev > 0)) continue;
        sum += Math.abs(Math.log(cur / prev)); n++;
      }
      return n >= 2 ? sum / n : null;
    };
    const inPlace = align(0), shiftedUp = align(1), shiftedDown = align(-1);
    if (inPlace != null && inPlace > 0) {
      if ((shiftedUp != null && shiftedUp * swapMargin < inPlace)
        || (shiftedDown != null && shiftedDown * swapMargin < inPlace)) failed.push('swap');
    }
  }

  const admitted = present.filter((i) => perFormant[i].length === 0);
  // Two admitted formants is the floor, and it is the scale fit's floor rather than a new one:
  // one formant cannot separate tract length from vowel identity.
  const valid = failed.length === 0 && admitted.length >= 2;
  return {
    valid,
    failed,
    perFormant,
    admitted,
    nFormants: present.length,
    // The formant vector with the rejected poles withheld — what the caller should actually
    // measure from. Withheld, not zeroed-and-forgotten: 0 already means "not measured", which
    // is exactly what a pole that failed its gate is.
    accepted: [0, 1, 2, 3].map((i) => (f[i] > 0 && perFormant[i].length === 0 ? f[i] : 0)),
  };
}

// --- F0 in the measurement noise (§5) ---------------------------------------
//
// The physical fact: LPC estimates a formant from the harmonics that happen to fall near it.
// At F0 = 100 Hz an F1 of 500 Hz has harmonics at 400/500/600 to place it between; at
// F0 = 250 Hz it has 250/500/750, and the pole is pulled toward whichever single harmonic is
// nearest ("harmonic attraction"). The error is therefore not constant — it grows with the
// harmonic spacing, and the spacing IS F0.
//
// The standard result is that the bias scales with the spacing relative to the formant's own
// bandwidth, so the VARIANCE scales with F0². That is the model here, with no free parameter
// beyond the reference: at F0_ref the F0 term contributes nothing extra, and above it the
// variance rises as (F0/F0_ref)². At 200 Hz that is 4× the measurement variance of a 100 Hz
// voice, i.e. 2× the standard deviation — which is the band transfeminine users train into
// and precisely where the app has been trusting its formants as though nothing had changed.
//
// This is the ONLY place F0 enters the resonance measurement. It does not enter the score:
// a score that moved with pitch would be reporting pitch twice (§1.4's double count in a
// different costume). It enters how much the score is TRUSTED, which is the honest place for
// a known measurement limitation to live.
export const FORMANT_NOISE_F0_REF_HZ = 100;

export function formantMeasurementNoise({
  baseHz2 = 2500,          // Hz², the existing R_base
  confidence = 0,
  steadiness = 1,
  methodTrust = 1,
  f0Hz = 0,
  f0RefHz = FORMANT_NOISE_F0_REF_HZ,
  minScale = 0.1,
} = {}) {
  const scale = Math.max(minScale, confidence * methodTrust * steadiness);
  const f0Factor = f0Hz > f0RefHz ? (f0Hz / f0RefHz) ** 2 : 1;
  return (baseHz2 / (scale * scale)) * f0Factor;
}

// --- Multi-ceiling LPC search (§5) ------------------------------------------
//
// Praat's analysis ceiling ("maximum formant") sets how much spectrum the all-pole model is
// asked to describe, and the right value is a property of the SPEAKER, not of the algorithm:
// a short tract puts its formants higher, so a ceiling chosen for a 17 cm tract spends poles
// on empty band above a 14 cm tract's F4 and starves the region where its formants actually
// are. The published defaults — 5000 Hz "for men", 5500 Hz "for women" — are a two-point
// lookup on a continuous property, and they are wrong for anyone whose tract is not one of
// the two populations they were measured on. That is most of this app's users.
//
// FormantPath's answer, which this implements: run the analysis at several ceilings over the
// same audio and pick the one whose formant tracks are most self-consistent. The criterion has
// three terms, and each of them is a measurement the caller already has:
//
//   YIELD      how many of the four formants were found and admitted, counted PER FORMANT
//              rather than per frame. A ceiling that puts F3 or F4 above the analysed band
//              loses them, and that has to cost something.
//   SMOOTHNESS mean |Δlog F| per formant per frame. THE core FormantPath term: a ceiling that
//              mis-assigns poles produces tracks that jump between formant numbers, and that
//              shows up as roughness even when every individual frame looks admissible.
//   BANDWIDTH  each admitted pole's bandwidth as a fraction of the bound it had to clear.
//              Praat's own diagnostic for a mismatched ceiling: the model spends pole pairs on
//              empty band, and the poles it does place come out broad.
//
// Cost is a weighted sum, lower is better, and the weights are equal thirds because there is
// no measurement that would justify making one of them larger — stating that plainly is
// better than inventing a ratio.
//
// WHAT IS DELIBERATELY NOT IN THE COST. The first version used the uniform-tube fit quality as
// its third term, and that term is BIASED: fitting three points to a two-parameter series is
// always better than fitting four, so a ceiling scored better for LOSING F4. The bias is not
// small — it is why an early run of tools/lpc-ceiling.mjs selected the lowest candidate,
// 4500 Hz, for a speaker whose F4 sits near 3.9 kHz. Both replacement terms are per-pole
// rather than per-frame, so neither can be improved by finding fewer formants.
//
// LIVE FRAMES USE THE ONE SELECTED CEILING. This search runs during calibration and at a low
// background rate; it is explicitly NOT a per-frame multi-solve, because §3.4 measured that
// three LPC solves per frame at 60 fps is not affordable on a phone, a watch or an ESP32.
export const LPC_CEILING_CANDIDATES_HZ = [4500, 5000, 5512.5, 6000, 6500];
// The ceiling the app has used since the downsampled-LPC path was written: 44100/4/2. It is
// the fallback for any user who has not calibrated, and byte-identical to the pre-Phase-3
// arithmetic (see _resonanceLPC's decimation).
export const LPC_DEFAULT_CEILING_HZ = 5512.5;
// A candidate must be scored on at least this many frames before it can win. Below it the
// smoothness term is estimated from too few steps to separate ceilings.
export const LPC_CEILING_MIN_FRAMES = 20;

// `track` = { ceilingHz, frames: [{ formants:[F1..F4], bandwidths:[B1..B4], valid }] }
export function scoreLpcCeiling(track) {
  const frames = Array.isArray(track && track.frames) ? track.frames : [];
  if (frames.length < LPC_CEILING_MIN_FRAMES) {
    return { ceilingHz: track && track.ceilingHz, cost: Infinity, n: frames.length, reason: 'too-few-frames' };
  }
  const valid = frames.filter((fr) => fr && fr.valid && Array.isArray(fr.formants));
  const frameYield = valid.length / frames.length;

  let found = 0;
  for (const fr of valid) for (let i = 0; i < 4; i++) if (fr.formants[i] > 0) found++;
  const formantYield = found / (4 * frames.length);

  // Smoothness over CONSECUTIVE valid frames only. Stepping across a rejected frame would
  // charge the ceiling for a gap it did not cause.
  let steps = 0, stepSum = 0;
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1], b = frames[k];
    if (!a || !b || !a.valid || !b.valid) continue;
    for (let i = 0; i < 4; i++) {
      const fa = a.formants[i], fb = b.formants[i];
      if (!(fa > 0) || !(fb > 0)) continue;
      stepSum += Math.abs(Math.log(fb / fa));
      steps++;
    }
  }
  const roughness = steps > 0 ? stepSum / steps : 1;

  let bwSum = 0, bwN = 0;
  for (const fr of valid) {
    const bws = fr.bandwidths || [];
    for (let i = 0; i < 4; i++) {
      const f = fr.formants[i], bw = bws[i];
      if (!(f > 0) || !(bw > 0)) continue;
      const bound = Math.max(FORMANT_MAX_BW_FLOOR_HZ, FORMANT_MAX_BW_FRACTION * f + FORMANT_MAX_BW_OFFSET_HZ);
      bwSum += clamp01(bw / bound); bwN++;
    }
  }
  const bwCost = bwN > 0 ? bwSum / bwN : 1;

  // Each term on 0..1 where 0 is best. Roughness is divided by 0.05 — a 5% per-frame log step,
  // which is the scale a well-tracked vowel actually sits at.
  const cost = ((1 - formantYield) + Math.min(1, roughness / 0.05) + bwCost) / 3;
  return { ceilingHz: track.ceilingHz, cost, n: frames.length, frameYield, formantYield, roughness, bwCost };
}

// Returns the winning ceiling plus every candidate's score, because "which ceiling won" is far
// less useful than "by how much, and over what" when the answer has to be defended.
export function selectLpcCeiling(tracks, { defaultCeilingHz = LPC_DEFAULT_CEILING_HZ } = {}) {
  const scored = (Array.isArray(tracks) ? tracks : []).map(scoreLpcCeiling)
    .sort((a, b) => a.cost - b.cost);
  const best = scored.find((s) => Number.isFinite(s.cost));
  if (!best) return { ceilingHz: defaultCeilingHz, selected: false, reason: 'no-usable-candidate', scored };
  const runnerUp = scored.find((s) => s !== best && Number.isFinite(s.cost));
  return {
    ceilingHz: best.ceilingHz,
    selected: true,
    cost: best.cost,
    margin: runnerUp ? runnerUp.cost - best.cost : Infinity,
    scored,
  };
}

// --- Cross-estimator agreement (§3.4) ---------------------------------------
//
// The cross-checks do not vote. §3.4 is explicit that a median of biased estimators is still
// biased and that *which* estimator the median selects can change frame to frame, which is the
// step-change problem restated. So the secondary estimators produce exactly one thing: a
// number saying how far they are from the primary, which lowers confidence when they disagree
// and never touches the value.
//
// Agreement is measured on ΔF rather than on the score, because ΔF is the quantity all four
// estimators actually produce, and because the score's mapping is high-gain (~5 points per 1%
// of ΔF, per DSP_CONTRACT) — measuring agreement after that amplification would report the
// mapping's steepness as estimator disagreement.
//
// THE SCALE IS ONE FORMANT NUMBER, and arriving at that took getting it wrong first.
//
// The first version used the measured between-estimator spread on a clean synthetic vowel —
// 4%, from DSP_CONTRACT's accuracy table (lpc −0%, cepstral −1%, centroid +2%, harmonic −4%) —
// with agreement falling to 0 at three times that. That table is measured on a SUSTAINED
// SYNTHETIC VOWEL with clean, well-separated formants. On connected speech the same estimators'
// pooled ΔF differs by a median 7% (LPC vs cepstral) with the published bias already divided
// out, which is not a failure of either — it is what two very different algorithms do on real
// material. Scored against a 12% floor, that suppressed 88% of a clean recording of read
// speech at the app's live frame rate. A gate that rejects nearly everything is not strict, it
// is mis-scaled.
//
// The right scale comes from asking what a cross-check can actually detect. Two estimators
// tracking the same tract disagree by their own precision; two estimators that have SLIPPED A
// FORMANT NUMBER relative to each other disagree by roughly 1/n of ΔF, which for the three or
// four formants this path fits is about a third. That is the failure worth suppressing a
// reading for, it is a property of the measurement rather than of any recording, and no
// fixture was consulted to pick it.
//
// The evidence for the cross-check is unaffected by this rescaling, which is why the rescaling
// is not a retreat: tools/frame-validity.mjs measures the term's value by comparing its lowest
// and highest QUARTILES (on clean synthetic frames, 23.2% bad against 0.2%), and a quartile
// split is rank-based, so it is identical under any monotone change of scale.
export const CROSS_ESTIMATOR_TOLERANCE = 1 / 9;   // ×3 below = agreement reaches 0 at 1/3 of ΔF

export function crossEstimatorAgreement(primaryDeltaFHz, checkDeltaFHz, {
  toleranceFraction = CROSS_ESTIMATOR_TOLERANCE,
  checkMethod = null,        // when given, the check's published bias is divided out first
  primaryMethod = 'lpc',
  bias = ESTIMATOR_DELTA_F_BIAS,
} = {}) {
  if (!(primaryDeltaFHz > 0) || !(checkDeltaFHz > 0)) return null;   // null = no check ran
  // Correct each side for its own MEASURED bias before comparing. A known bias is not a
  // disagreement — it is a property the accuracy table already records, and leaving it in would
  // mean a correctly-working harmonic estimator could never agree with a correctly-working LPC.
  const bp = (bias && bias[primaryMethod]) || 0;
  const bc = (checkMethod && bias && bias[checkMethod]) || 0;
  const primary = primaryDeltaFHz / (1 + bp);
  const check = checkDeltaFHz / (1 + bc);
  const rel = Math.abs(check - primary) / primary;
  return clamp01(1 - rel / (3 * toleranceFraction));
}

// --- resonanceConfidence (§4) -----------------------------------------------
//
// The architecture diagram's CONFIDENCE MODEL node: "F0 · SNR · path quality · fit residual ·
// cross-estimator agreement". One number, built from named terms, so that when the app declines
// to show a resonance it can say which term was responsible.
//
// IT IS A GEOMETRIC MEAN, NOT A PRODUCT, and that is a correction made after measuring what a
// product does. The diagram's dots read as multiplication and the first implementation took
// them literally, on the argument that these are independent necessary conditions rather than
// competing evidence. Measured on the Rainbow Passage — a clean recording of read speech, the
// case the app must not fail on — the six terms sit at 0.93 / 0.71 / 0.65 / 0.73 / 0.44 / 1.00
// and their product is 0.137. Nothing has failed; the app would have suppressed 48% of it.
//
// The reason is that the terms are not probabilities of independent failures. They are six
// correlated views of the same frame's quality, each on a 0..1 quality scale, and multiplying
// six of those asserts a compounding that is not there. The geometric mean is the right
// aggregator for several graded assessments of one thing on a common scale, and it keeps the
// property the product was chosen for: ANY term at zero takes the whole thing to zero. A frame
// with perfect cross-estimator agreement and no SNR still scores exactly 0 — it is not
// half-good, it is three estimators agreeing on noise.
//
// A term that has not been measured yet (no cross-check has run) is EXCLUDED from the mean
// rather than entered as 1.0, which would quietly raise the result for having measured less.
//
// The F0 term is the same physics as formantMeasurementNoise above, expressed as trust rather
// than as variance: at the reference F0 it is 1, and it falls as the harmonic sampling thins.
// It is deliberately gentler than the variance term (its square root) because F0 degrades
// precision gradually, and a cliff at some pitch would suppress the readout for exactly the
// users training toward a higher one.
export function resonanceConfidence({
  snrConfidence = 0,
  formantConfidence = 0,
  validityRate = 1,        // fraction of recent frames that passed the gates
  fitQuality = 0,
  agreement = null,        // null = no cross-check has run yet; do not penalise for that
  f0Hz = 0,
  f0RefHz = FORMANT_NOISE_F0_REF_HZ,
} = {}) {
  const f0Trust = f0Hz > f0RefHz ? f0RefHz / f0Hz : 1;
  const terms = [snrConfidence, formantConfidence, validityRate, fitQuality, f0Trust]
    .map((t) => clamp01(t));
  if (agreement != null) terms.push(clamp01(agreement));
  let logSum = 0;
  for (const t of terms) {
    if (!(t > 0)) return 0;      // any collapsed term collapses the whole reading
    logSum += Math.log(t);
  }
  return clamp01(Math.exp(logSum / terms.length));
}

// Below this the app shows NO resonance rather than a substitute (§5's "below the SNR floor the
// app shows no resonance rather than a substitute", and D1's "handled by the SNR/confidence
// gate suppressing feedback — not by silently switching to a brightness number that's
// computable from noise but wrong").
//
// 0.15 is a "something is definitely wrong" floor, not a quality bar. Under the geometric mean
// it is very nearly a zero-detector, and that is deliberate: reaching it requires one term to
// be within about a thousandth of zero while the rest are nominal, which is what a collapsed
// SNR, a lost formant structure or a run of frames failing every validity gate actually looks
// like. snrToConfidence returns exactly 0 below the red SNR threshold, so "below the SNR floor
// the app shows no resonance" is exact rather than approximate.
//
// Frames between this and a good reading are shown with reduced vividness, which is what the
// ball already does with confidence. The floor is for the case where showing anything at all
// would be a lie.
export const RESONANCE_CONFIDENCE_FLOOR = 0.15;

// --- spectralBrightness: the demoted centroid (§5) ---------------------------
//
// The centroid is not a resonance estimator and Phase 3 stops it pretending to be one. It
// resolves no F3 (measured: 0% F3 yield on the Rainbow Passage), so it cannot reach the two
// residual dimensions a vowel classification needs, and it cannot fit a tract at all — it
// reports where the spectrum's energy sits, which moves with microphone, loudness (Lombard
// effect) and room as much as with the vocal tract.
//
// It survives as what it actually measures: a secondary brightness feature. D1: "Brightness
// stays available only as an optional secondary display, never as the gate that fires
// haptics."
//
// The 700–2200 Hz range is the Kotlin port's (DSP_CONTRACT records web/Kotlin/C++ disagreeing
// on it); adopting one of the existing ranges rather than inventing a third is the cheapest
// way to stop that particular drift widening.
export const SPECTRAL_BRIGHTNESS_MIN_HZ = 700;
export const SPECTRAL_BRIGHTNESS_MAX_HZ = 2200;

export function spectralBrightness(centroidHz, {
  minHz = SPECTRAL_BRIGHTNESS_MIN_HZ,
  maxHz = SPECTRAL_BRIGHTNESS_MAX_HZ,
} = {}) {
  if (!(centroidHz > 0)) return 0;
  return normalizeAgainstRange(centroidHz, minHz, maxHz);
}

// --- Pooling-window homogeneity, and whether ρ is usable (§5, Phase 2 hand-off) ---
//
// Phase 2 left this exactly here: /ɝ/ is the most isolated vowel in the set (1.18 from its
// nearest neighbour) in the POOLED frame and tied with the closest pairs (0.40) in the
// scale-invariant frame that ships, and the dimension that separates it — ρ = Σ L_i r_i — is
// the same dimension a pooling-window mismatch moves. Using ρ requires knowing what the window
// contained.
//
// This is that measurement. The window is HETEROGENEOUS when its frames' own per-frame scales
// disagree — connected speech, several vowels, ρ carries vowel information — and HOMOGENEOUS
// when they agree, which is a sustained hold, where the window has collapsed onto one vowel
// and ρ → 1 by construction and carries nothing.
//
// Reported as the weighted coefficient of variation of the per-frame ΔF in the pool. Measured
// on the Phase 2 fixtures: a 4 s held /i/ sits near 0 and the Rainbow Passage well above it.
// The threshold below is placed between the two MEASURED values, not tuned against
// classification accuracy — tools/rho-rhotic.mjs reports what admitting ρ does to every vowel,
// not just to /ɝ/, so the trade is visible either way.
export const WINDOW_HETEROGENEITY_CV = 0.05;

export function windowHomogeneity(entries) {
  const usable = (Array.isArray(entries) ? entries : []).filter((e) => e && e.deltaF > 0 && e.weight > 0);
  if (usable.length < 2) return { cv: 0, n: usable.length, homogeneous: true };
  const total = usable.reduce((s, e) => s + e.weight, 0);
  const mean = usable.reduce((s, e) => s + e.deltaF * e.weight, 0) / total;
  if (!(mean > 0)) return { cv: 0, n: usable.length, homogeneous: true };
  const varW = usable.reduce((s, e) => s + e.weight * (e.deltaF - mean) ** 2, 0) / total;
  const cv = Math.sqrt(varW) / mean;
  return { cv, n: usable.length, mean, homogeneous: cv < WINDOW_HETEROGENEITY_CV };
}

// ρ for the ten P&B vowels in the pooled frame, i.e. Σ L_i r_i when the scale is the speaker's
// pooled ΔF rather than that vowel's own. Recomputed from the committed fixture by
// resonance-dprime.test.mjs, exactly as VOWEL_TEMPLATES is, so it cannot drift from the norms.
//
// /ɝ/ at 0.73 against 0.90–1.22 for everything else is the whole of Phase 2's hand-off, stated
// as a number: the rhotic's lowered F3 cannot be absorbed by a scale fitted to the speaker's
// OTHER vowels, so it lands in ρ and nowhere else.
export const VOWEL_POOLED_RHO = {
  i: 1.1882, 'ɪ': 1.0690, 'ɛ': 1.0565, 'æ': 1.0361, 'ɑ': 1.0204,
  'ɔ': 0.9694, 'ʊ': 0.9246, u: 0.9053, 'ʌ': 1.0000, 'ɝ': 0.7212,
};

// ρ IS SPEAKER-INDEPENDENT WHERE IT MATTERS, and that is the result that makes the rest of
// this possible. Across P&B's two populations — 16.5% apart in pooled tract scale — /ɝ/'s ρ is
// 0.7255 (male) and 0.7169 (female): a 1.2% difference, against a 25% gap to the nearest
// non-rhotic vowel. The rhotic signal survives the speaker change that Phase 2 was worried
// about; what it does NOT survive untreated is a change in what the pooling WINDOW held.
//
// Because ρ_v = ΔF_v / ΔF_pooled, a window that happens to hold mostly front vowels raises
// ΔF_pooled and scales EVERY vowel's ρ down by the same factor. An absolute threshold on ρ
// would therefore call /u/ a rhotic during a stretch of /i/ and miss a real /ɝ/ during a
// stretch of /ɑ/. The composition effect is a COMMON factor, though, so dividing it out is
// exactly what a running median over the window's own frames does — and by the definition of
// the pool (weighted median of the frames' own ΔF), that median is ≈ 1 whenever the window is
// representative of itself.
//
// So the usable quantity is ρ relative to the window's own median ρ, not ρ. That is what
// rhoticFromRho takes.
//
// The threshold sits at the geometric midpoint between /ɝ/ (0.7212) and the nearest
// non-rhotic, /u/ (0.9053) — √(0.7212·0.9053) = 0.8080. It is placed between two measured
// norms, not fitted to a classification score: tools/rho-rhotic.mjs sweeps it and reports the
// whole curve, so the cost of moving it is visible without moving it.
export const RHOTIC_RHO_THRESHOLD = 0.8080;

// Reading /ɝ/ off ρ is legitimate only when three things hold at once, and this returns which
// of them did not:
//
//   1. The pooling window is HETEROGENEOUS. In a sustained hold the window collapses onto one
//      vowel, ρ → 1 by construction, and ρ carries no vowel information at all — so a hold on
//      /ɝ/ is invisible in ρ and must not be guessed at from it either.
//   2. The frame passed the validity gates. A swapped or mis-assigned F3 lowers ρ exactly the
//      way a rhotic does; this is the whole reason Phase 2 refused to use ρ, and the gates are
//      the answer to it.
//   3. The window holds enough DISTINCT vowels for its median ρ to mean something. This one is
//      measured rather than assumed: tools/rho-rhotic.mjs sweeps the window's vowel count and
//      the detector holds down to three distinct vowels (0–1 false positives out of 800) and
//      then breaks at two, where it produces 32 — a median over two points is whichever of them
//      is larger, so /u/ and /ʊ/ start reading as rhotics. Three is the floor that measurement
//      puts it at, not a round number.
//
// Returns { rhotic, rhoRelative, reason }. `rhotic: false` with a reason is the honest output
// for "cannot tell", and the caller must not read it as "not a rhotic".
export const RHOTIC_MIN_WINDOW_VOWELS = 3;

export function rhoticFromRho(rho, {
  windowMedianRho = 1,
  heterogeneous = false,
  frameValid = true,
  windowFrames = 0,
  windowVowels = Infinity,
  minWindowFrames = 12,
  minWindowVowels = RHOTIC_MIN_WINDOW_VOWELS,
  threshold = RHOTIC_RHO_THRESHOLD,
} = {}) {
  if (!(rho > 0)) return { rhotic: false, rhoRelative: 0, reason: 'no-rho' };
  if (!frameValid) return { rhotic: false, rhoRelative: 0, reason: 'invalid-frame' };
  if (!heterogeneous) return { rhotic: false, rhoRelative: 0, reason: 'homogeneous-window' };
  if (!(windowFrames >= minWindowFrames)) return { rhotic: false, rhoRelative: 0, reason: 'window-too-short' };
  if (!(windowVowels >= minWindowVowels)) return { rhotic: false, rhoRelative: 0, reason: 'window-too-uniform' };
  const med = windowMedianRho > 0 ? windowMedianRho : 1;
  const rel = rho / med;
  return { rhotic: rel < threshold, rhoRelative: rel, reason: rel < threshold ? 'rhotic' : 'not-rhotic' };
}

