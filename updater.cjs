const fs = require('fs');

let code = fs.readFileSync('voice-analyzer-state.js', 'utf8');

// Insert new state variables in constructor
code = code.replace('this.noiseSpectralProfile = null;', 
  'this.noiseSpectralProfile = null;\n' +
  '    \n' +
  '    // Coaching and Presets\n' +
  '    this.currentPresetName = "presentation";\n' +
  '    this.currentPreset = this.getPresetConfig(this.currentPresetName);\n' +
  '    this.coachingDebounceTimer = 0;\n' +
  '    this.lowBounceFrameCount = 0;\n' +
  '    this.lowEnergyFrameCount = 0;\n' +
  '    this.lowArticFrameCount = 0;\n' +
  '    this.coachingHint = null;\n'
);

const presetMethod = `
  getPresetConfig(name) {
    const presets = {
      presentation: { bounce: 0.30, vowel: 0.30, artic: 0.40, bounceThreshold: 0.3, energyThreshold: 0.4, articThreshold: 0.3 },
      storytelling: { bounce: 0.60, vowel: 0.20, artic: 0.20, bounceThreshold: 0.5, energyThreshold: 0.2, articThreshold: 0.2 },
      callcenter: { bounce: 0.20, vowel: 0.20, artic: 0.60, bounceThreshold: 0.15, energyThreshold: 0.3, articThreshold: 0.5 },
      publicspeaking: { bounce: 0.25, vowel: 0.40, artic: 0.35, bounceThreshold: 0.2, energyThreshold: 0.5, articThreshold: 0.3 },
      monotone: { bounce: 0.80, vowel: 0.10, artic: 0.10, bounceThreshold: 0.6, energyThreshold: 0.1, articThreshold: 0.1 }
    };
    return presets[name] || presets.presentation;
  }
`;

code = code.replace('  _percentile(values, p) {', presetMethod + '\n  _percentile(values, p) {');

const coachingLogic = `
    // Coaching Hint Logic
    if (this.metrics.bounce < this.currentPreset.bounceThreshold) {
      this.lowBounceFrameCount += dt;
    } else {
      this.lowBounceFrameCount = Math.max(0, this.lowBounceFrameCount - dt);
    }

    if (this.metrics.energy < this.currentPreset.energyThreshold) {
      this.lowEnergyFrameCount += dt;
    } else {
      this.lowEnergyFrameCount = Math.max(0, this.lowEnergyFrameCount - dt);
    }

    if (this.metrics.articulation < this.currentPreset.articThreshold) {
      this.lowArticFrameCount += dt;
    } else {
      this.lowArticFrameCount = Math.max(0, this.lowArticFrameCount - dt);
    }

    this.coachingHint = null;
    if (this.coachingDebounceTimer <= 0) {
      if (this.lowBounceFrameCount > 2.0) {
        this.coachingHint = 'Try varying your pitch more.';
        this.coachingDebounceTimer = 6.0;
        this.lowBounceFrameCount = 0;
      } else if (this.lowEnergyFrameCount > 2.0) {
        this.coachingHint = 'Speak up, volume is a bit low.';
        this.coachingDebounceTimer = 6.0;
        this.lowEnergyFrameCount = 0;
      } else if (this.lowArticFrameCount > 2.0) {
        this.coachingHint = 'Enunciate consonants clearly.';
        this.coachingDebounceTimer = 6.0;
        this.lowArticFrameCount = 0;
      }
    }
    this.coachingDebounceTimer -= dt;
`;

code = code.replace('this.frameConfidence = reliableFrame ? confidenceGate : 0.15;', 
  'this.frameConfidence = reliableFrame ? confidenceGate : 0.15;\n' + coachingLogic
);

fs.writeFileSync('voice-analyzer-state.js', code);
console.log('Updated voice-analyzer-state.js');
