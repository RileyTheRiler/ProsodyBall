import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wav from 'node-wav';

class MockAudioContext {
  constructor() {
    this.sampleRate = 44100;
    this.state = 'running';
    this.destination = {};
  }
  createMediaStreamSource() { return { connect: () => {} }; }
  createMediaElementSource() { return { connect: () => {} }; }
  createAnalyser() {
    return {
      fftSize: 4096,
      frequencyBinCount: 2048,
      smoothingTimeConstant: 0.8,
      getFloatTimeDomainData: (arr) => {
        if (this._currentChunk) {
          arr.set(this._currentChunk.subarray(0, Math.min(arr.length, this._currentChunk.length)));
          // Debug check:
          // console.log("Copied chunk. arr[0]=", arr[0]);
        } else {
          arr.fill(0);
        }
      },
      getFloatFrequencyData: (arr) => arr.fill(-100),
      getByteFrequencyData: (arr) => arr.fill(0)
    };
  }
  createBiquadFilter() {
    return { type: 'highpass', frequency: { value: 2000 }, connect: () => {} };
  }
}

global.document = { getElementById: () => null };
global.window = {
  AudioContext: MockAudioContext,
  webkitAudioContext: MockAudioContext,
  navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } }
};
Object.defineProperty(global, 'navigator', { value: global.window.navigator, writable: true, configurable: true });

async function runEval() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const wavPath = path.join(__dirname, '..', 'fixtures', 'audio-eval', 'rainbow_passage.wav');
  
  if (!fs.existsSync(wavPath)) {
    console.error('Fixture not found:', wavPath);
    process.exit(1);
  }

  const buffer = fs.readFileSync(wavPath);
  const result = wav.decode(buffer);
  
  if (!result || !result.channelData || !result.channelData[0]) {
    console.error('Failed to decode WAV file');
    process.exit(1);
  }

  const audioData = result.channelData[0];
  const sampleRate = result.sampleRate;
  console.log(`Loaded ${wavPath} (${audioData.length} samples at ${sampleRate}Hz)`);

  const { VoiceAnalyzer } = await import('../app.js');
  const analyzer = new VoiceAnalyzer();
  await analyzer.start(null, { deviceId: 'mock' });
  analyzer.audioCtx.sampleRate = sampleRate;

  const chunkSize = 4096;
  const dt = chunkSize / sampleRate;

  let validPitchFrames = 0;
  let totalPitchHz = 0;

  // Pre-calibrate to avoid treating the start of the audio file as noise
  analyzer.isCalibrated = true;
  analyzer.noiseFloor = 0.01;
  analyzer.hfNoiseFloor = 0.001;
  analyzer.micTiltBaselineDb = 0;

  for (let i = 0; i < audioData.length; i += chunkSize) {
    const chunk = audioData.subarray(i, i + chunkSize);
    if (chunk.length < chunkSize) break;
    analyzer.audioCtx._currentChunk = chunk;
    analyzer.update(dt);
    console.log(`Frame: pitch=${analyzer.lastPitch?.toFixed(1)} conf=${analyzer.pitchConfidence?.toFixed(2)} rms=${analyzer.metrics.energy?.toFixed(3)} isCalibrated=${analyzer.isCalibrated}`);

    if (analyzer.pitchConfidence > 0.5 && analyzer.lastPitch > 50) {
      validPitchFrames++;
      totalPitchHz += analyzer.lastPitch;
    }
  }

  const avgPitch = validPitchFrames > 0 ? totalPitchHz / validPitchFrames : 0;
  console.log(`\nEvaluation Results:`);
  console.log(`Voiced Frames (Pitch Conf > 0.5): ${validPitchFrames}`);
  console.log(`Average Pitch (Voiced): ${avgPitch.toFixed(1)} Hz`);

  if (validPitchFrames < 10) {
    console.error('FAIL: Expected to detect significant voiced frames in Rainbow Passage.');
    process.exit(1);
  } else {
    console.log('SUCCESS: Eval harness ran and validated baseline metrics.');
  }
}

runEval().catch(console.error);
