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
