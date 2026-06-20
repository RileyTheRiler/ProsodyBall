// Synthetic-audio helpers for ground-truth DSP testing.
// Generates source-filter vowels with KNOWN formants and a verified radix-2 FFT,
// so the formant estimators can be measured against ground truth (not drift).

// Iterative radix-2 Cooley-Tukey FFT (in-place). re/im are Float64Array of
// length N (power of two). Transforms in place.
export function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// Produce a dB magnitude spectrum (length fftSize/2) the way an AnalyserNode
// roughly would: Hann window + FFT + 20*log10(normalized magnitude). The
// formant estimators only use relative peak positions, so the exact dB
// reference is unimportant — peak frequencies are what matter.
export function magnitudeSpectrumDb(timeBuf, fftSize) {
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const N = Math.min(fftSize, timeBuf.length);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)); // Hann
    re[i] = timeBuf[i] * w;
  }
  fft(re, im);
  const half = fftSize / 2;
  const out = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / fftSize;
    out[i] = mag > 1e-12 ? 20 * Math.log10(mag) : -240;
  }
  return out;
}

// Source-filter vowel: glottal impulse train at f0 cascaded through 2-pole
// resonators at the given formant frequencies/bandwidths.
// formants: [{ f, bw }]. Returns Float32Array of `length` samples.
export function synthVowel({ f0 = 120, formants, sampleRate = 44100, length = 4096 }) {
  const x = new Float32Array(length);
  const period = Math.round(sampleRate / f0);
  for (let i = 0; i < length; i += period) x[i] = 1; // impulse train

  // Glottal source shaping: a real glottal source rolls off ~-12 dB/octave, not
  // flat. Approximate it with two one-pole low-passes (~120 Hz) so the spectral
  // tilt the estimators expect (and partially compensate) is physically present.
  const a = Math.exp((-2 * Math.PI * 120) / sampleRate);
  let signal = x;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(length);
    let y1 = 0;
    for (let i = 0; i < length; i++) {
      y1 = (1 - a) * signal[i] + a * y1;
      out[i] = y1;
    }
    signal = out;
  }
  for (const { f, bw } of formants) {
    const r = Math.exp((-Math.PI * bw) / sampleRate);
    const theta = (2 * Math.PI * f) / sampleRate;
    const a1 = 2 * r * Math.cos(theta);
    const a2 = -(r * r);
    const out = new Float32Array(length);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < length; i++) {
      const y = signal[i] + a1 * y1 + a2 * y2;
      out[i] = y;
      y2 = y1;
      y1 = y;
    }
    signal = out;
  }

  // Normalize to ~unit peak so it clears the analyzer's silence gate.
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(signal[i]));
  if (peak > 0) {
    const g = 0.8 / peak;
    for (let i = 0; i < length; i++) signal[i] *= g;
  }
  return signal;
}

// Standard (male, ~Peterson-Barney) vowel formant targets, Hz.
export const VOWELS = {
  a: { f0: 120, formants: [{ f: 730, bw: 60 }, { f: 1090, bw: 90 }, { f: 2440, bw: 120 }] },
  i: { f0: 120, formants: [{ f: 270, bw: 50 }, { f: 2290, bw: 100 }, { f: 3010, bw: 140 }] },
  u: { f0: 120, formants: [{ f: 300, bw: 50 }, { f: 870, bw: 80 }, { f: 2240, bw: 120 }] },
  e: { f0: 120, formants: [{ f: 530, bw: 60 }, { f: 1840, bw: 100 }, { f: 2480, bw: 130 }] }
};
