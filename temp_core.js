export class VoiceAnalyzerCore {
  static extractFeatures(rawBuffers, state) {
    // We delegate to an instance so we can reuse buffers via _getBuffer
    if (!this.instance) this.instance = new VoiceAnalyzerCore();
    return this.instance.process(rawBuffers, state);
  }
  constructor() { this._buffers = {}; }

  _getBuffer(name, ArrayType, size) {
    if (!this._buffers[name] || this._buffers[name].length < size) {
      this._buffers[name] = new ArrayType(size);
    }
    return this._buffers[name];
  }

  _percentile(values, p) {
    if (!values.length) return 0;
    // OPTIMIZATION: Use quickselect algorithm to find percentile without fully sorting
    const k = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * p)));
    return this._quickselect([...values], k, 0, values.length - 1);
  }

  _quickselect(arr, k, left, right) {
    while (left < right) {
      const pivotIndex = this._partition(arr, left, right);
      if (pivotIndex === k) {
        return arr[k];
      } else if (k < pivotIndex) {
        right = pivotIndex - 1;
      } else {
        left = pivotIndex + 1;
      }
    }
    return arr[k];
  }

  _aWeightGain(freqHz) {
    if (freqHz < 20) return 0.01;
    const f2 = freqHz * freqHz;
    const f4 = f2 * f2;
    const num = 12194 * 12194 * f4;
    const den = (f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + 12194 * 12194);
    const Ra = num / den;
    const A = 20 * Math.log10(Ra) + 2.0;
    return Math.pow(10, A / 10);
  }

  detectPitch() {
    // timeDomainData already populated by update() — no need to re-read
    const buf = this.timeDomainData;
    const n = buf.length;
    const sampleRate = this.audioCtx.sampleRate;

    // RMS gate (calculated on full buffer for accuracy)
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    const silenceThreshold = this.isCalibrated ? this.noiseFloor * 2.5 : 0.015;
    if (rms < silenceThreshold) return 0;

    // OPTIMIZATION: Downsample by 2x for faster YIN calculation
    // Reduces complexity by ~4x (N^2 -> (N/2)^2)
    const dsRate = sampleRate / 2;
    const dsN = Math.floor(n / 2);
    const dsBuf = this._getBuffer('pitchBuf', Float32Array, dsN);

    // Simple 2x decimation with averaging (low-pass filter)
    for (let i = 0; i < dsN; i++) {
      dsBuf[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5;
    }

    // Adjust params for downsampled rate (Adaptive bounds based on voice profile)
    // Add a 15% safety buffer to variations on the frequency scale
    const safeMinHz = Math.max(40, this.pitchProfile.min * 0.85);
    const safeMaxHz = Math.min(600, this.pitchProfile.max * 1.15);

    // Convert safely to period limits (Inverted: Max Hz maps to Min Period)
    const minPeriod = Math.max(2, Math.floor(dsRate / safeMaxHz)); 
    const maxPeriod = Math.min(Math.floor(dsRate / safeMinHz), Math.floor(dsN / 2));
    const W = maxPeriod; // integration window

    // Step 1 & 2: Difference function d(τ) and CMND d'(τ)
    // OPTIMIZATION: Use running sum of squares to avoid (a-b)^2 in inner loop
    const cmnd = this._getBuffer('cmnd', Float32Array, maxPeriod + 1);
    cmnd[0] = 1.0;
    let runningSum = 0;

    let sumSq0 = 0;
    for (let i = 0; i < W; i++) sumSq0 += dsBuf[i] * dsBuf[i];

    let currentSumSqTau = 0;
    for (let i = 0; i < W; i++) currentSumSqTau += dsBuf[i + 1] * dsBuf[i + 1];

    for (let tau = 1; tau <= maxPeriod; tau++) {
      let crossCorr = 0;
      for (let i = 0; i < W; i++) {
        crossCorr += dsBuf[i] * dsBuf[i + tau];
      }

      let diff = sumSq0 + currentSumSqTau - 2 * crossCorr;
      if (diff < 0) diff = 0; // Floating point noise

      runningSum += diff;
      cmnd[tau] = diff * tau / (runningSum || 1);

      if (tau < maxPeriod) {
        const removeVal = dsBuf[tau];
        const addVal = dsBuf[tau + W];
        currentSumSqTau = currentSumSqTau - removeVal * removeVal + addVal * addVal;
      }
    }

    // Step 3: Absolute threshold — find first dip below threshold
    // This is the key to YIN's octave-error resistance
    const yinThreshold = YIN_THRESHOLD; // Stricter = more accurate, less sensitive
    let bestTau = -1;

    for (let tau = minPeriod; tau <= maxPeriod; tau++) {
      if (cmnd[tau] < yinThreshold) {
        // Walk to the local minimum
        while (tau + 1 <= maxPeriod && cmnd[tau + 1] < cmnd[tau]) {
          tau++;
        }
        bestTau = tau;
        break;
      }
    }

    // Fallback: if no dip below threshold, find global minimum
    if (bestTau < 0) {
      let minVal = Infinity;
      for (let tau = minPeriod; tau <= maxPeriod; tau++) {
        if (cmnd[tau] < minVal) {
          minVal = cmnd[tau];
          bestTau = tau;
        }
      }
      // Reject if global min is still high (likely unvoiced)
      if (minVal > 0.4) return 0;
    }

    // Step 4: Parabolic interpolation for sub-sample accuracy
    let period = bestTau;
    // Capture CMND value at bestTau for confidence scoring
    const cmndAtBest = cmnd[bestTau];
    if (bestTau > 0 && bestTau < maxPeriod) {
      const a = cmnd[bestTau - 1];
      const b = cmnd[bestTau];
      const c = cmnd[bestTau + 1];
      const denom = 2 * (2 * b - a - c);
      if (Math.abs(denom) > 1e-10) {
        period = bestTau + (a - c) / denom;
      }
    }

    const rawHz = dsRate / period;

    // Pitch confidence: CMND < 0.05 = very confident, > 0.3 = unreliable
    // Map inversely: low CMND → high confidence
    this.pitchConfidence = Math.max(0, Math.min(1, 1 - cmndAtBest * PITCH_CONFIDENCE_FACTOR));

    // Step 5: Median filter — suppresses octave jumps
    // Keep a small buffer of recent raw detections
    this._pitchMedianBuf.push(rawHz);
    if (this._pitchMedianBuf.length > 5) this._pitchMedianBuf.shift();

    if (this._pitchMedianBuf.length >= 3) {
      const sorted = [...this._pitchMedianBuf].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }
    return rawHz;
  }

            this._resonanceHarmonicEnvelope(pitch));
          break;

            this._resonanceCepstral(pitch));
          break;

            this._resonanceLPC());
          break;

    const { rootsRe, rootsIm } = this._findLPCRoots(a, order);


            this._resonanceCentroid());
          break;

    return this._peakPickFormants(env, f0, numHarmonics);
  }

  // ============================================
  // RESONANCE METHOD B: Cepstral Smoothing (Refined)
  // True cepstral-style spectral envelope extraction.
  // Improvements over v1:
  //  - Window width = 1.5× harmonic spacing (fully suppresses harmonic ripple)
  //  - Spectral tilt pre-compensation (+6 dB/oct before smoothing)
  //  - Parabolic interpolation at spectral peaks for sub-bin accuracy
  //  - Proper triangular weighting kernel (better sidelobe rejection vs box filter)
  // ============================================
  _resonanceCepstral(pitch) {

  _kalmanUpdate(filter, measurement, measurementNoise) {
    const dt = 1; // 1 frame
    // 1. Predict
    let [x, v] = filter.x;
    let P = filter.P;
    const Q = filter.Q;
    
    if (!filter.initialized) {
      filter.x = [measurement, 0];
      filter.P = [[10000, 0], [0, 1000]];
      filter.initialized = true;
      return measurement;
    }

    // x_pred = F * x
    const x_pred = [x + v * dt, v];
    
    // P_pred = F * P * F^T + Q
    const P_pred = [
      [P[0][0] + dt * P[1][0] + dt * (P[0][1] + dt * P[1][1]) + Q[0][0], P[0][1] + dt * P[1][1] + Q[0][1]],
      [P[1][0] + dt * P[1][1] + Q[1][0], P[1][1] + Q[1][1]]
    ];

    // 2. Update
    // y = z - H * x_pred (H = [1, 0])
    const y = measurement - x_pred[0];
    
    // S = H * P_pred * H^T + R
    const S = P_pred[0][0] + measurementNoise;
    
    // K = P_pred * H^T / S
    const K = [P_pred[0][0] / S, P_pred[1][0] / S];
    
    // x = x_pred + K * y
    filter.x = [x_pred[0] + K[0] * y, x_pred[1] + K[1] * y];
    
    // P = (I - K * H) * P_pred
    filter.P = [
      [(1 - K[0]) * P_pred[0][0], (1 - K[0]) * P_pred[0][1]],
      [-K[1] * P_pred[0][0] + P_pred[1][0], -K[1] * P_pred[0][1] + P_pred[1][1]]
    ];

    return filter.x[0];
  }
}
