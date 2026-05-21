export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function computeRawProsody(metrics) {
  return (
    metrics.bounce * 0.35 +
    metrics.tempo * 0.20 +
    metrics.vowel * 0.20 +
    metrics.articulation * 0.15 +
    metrics.syllable * 0.10
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

export function sanitizeUrl(url) {
  if (!url) return 'about:blank';
  const urlStr = String(url);
  if (/^(%20|\s)*(javascript|data|vbscript):/i.test(urlStr)) {
    return 'about:blank';
  }
  return urlStr;
}
