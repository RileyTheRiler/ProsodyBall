import { VoiceAnalyzerEngine } from './voice-analyzer-engine.js';
import { VoiceAnalyzerCore } from './voice-analyzer-core.js';
import { VoiceAnalyzerState } from './voice-analyzer-state.js';

export class VoiceAnalyzer {
  constructor() {
    this.engine = new VoiceAnalyzerEngine();
    this.state = new VoiceAnalyzerState();
  }

  async start(audioFile = null, inputOptions = {}) {
    return this.engine.start(audioFile, inputOptions);
  }

  stop() {
    this.engine.stop();
  }

  update(dt) {
    const rawBuffers = this.engine.getFrameBuffers();
    if (!rawBuffers) return;
    const rawFrameMetrics = VoiceAnalyzerCore.extractFeatures(rawBuffers, this.state);
    this.state.commitFrame(rawFrameMetrics, dt);
  }

  get isActive() { return this.engine.isActive; }
  get metrics() { return this.state.metrics; }
  get frameConfidence() { return this.state.frameConfidence; }
  get resonanceMethod() { return this.state.resonanceMethod; }
  set resonanceMethod(val) { this.state.resonanceMethod = val; }
  get isCalibrated() { return this.state.isCalibrated; }

  get pitchProfile() { return this.state.pitchProfile; }
  get tiltProfile() { return this.state.tiltProfile; }
  get noiseFloor() { return this.state.noiseFloor; }
  get energyPercentiles() { return this.state.energyPercentiles; }
  
  get pitchConfidence() { return this.state.pitchConfidence; }
  get formantConfidence() { return this.state.formantConfidence; }
  get spectralTiltConfidence() { return this.state.spectralTiltConfidence; }
  get vowelLikelihood() { return this.state.vowelLikelihood; }

  get formantFreqData() { return this.engine.formantFreqData; }
  get frequencyData() { return this.engine.frequencyData; }
  get recTimeDomainData() { return this.engine.recTimeDomainData; }
  get analyserRec() { return this.engine.analyserRec; }

  // Coaching and Presets
  get coachingHint() { return this.state.coachingHint; }
  setPracticePreset(name) {
    this.state.currentPresetName = name;
    this.state.currentPreset = this.state.getPresetConfig(name);
  }
  get currentPreset() { return this.state.currentPreset; }
}
