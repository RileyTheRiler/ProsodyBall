// Deterministic synthetic vowel: a glottal pulse train through a cascade of Klatt resonators.
//
// The point is that F1/F2/F3 are known EXACTLY, so a measurement made on it has a ground truth
// to be right or wrong about — which recorded speech, however realistic, cannot provide.
//
// This lived inline in resonance-reliability.test.mjs. It is shared from here now because
// tools/resonance-aggregation.mjs needs the same synthesis to build its hold-plus-speech clip,
// and two copies of a signal generator is exactly the semantic drift DSP_CONTRACT exists to
// fence: the reliability test's ground-truth vowel and the aggregation fixture's held vowel
// have to be produced by the same arithmetic or the two reports are not about the same thing.
// The arithmetic is unchanged from that copy.

export function klattResonator(input, freqHz, bwHz, sampleRate) {
  const T = 1 / sampleRate;
  const c = -Math.exp(-2 * Math.PI * bwHz * T);
  const b = 2 * Math.exp(-Math.PI * bwHz * T) * Math.cos(2 * Math.PI * freqHz * T);
  const a = 1 - b - c;
  const out = new Float32Array(input.length);
  let y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const y = a * input[i] + b * y1 + c * y2;
    y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

// `formants` are the resonator centre frequencies in Hz.
export function synthVowel({ f0 = 150, formants = [570, 1710, 2850], seconds = 2.0, sampleRate = 44100 }) {
  const n = Math.round(seconds * sampleRate);
  // Glottal source: one decaying pulse per period. Broadband enough to excite F1-F3.
  const src = new Float32Array(n);
  const period = sampleRate / f0;
  for (let i = 0; i < n; i++) {
    const phase = (i % period) / period;
    src[i] = Math.exp(-phase * 6) * (1 - phase) - 0.12;  // pulse minus DC
  }
  let sig = src;
  const bandwidths = [70, 110, 170];
  for (let k = 0; k < formants.length; k++) {
    sig = klattResonator(sig, formants[k], bandwidths[Math.min(k, bandwidths.length - 1)], sampleRate);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(sig[i]));
  if (peak > 0) for (let i = 0; i < n; i++) sig[i] = (sig[i] / peak) * 0.35;
  return sig;
}
