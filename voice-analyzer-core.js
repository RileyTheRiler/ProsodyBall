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

export function computeFrameReliability({ pitchConfidence = 0, formantConfidence = 0, voicedStrength = 0, spectralTiltConfidence = 0 }) {
  const confidenceGate = clamp01(Math.max(0.2, pitchConfidence * 0.55 + formantConfidence * 0.25 + spectralTiltConfidence * 0.2));
  const voicedGate = clamp01(Math.max(0.25, voicedStrength * 0.75 + pitchConfidence * 0.25));
  const reliableFrame = (pitchConfidence > 0.32 || formantConfidence > 0.36) && voicedStrength > 0.2;
  return { confidenceGate, voicedGate, reliableFrame };
}

// Vocal WEIGHT target (0 = light/breathy, 1 = heavy/thick). Blends independent heaviness cues —
// each a 0..1 heaviness value with its own non-negative blend weight — and renormalises by the
// total weight so cues that are unavailable (weight 0) drop out cleanly while the always-on
// spectral-tilt baseline still yields a sensible value on its own.
//   tiltHeaviness  : 1 - normalised spectral tilt (always present)
//   h1h2Heaviness  : 1 - normalised H1-H2 breathiness (present only with a clean F0)
//   f2Heaviness    : low-F2 darkness contribution (present only with confident formants)
export function computeWeightTarget({
  tiltHeaviness,
  tiltWeight = 1,
  h1h2Heaviness = 0.5,
  h1h2Weight = 0,
  f2Heaviness = 0.5,
  f2Weight = 0
}) {
  const wT = Math.max(0, tiltWeight);
  const wH = Math.max(0, h1h2Weight);
  const wF = Math.max(0, f2Weight);
  const total = wT + wH + wF;
  if (total <= 0) return clamp01(tiltHeaviness);
  return clamp01((tiltHeaviness * wT + h1h2Heaviness * wH + f2Heaviness * wF) / total);
}

// Vocal ATTACK onset hardness (0 = soft/breathy onset, 1 = hard/glottal onset).
//   risePeak/riseCeiling : peak energy-rise rate over its adaptive ceiling (primary cue)
//   onsetAbruptness      : how early within the onset window the rise peaked — impulsive
//                          onsets peak immediately (→1), gradual onsets peak late (→0)
//   abruptWeight         : how much the abruptness cue blends in vs the amplitude-rise cue
//   cleanliness          : down-weights breathy/noisy onsets that lack a clean voiced core
export function computeAttackHardness({
  risePeak,
  riseCeiling,
  cleanliness = 1,
  onsetAbruptness = 0.5,
  abruptWeight = 0
}) {
  const ceil = Math.max(0.02, riseCeiling);
  const riseHardness = clamp01(risePeak / ceil);
  const wA = clamp01(abruptWeight);
  const combined = riseHardness * (1 - wA) + clamp01(onsetAbruptness) * wA;
  return clamp01(combined * (0.5 + 0.5 * clamp01(cleanliness)));
}
