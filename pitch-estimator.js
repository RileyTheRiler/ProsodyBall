export function estimatePitchYin(input, {
  sampleRate,
  minHz = 40,
  maxHz = 600,
  threshold = 0.12,
  confidenceFactor = 3,
} = {}) {
  if (!input?.length || !Number.isFinite(sampleRate)) return { hz: 0, confidence: 0 };
  const length = Math.floor(input.length / 2);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) samples[i] = (input[i * 2] + input[i * 2 + 1]) * 0.5;
  const rate = sampleRate / 2;
  const minPeriod = Math.max(2, Math.floor(rate / maxHz));
  const maxPeriod = Math.min(Math.floor(rate / minHz), Math.floor(length / 2));
  if (maxPeriod <= minPeriod) return { hz: 0, confidence: 0 };

  const cmnd = new Float32Array(maxPeriod + 1);
  cmnd[0] = 1;
  let runningSum = 0;
  const windowSize = maxPeriod;
  let sumSq0 = 0;
  let sumSqTau = 0;
  for (let i = 0; i < windowSize; i++) {
    sumSq0 += samples[i] * samples[i];
    sumSqTau += samples[i + 1] * samples[i + 1];
  }
  let bestTau = -1;
  let minimumCmnd = Infinity;

  for (let tau = 1; tau <= maxPeriod; tau++) {
    let correlation = 0;
    for (let i = 0; i < windowSize; i++) correlation += samples[i] * samples[i + tau];
    const difference = Math.max(0, sumSq0 + sumSqTau - 2 * correlation);
    runningSum += difference;
    cmnd[tau] = difference * tau / (runningSum || 1);

    // Bolt Optimization: Early exit for YIN algorithm
    // YIN selects the first local minimum below the threshold. If we find a dip
    // that crosses the threshold and starts rising again, we have found our pitch.
    // Breaking early skips expensive correlation calculations for higher periods,
    // which substantially reduces time spent in the loop.
    if (tau >= minPeriod) {
      if (cmnd[tau] < minimumCmnd) minimumCmnd = cmnd[tau];
      if (bestTau === -1 && cmnd[tau] < threshold && cmnd[tau] > cmnd[tau - 1]) {
        bestTau = tau - 1;
        break;
      }
    }

    if (tau < maxPeriod) {
      const removed = samples[tau];
      const added = samples[tau + windowSize];
      sumSqTau += added * added - removed * removed;
    }
  }

  if (bestTau === -1) {
    for (let tau = minPeriod; tau <= maxPeriod; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= maxPeriod && cmnd[tau + 1] < cmnd[tau]) tau++;
        bestTau = tau;
        break;
      }
    }
    if (bestTau < 0) {
      if (minimumCmnd > 0.4) return { hz: 0, confidence: 0 };
      let minimum = Infinity;
      for (let tau = minPeriod; tau <= maxPeriod; tau++) {
        if (cmnd[tau] < minimum) {
          minimum = cmnd[tau];
          bestTau = tau;
        }
      }
    }
  }

  bestTau = correctOctaveError(cmnd, bestTau, { maxPeriod });
  let period = bestTau;
  if (bestTau > 0 && bestTau < maxPeriod) {
    const a = cmnd[bestTau - 1];
    const b = cmnd[bestTau];
    const c = cmnd[bestTau + 1];
    const denominator = 2 * (2 * b - a - c);
    if (Math.abs(denominator) > 1e-10) period += (a - c) / denominator;
  }
  return {
    hz: rate / period,
    confidence: Math.max(0, Math.min(1, 1 - cmnd[bestTau] * confidenceFactor)),
  };
}
import { correctOctaveError } from './dsp-utils.js';
