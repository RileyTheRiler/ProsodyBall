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
  return { ok: ctx.state === 'running', message: ctx.state };
}
