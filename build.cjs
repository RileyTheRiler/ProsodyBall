const fs = require('fs');

const oldLines = fs.readFileSync('old_analyzer.js', 'utf8').split('\n');

function getBlock(startText) {
  let start = -1; let end = -1; let b = 0; let found = false;
  for(let i=0; i<oldLines.length; i++) {
    if(!found && oldLines[i].includes(startText)) { start = i; found = true; }
    if(found) {
      for(let c of oldLines[i]) { if(c==='{') b++; else if(c==='}') b--; }
      if(b===0 && start!==i) { end = i; break; }
    }
  }
  return oldLines.slice(start, end+1).join('\n');
}

let methods = [
  '_getBuffer(name, ArrayType, size)',
  '_percentile(values, p)',
  '_quickselect(arr, k, left, right)',
  '_partition(arr, left, right)',
  '_aWeightGain(freqHz)',
  'detectPitch()',
  '_resonanceHarmonicEnvelope(pitch)',
  '_resonanceCepstral(pitch)',
  '_resonanceLPC()',
  '_findLPCRoots(a, order)',
  '_resonanceCentroid()',
  '_peakPickFormants(env, f0, numHarmonics)'
].map(getBlock).join('\n\n  ');

let kalmanBlock = getBlock('_kalmanUpdate(filter, measurement, measurementNoise)');

let coreProcess = `
  process(rawBuffers, state) {
    this.timeDomainData = rawBuffers.timeDomainData;
    this.frequencyData = rawBuffers.frequencyData;
    this.formantFreqData = rawBuffers.formantFreqData;
    this.hfFrequencyData = rawBuffers.hfFrequencyData;
    this.audioCtx = { sampleRate: rawBuffers.sampleRate };
    this.analyser = { fftSize: rawBuffers.fftSize };
    this.analyserFormant = { fftSize: rawBuffers.formantFftSize };

    this.pitchProfile = state.pitchProfile;
    this.noiseFloor = state.noiseFloor;
    this.hfNoiseFloor = state.hfNoiseFloor;
    this.isCalibrated = state.isCalibrated;
    this.noiseSpectralProfile = state.noiseSpectralProfile;
    this.pitchConfidence = state.pitchConfidence;
    this.vowelLikelihood = state.vowelLikelihood;
    this.micTiltBaselineDb = state.micTiltBaselineDb;
    this.spectralTiltSmoothedDb = state.spectralTiltSmoothedDb;
    this.lastPitch = state.lastPitch;
    this.smoothPitchHz = state.smoothPitchHz;
    this.resonanceMethod = state.resonanceMethod;
    if (!this._pitchMedianBuf) this._pitchMedianBuf = [];

    let rms = 0;
    for (let i = 0; i < this.timeDomainData.length; i++) {
      rms += this.timeDomainData[i] * this.timeDomainData[i];
    }
    rms = Math.sqrt(rms / this.timeDomainData.length);
    const gatedRms = Math.max(0, rms - this.noiseFloor);

    let pitch = 0;
    if (rms > this.noiseFloor * 2) {
      pitch = this.detectPitch();
    }

    let hfEnergy = 0;
    for (let i = 0; i < this.hfFrequencyData.length; i++) {
      hfEnergy += this.hfFrequencyData[i];
    }
    hfEnergy = hfEnergy / (this.hfFrequencyData.length * 255);
    hfEnergy = Math.max(0, hfEnergy - this.hfNoiseFloor);
    if (rms < this.noiseFloor * 1.3) hfEnergy = 0;

    if (this.isCalibrated && this.noiseSpectralProfile) {
      for (let i = 0; i < this.frequencyData.length; i++) {
        let signalMag = Math.pow(10, this.frequencyData[i] / 20);
        let noiseMag = this.noiseSpectralProfile[i] || 0;
        let cleanMag = Math.max(0.01 * signalMag, signalMag - 1.5 * noiseMag);
        this.frequencyData[i] = cleanMag > 1e-10 ? 20 * Math.log10(cleanMag) : -200;
      }
    }
    
    const fftBinHz = this.audioCtx.sampleRate / this.analyser.fftSize;
    const eps = 1e-12;
    const activeF0 = pitch > 0 ? pitch : (this.lastPitch > 0 ? this.lastPitch : this.smoothPitchHz || 160);
    const lowStartHz = Math.max(70, activeF0 * 0.5);
    const lowEndHz = Math.min(2200, activeF0 * 3.5);
    const highStartHz = 2500;
    const highEndHz = Math.min(5000, this.audioCtx.sampleRate * 0.5 - fftBinHz);

    const sumBandPowerAWeighted = (loHz, hiHz) => {
      if (hiHz <= loHz) return 0;
      const startBin = Math.max(0, Math.floor(loHz / fftBinHz));
      const endBin = Math.min(this.frequencyData.length - 1, Math.ceil(hiHz / fftBinHz));
      if (endBin < startBin) return 0;
      let sum = 0;
      for (let i = startBin; i <= endBin; i++) {
        const freqHz = i * fftBinHz;
        const mag = Math.pow(10, this.frequencyData[i] / 20);
        sum += mag * mag * this._aWeightGain(freqHz);
      }
      return sum;
    };

    const eLowTilt = sumBandPowerAWeighted(lowStartHz, lowEndHz);
    const eHighTilt = sumBandPowerAWeighted(highStartHz, highEndHz);
    let rawTiltDb = 10 * Math.log10((eHighTilt + eps) / (eLowTilt + eps));
    if (!isFinite(rawTiltDb)) rawTiltDb = this.spectralTiltSmoothedDb;
    rawTiltDb -= this.micTiltBaselineDb;

    let h1 = 0, h2 = 0;
    if (pitch > 0 && this.pitchConfidence > 0.4 && activeF0 > 0) {
      const hSearch = Math.max(1, Math.floor((activeF0 / fftBinHz) * 0.25));
      const harmonicPeakDb = (centerHz) => {
        const center = centerHz / fftBinHz;
        const lo = Math.max(1, Math.floor(center) - hSearch);
        const hi = Math.min(this.frequencyData.length - 1, Math.ceil(center) + hSearch);
        let peak = -Infinity;
        for (let i = lo; i <= hi; i++) if (this.frequencyData[i] > peak) peak = this.frequencyData[i];
        return peak;
      };
      h1 = harmonicPeakDb(activeF0);
      h2 = harmonicPeakDb(activeF0 * 2);
    }

    const binHz = this.audioCtx.sampleRate / this.analyser.fftSize;
    const bandEnergy = (lo, hi) => {
      const startBin = Math.floor(lo / binHz);
      const endBin = Math.min(Math.ceil(hi / binHz), this.frequencyData.length - 1);
      let sum = 0;
      for (let i = startBin; i <= endBin; i++) {
        sum += Math.pow(10, this.frequencyData[i] / 20);
      }
      return sum / Math.max(1, endBin - startBin + 1);
    };

    const eLow = bandEnergy(250, 900);
    const eMid = bandEnergy(900, 2800);
    const eHigh = bandEnergy(2800, 6000);
    const eTotal = eLow + eMid + eHigh + 0.0001;

    const vowelRatio = (eLow + eMid) / eTotal;
    const fricativeRatio = eHigh / eTotal;
    const hasEnough = gatedRms > state.sustainedThreshold;
    const rawVowelLike = hasEnough ? Math.max(0, vowelRatio - fricativeRatio) : 0;

    let f1Candidate = 0, f2Candidate = 0, f3Candidate = 0, conf = 0;
    if (pitch > 0 && this.pitchConfidence > 0.4 && state.vowelLikelihood > 0.25) {
      if (this.isCalibrated && this.noiseSpectralProfile) {
        for (let i = 0; i < this.formantFreqData.length; i++) {
          let signalMag = Math.pow(10, this.formantFreqData[i] / 20);
          let noiseMag = this.noiseSpectralProfile[i] || 0;
          let cleanMag = Math.max(0.01 * signalMag, signalMag - 1.5 * noiseMag);
          this.formantFreqData[i] = cleanMag > 1e-10 ? 20 * Math.log10(cleanMag) : -200;
        }
      }
      switch (this.resonanceMethod) {
        case 'harmonic':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } = this._resonanceHarmonicEnvelope(pitch));
          break;
        case 'cepstral':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } = this._resonanceCepstral(pitch));
          break;
        case 'lpc':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } = this._resonanceLPC());
          break;
        case 'centroid':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } = this._resonanceCentroid());
          break;
        default:
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } = this._resonanceHarmonicEnvelope(pitch));
      }
    }

    return {
      rms,
      gatedRms,
      pitch,
      pitchConfidence: this.pitchConfidence,
      rawTiltDb,
      h1,
      h2,
      rawVowelLike,
      f1: f1Candidate,
      f2: f2Candidate,
      f3: f3Candidate,
      formantConf: conf,
      hfEnergy,
      rawHfFreqData: this.hfFrequencyData,
      rawFreqData: this.frequencyData,
      sampleRate: this.audioCtx.sampleRate,
      fftSize: this.analyser.fftSize
    };
  }
`;

let baseCore = fs.readFileSync('voice-analyzer-core.js', 'utf8');
if(baseCore.includes('export class VoiceAnalyzerCore')) {
  baseCore = baseCore.split('export class VoiceAnalyzerCore')[0];
}

let fullCore = baseCore + '\n\n' +
'export class VoiceAnalyzerCore {\n' +
'  static extractFeatures(rawBuffers, state) {\n' +
'    if (!this.instance) this.instance = new VoiceAnalyzerCore();\n' +
'    return this.instance.process(rawBuffers, state);\n' +
'  }\n\n' +
'  constructor() {\n' +
'    this._buffers = {};\n' +
'    this._pitchMedianBuf = [];\n' +
'  }\n\n' +
coreProcess + '\n\n' +
methods + '\n' +
'}\n';

fs.writeFileSync('voice-analyzer-core.js', fullCore);

let cons = getBlock('constructor()');
let stateBody = `import { clamp01, computeFrameReliability, normalizeAgainstPercentiles, normalizeAgainstRange, computeWeightTarget, computeAttackHardness } from './dsp-utils.js';

const BOUNCE_NORM_DIVISOR = 35;
const TEMPO_TRANSITION_DIVISOR = 8;
const ARTIC_SENSITIVITY_GAIN = 1.35;
const VOWEL_ONSET_SECS = 0.05;
const VOWEL_SATURATION_SECS = 0.35;
const SYLLABLE_ON_MULT = 1.1;
const SYLLABLE_OFF_MULT = 0.4;
const VOWEL_SUSTAIN_MULT = 0.6;
const SYLLABLE_DEBOUNCE_SECS = 0.15;
const SYLLABLE_IMPULSE_DECAY = 0.82;
const ATTACK_RISE_WINDOW_SECS = 0.08;
const ATTACK_IMPULSE_DECAY = 0.85;
const ATTACK_RISE_LEARN_RATE = 0.10;
const ATTACK_ABRUPT_BLEND = 0.25;
const WEIGHT_TILT_BASE = 0.6;
const WEIGHT_F2_BLEND = 0.2;
const WEIGHT_H1H2_BLEND = 0.2;
const WEIGHT_SMOOTH_BASE = 0.06;
const H1H2_HEAVY_DB = -5;
const H1H2_LIGHT_DB = 8;

export class VoiceAnalyzerState {
  ${cons}

  _percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    } else {
      return sorted[base];
    }
  }

  ${kalmanBlock}

  commitFrame(rawFrameMetrics, dt) {
    const {
      rms, gatedRms, pitch, pitchConfidence, rawTiltDb,
      h1, h2, rawVowelLike, f1, f2, f3, formantConf, hfEnergy,
      rawHfFreqData, rawFreqData, sampleRate, fftSize
    } = rawFrameMetrics;

    const now = performance.now() / 1000;

    this.pitchConfidence = pitchConfidence;

    if (!this.isCalibrated) {
      this.noiseCalibrationTimer += dt;
      this.noiseCalibrationSamples.push(rms);
      
      let hfSample = 0;
      for (let i = 0; i < rawHfFreqData.length; i++) hfSample += rawHfFreqData[i];
      this.hfCalibrationSamples.push(hfSample / (rawHfFreqData.length * 255));

      if (!this.noiseSpectralProfile) {
        this.noiseSpectralProfile = new Float32Array(rawFreqData.length);
      }
      const fftBinHz = sampleRate / fftSize;
      const activeF0 = 160; 
      const lowStartHz = Math.max(70, activeF0 * 0.5);
      const lowEndHz = Math.min(2200, activeF0 * 3.5);
      const highStartHz = 2500;
      const highEndHz = Math.min(5000, sampleRate * 0.5 - fftBinHz);
      const eps = 1e-12;

      let eLowTilt = 0, eHighTilt = 0;

      for (let i = 0; i < rawFreqData.length; i++) {
        const linearMag = Math.pow(10, rawFreqData[i] / 20);
        this.noiseSpectralProfile[i] += linearMag;

        const freqHz = i * fftBinHz;
        
        const f2_sq = freqHz * freqHz;
        const f4 = f2_sq * f2_sq;
        const den = (f2_sq + 424.36) * Math.sqrt((f2_sq + 11599.29) * (f2_sq + 544496.41)) * (f2_sq + 148693636);
        const aWeight = 1.2588966 * 148693636 * f4 / den;

        const powerA = linearMag * linearMag * aWeight;
        if (freqHz >= lowStartHz && freqHz <= lowEndHz) {
          eLowTilt += powerA;
        } else if (freqHz >= highStartHz && freqHz <= highEndHz) {
          eHighTilt += powerA;
        }
      }

      let calibRawTiltDb = 10 * Math.log10((eHighTilt + eps) / (eLowTilt + eps));
      if (isFinite(calibRawTiltDb)) this.micCalibrationTiltSamples.push(calibRawTiltDb);

      if (this.noiseCalibrationTimer >= this.noiseCalibrationDuration) {
        const samples = this.noiseCalibrationSamples;
        let sum = 0, sqSum = 0;
        for (let i = 0; i < samples.length; i++) {
          sum += samples[i];
          sqSum += samples[i] * samples[i];
        }
        const mean = sum / samples.length;
        const std = Math.sqrt(Math.max(0, (sqSum / samples.length) - (mean * mean)));
        this.noiseFloor = Math.max(0.01, mean + std * 4);
        this.syllableThreshold = this.noiseFloor * 1.2;
        this.sustainedThreshold = this.noiseFloor * 1.5;

        const hfSamples = this.hfCalibrationSamples;
        let hfSum = 0, hfSqSum = 0;
        for (let i = 0; i < hfSamples.length; i++) {
          hfSum += hfSamples[i];
          hfSqSum += hfSamples[i] * hfSamples[i];
        }
        const hfMean = hfSum / hfSamples.length;
        const hfStd = Math.sqrt(Math.max(0, (hfSqSum / hfSamples.length) - (hfMean * hfMean)));
        this.hfNoiseFloor = hfMean + hfStd * 2;
        this.isCalibrated = true;

        if (this.micCalibrationTiltSamples.length > 0) {
          const sorted = [...this.micCalibrationTiltSamples].sort((a, b) => a - b);
          this.micTiltBaselineDb = sorted[Math.floor(sorted.length / 2)];
        }
        if (this.noiseSpectralProfile) {
          for (let i = 0; i < this.noiseSpectralProfile.length; i++) {
            this.noiseSpectralProfile[i] /= this.noiseCalibrationSamples.length;
          }
        }
        console.log(\`Noise calibrated: floor=\${(this.noiseFloor * 1000).toFixed(1)}mRMS, hfFloor=\${this.hfNoiseFloor.toFixed(4)}, micTilt=\${this.micTiltBaselineDb.toFixed(1)}dB\`);
      }
      return;
    }

    if (rms < this.noiseFloor * 1.5 && rms > 0.001) {
      this.noiseFloor += (rms * 1.2 - this.noiseFloor) * this.noiseAdaptRate;
      this.noiseFloor = Math.max(0.005, this.noiseFloor);
      this.syllableThreshold = this.noiseFloor * 1.2;
      this.sustainedThreshold = this.noiseFloor * 1.5;
    }

    this.smoothEnergy += (gatedRms - this.smoothEnergy) * 0.15;
    this.energyHistory.push(gatedRms);
    if (this.energyHistory.length > this.energyHistoryMax) this.energyHistory.shift();
    this.energyBaselineWindow.push(gatedRms);
    if (this.energyBaselineWindow.length > this.energyBaselineWindowMax) this.energyBaselineWindow.shift();
    if (this.energyBaselineWindow.length >= 12) {
      this.energyPercentiles.p50 = this._percentile(this.energyBaselineWindow, 0.5);
      this.energyPercentiles.p75 = this._percentile(this.energyBaselineWindow, 0.75);
      this.energyPercentiles.p90 = this._percentile(this.energyBaselineWindow, 0.9);
    }

    if (pitch > 0) {
      this.lastPitch = pitch;
      this.pitchHistory.push(pitch);
      if (this.pitchHistory.length > this.pitchHistoryMax) this.pitchHistory.shift();
      if (this.pitchConfidence > 0.4) {
        const lerpRate = 0.08 + this.pitchConfidence * 0.12; 
        this.smoothPitchHz += (pitch - this.smoothPitchHz) * lerpRate;
        if (!this.pitchProfile.isLearned) {
          this.pitchProfile.samples.push(pitch);
          this.pitchProfile.voicedTime += dt;
          if (this.pitchProfile.voicedTime >= this.pitchProfile.learningDuration || this.pitchProfile.samples.length > 200) {
            const sorted = [...this.pitchProfile.samples].sort((a, b) => a - b);
            const p05 = sorted[Math.floor(sorted.length * 0.05)];
            const p95 = sorted[Math.floor(sorted.length * 0.95)];
            this.pitchProfile.min = Math.max(50, p05 * 0.85);
            this.pitchProfile.max = Math.min(800, p95 * 1.25);
            this.pitchProfile.isLearned = true;
          }
        }
      }
    }

    if (hfEnergy > 0) {
      this.hfEnergyWindow.push(hfEnergy);
      if (this.hfEnergyWindow.length > this.hfEnergyWindowMax) this.hfEnergyWindow.shift();
      if (this.hfEnergyWindow.length >= 8) {
        this.hfPercentiles.p50 = this._percentile(this.hfEnergyWindow, 0.5);
        this.hfPercentiles.p90 = this._percentile(this.hfEnergyWindow, 0.9);
      }
    }

    this.spectralTiltRawDb = rawTiltDb;
    this.spectralTiltSmoothedDb += (rawTiltDb - this.spectralTiltSmoothedDb) * 0.16;

    if (pitch > 0 && this.pitchConfidence > 0.4) {
      if (!this.tiltProfile.isLearned) {
        this.tiltProfile.samples.push(this.spectralTiltSmoothedDb);
        this.tiltProfile.voicedTime += dt;
        if (this.tiltProfile.voicedTime >= this.tiltProfile.learningDuration || this.tiltProfile.samples.length > 200) {
          const sorted = [...this.tiltProfile.samples].sort((a, b) => a - b);
          const p10 = sorted[Math.floor(sorted.length * 0.10)];
          const p90 = sorted[Math.floor(sorted.length * 0.90)];
          const median = sorted[Math.floor(sorted.length * 0.5)];
          const spread = Math.max(16, p90 - p10);
          this.tiltProfile.min = median - spread * 0.55;
          this.tiltProfile.max = median + spread * 0.45;
          this.tiltProfile.isLearned = true;
        }
      }
    }

    const heavyAnchorDb = this.tiltProfile.isLearned ? this.tiltProfile.min : -34;
    const lightAnchorDb = this.tiltProfile.isLearned ? this.tiltProfile.max : -4;
    const normalizedTilt = normalizeAgainstRange(this.spectralTiltSmoothedDb, heavyAnchorDb, lightAnchorDb);
    const tiltConfidenceGate = rms > this.noiseFloor * 1.35 ? 1 : Math.max(0, (rms - this.noiseFloor) / Math.max(1e-6, this.noiseFloor * 0.5 || 1e-6));
    this.spectralWeight += (normalizedTilt - this.spectralWeight) * (0.12 + tiltConfidenceGate * 0.2);
    this.spectralTiltConfidence += (tiltConfidenceGate - this.spectralTiltConfidence) * 0.2;

    if (isFinite(h1) && isFinite(h2)) {
      this.h1h2SmoothedDb += ((h1 - h2) - this.h1h2SmoothedDb) * 0.16;
      this.h1h2Confidence += (clamp01(this.pitchConfidence) - this.h1h2Confidence) * 0.2;
    } else {
      this.h1h2Confidence *= 0.9;
    }

    this.vowelLikelihood += (rawVowelLike - this.vowelLikelihood) * 0.2;

    if (pitch > 0 && this.pitchConfidence > 0.4 && this.vowelLikelihood > 0.25) {
      const methodTrustMap = { lpc: 1.0, harmonic: 0.7, cepstral: 0.5, centroid: 0.3 };
      const methodTrust = methodTrustMap[this.resonanceMethod] || methodTrustMap.harmonic;
      const R_base = 2500; 
      const R_scale = Math.max(0.1, formantConf * methodTrust);
      const R = R_base / (R_scale * R_scale);

      if (f1 > 0) this.smoothF1 = this._kalmanUpdate(this._kalmanF1, f1, R);
      if (f2 > 0) this.smoothF2 = this._kalmanUpdate(this._kalmanF2, f2, R);
      if (f3 > 0) this.smoothF3 = this._kalmanUpdate(this._kalmanF3, f3, R);
      this.formantConfidence += (formantConf - this.formantConfidence) * 0.15;

      const f2Score = Math.max(0, Math.min(1, (this.smoothF2 - 1000) / 1800));
      const f1Score = Math.max(0, Math.min(1, (this.smoothF1 - 300) / 600));
      const f3Score = Math.max(0, Math.min(1, (this.smoothF3 - 2200) / 1200));
      const rawResonance = f2Score * 0.70 + f1Score * 0.15 + f3Score * 0.15;
      this.smoothResonance += (rawResonance - this.smoothResonance) * (0.05 + formantConf * 0.08);
    } else {
      this.formantConfidence *= 0.95;
      if (this._kalmanF1 && this._kalmanF1.initialized) this.smoothF1 = this._kalmanUpdate(this._kalmanF1, this.smoothF1, 1e6);
      if (this._kalmanF2 && this._kalmanF2.initialized) this.smoothF2 = this._kalmanUpdate(this._kalmanF2, this.smoothF2, 1e6);
      if (this._kalmanF3 && this._kalmanF3.initialized) this.smoothF3 = this._kalmanUpdate(this._kalmanF3, this.smoothF3, 1e6);
    }

    if (this.pitchHistory.length > 3) {
      const len = this.pitchHistory.length;
      let sum = 0;
      for (let i = 0; i < len; i++) sum += this.pitchHistory[i];
      const mean = sum / len;
      let sqSum = 0;
      for (let i = 0; i < len; i++) {
        const diff = this.pitchHistory[i] - mean;
        sqSum += diff * diff;
      }
      const variance = sqSum / len;
      this.metrics.bounce = Math.min(1, Math.sqrt(variance) / BOUNCE_NORM_DIVISOR);
    } else {
      this.metrics.bounce *= 0.95;
    }

    const baseEnergyRange = Math.max(0.001, this.energyPercentiles.p90 - this.energyPercentiles.p50);

    if (this.energyHistory.length > 5) {
      let transitions = 0;
      const thresh = this.energyPercentiles.p50 + baseEnergyRange * 0.5;
      for (let i = 1; i < this.energyHistory.length; i++) {
        if ((this.energyHistory[i - 1] > thresh) !== (this.energyHistory[i] > thresh)) transitions++;
      }
      this.metrics.tempo = Math.min(1, transitions / TEMPO_TRANSITION_DIVISOR);
    }

    const dynamicSustainThreshold = this.energyPercentiles.p50 + baseEnergyRange * VOWEL_SUSTAIN_MULT;
    const isVowelSound = gatedRms > dynamicSustainThreshold && pitch > 0 && this.vowelLikelihood > 0.3;
    if (isVowelSound) {
      this.sustainedDuration += dt * (0.5 + this.vowelLikelihood * 0.5);
    } else {
      this.sustainedDuration *= 0.85;
    }
    this.metrics.vowel = Math.min(1, Math.max(0, this.sustainedDuration - VOWEL_ONSET_SECS) / VOWEL_SATURATION_SECS);

    const hfCeiling = this.hfEnergyWindow.length >= 8
      ? Math.max(this.hfPercentiles.p90, this.hfNoiseFloor + 0.02)
      : Math.max(this.hfNoiseFloor + 0.02, this.hfNoiseFloor * 3.5);
    const articTarget = normalizeAgainstPercentiles(hfEnergy, this.hfNoiseFloor, hfCeiling, ARTIC_SENSITIVITY_GAIN);
    this.metrics.articulation += (articTarget - this.metrics.articulation) * 0.3;

    const riseRate = Math.max(0, gatedRms - this.prevGatedRms) / Math.max(1e-3, dt);
    this.prevGatedRms = gatedRms;

    const dynamicSyllableOn = this.energyPercentiles.p50 + baseEnergyRange * SYLLABLE_ON_MULT;
    const dynamicSyllableOff = this.energyPercentiles.p50 + baseEnergyRange * SYLLABLE_OFF_MULT;
    const syllableOnThreshold = Math.max(0.005, dynamicSyllableOn);
    const syllableOffThreshold = Math.max(0.002, dynamicSyllableOff);
    if (gatedRms > syllableOnThreshold && this.syllableState === 'silent') {
      if (now - this.lastSyllableTime > SYLLABLE_DEBOUNCE_SECS) {
        this.lastSyllableTime = now;
        this.syllableImpulse = 1.0;
        this.attackWindowTimer = 0;
        this.attackRisePeak = riseRate;
        this.attackPeakTime = 0;
      }
      this.syllableState = 'voiced';
    } else if (gatedRms < syllableOffThreshold) {
      this.syllableState = 'silent';
    }
    this.syllableImpulse *= SYLLABLE_IMPULSE_DECAY;
    this.metrics.syllable = this.syllableImpulse;

    if (this.attackWindowTimer >= 0) {
      this.attackWindowTimer += dt;
      if (riseRate > this.attackRisePeak) {
        this.attackRisePeak = riseRate;
        this.attackPeakTime = this.attackWindowTimer;
      }
      if (this.attackWindowTimer >= ATTACK_RISE_WINDOW_SECS) {
        if (this.pitchConfidence > 0.35 || this.formantConfidence > 0.35) {
          const k = this.attackRisePeak > this.attackRiseCeiling ? 0.30 : ATTACK_RISE_LEARN_RATE;
          this.attackRiseCeiling += (this.attackRisePeak - this.attackRiseCeiling) * k;
        }
        const cleanliness = clamp01(this.pitchConfidence) * (1 - 0.5 * clamp01(this.metrics.articulation));
        const onsetAbruptness = 1 - clamp01(this.attackPeakTime / ATTACK_RISE_WINDOW_SECS);
        const hardness = computeAttackHardness({
          risePeak: this.attackRisePeak,
          riseCeiling: this.attackRiseCeiling,
          cleanliness,
          onsetAbruptness,
          abruptWeight: ATTACK_ABRUPT_BLEND
        });
        this.attackImpulse = Math.max(this.attackImpulse, hardness);
        this.attackRiseHardness = clamp01(this.attackRisePeak / Math.max(1e-6, this.attackRiseCeiling));
        this.attackAbruptness = onsetAbruptness;
        this.attackWindowTimer = -1; 
      }
    }
    this.attackImpulse *= ATTACK_IMPULSE_DECAY;
    this.metrics.attack = this.attackImpulse;

    const voicedStrength = normalizeAgainstPercentiles(gatedRms, this.energyPercentiles.p50, this.energyPercentiles.p90, 1);
    const pitchGate = pitch > 0 ? 1 : 0.35;
    const { confidenceGate, voicedGate, reliableFrame } = computeFrameReliability({
      pitchConfidence: this.pitchConfidence,
      formantConfidence: this.formantConfidence,
      voicedStrength,
      spectralTiltConfidence: this.spectralTiltConfidence,
      wasLastFrameReliable: this.wasLastFrameReliable
    });
    this.wasLastFrameReliable = reliableFrame;

    if (!reliableFrame && gatedRms < this.energyPercentiles.p75) {
      this.metrics.bounce *= 0.95;
      this.metrics.tempo *= 0.98;
    } else {
      this.metrics.bounce *= confidenceGate * pitchGate;
      this.metrics.tempo *= voicedGate;
    }

    this.metrics.articulation *= Math.max(0.25, voicedGate * 0.8 + confidenceGate * 0.2);
    this.metrics.syllable *= voicedGate;
    this.metrics.attack *= Math.max(0.2, voicedGate);

    const pitchRange = Math.max(50, this.pitchProfile.max - this.pitchProfile.min);
    this.metrics.pitch = pitch > 0 ? Math.max(0, Math.min(1, (pitch - this.pitchProfile.min) / pitchRange)) : this.metrics.pitch * 0.95;
    this.metrics.energy = normalizeAgainstPercentiles(gatedRms, this.energyPercentiles.p50, this.energyPercentiles.p90, 1.1);
    this.metrics.resonance = this.smoothResonance;

    const heavinessTilt = 1 - this.spectralWeight;
    let f2Heavy = 0.5, f2W = 0;
    if (this.formantConfidence > 0.3) {
      f2Heavy = clamp01((2400 - this.smoothF2) / 1300); 
      f2W = WEIGHT_F2_BLEND;
    }
    const h1h2Light = normalizeAgainstRange(this.h1h2SmoothedDb, H1H2_HEAVY_DB, H1H2_LIGHT_DB);
    const weightTarget = computeWeightTarget({
      tiltHeaviness: heavinessTilt,
      tiltWeight: WEIGHT_TILT_BASE,
      h1h2Heaviness: 1 - h1h2Light,
      h1h2Weight: WEIGHT_H1H2_BLEND * this.h1h2Confidence,
      f2Heaviness: f2Heavy,
      f2Weight: f2W
    });
    if (this.spectralTiltConfidence > 0.2) {
      this.weightSmoothed += (weightTarget - this.weightSmoothed) * (WEIGHT_SMOOTH_BASE + this.spectralTiltConfidence * 0.18);
    }
    this.metrics.weight = this.weightSmoothed;

    this.frameConfidence = reliableFrame ? confidenceGate : 0.15;
  }
}
`;

fs.writeFileSync('voice-analyzer-state.js', stateBody);
console.log('Saved voice-analyzer-state.js');
