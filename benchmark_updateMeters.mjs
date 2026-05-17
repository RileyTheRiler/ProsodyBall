import { performance } from 'perf_hooks';

// Setup mock DOM elements and context to mimic app.js structure enough to benchmark DOM querying vs caching
const mockElements = {
    'meterBounce': { style: {} },
    'meterTempo': { style: {} },
    'meterVowel': { style: {} },
    'meterArtic': { style: {} },
    'meterPitch': { style: {} },
    'valPitch': {},
    'meterResonance': { style: {} },
    'valResonance': {},
    'valBounce': {},
    'valTempo': {},
    'valVowel': {},
    'valArtic': {},
    'pitchProfileLearned': {},
    'tiltProfileLearned': {},
    'frameConfidenceLabel': {},
    'mapSplatter': { classList: { toggle: () => {} } }
};

global.document = {
    getElementById: (id) => mockElements[id] || { style: {}, classList: { toggle: () => {} } },
    querySelector: (sel) => ({ classList: { toggle: () => {} } })
};

class VoiceAnalyzerMock {
    constructor() {
        this.metrics = { bounce: 0.5, tempo: 0.5, vowel: 0.5, articulation: 0.5, energy: 0.1 };
        this.smoothPitchHz = 150;
        this.lastPitch = 150;
        this.smoothResonance = 0.5;
        this.formantConfidence = 0.5;
        this.smoothF1 = 500;
        this.smoothF2 = 1500;
        this.smoothF3 = 2500;
        this.pitchProfile = { voicedTime: 1, learningDuration: 5, isLearned: true, min: 100, max: 200 };
        this.tiltProfile = { voicedTime: 1, learningDuration: 5, isLearned: true, min: -20, max: -5 };
        this.frameConfidence = 0.8;
    }
}

function pitchHzToPosition(hz, min, max) { return 0.5; }

class GameMock {
    constructor() {
        this.analyzer = new VoiceAnalyzerMock();
        this.metricHighlightTimers = { bounce: 0, tempo: 0, vowel: 0, articulation: 0 };
        this.metricExtremeLatch = { bounce: false, tempo: false, vowel: false, articulation: false };
    }

    _triggerMetricHighlight(metric, threshold) {}
    _meterLabel(val, low, mid, high) { return "mid"; }

    updateMetersUnoptimized() {
        const m = this.analyzer.metrics;
        this._triggerMetricHighlight('articulation', 0.72);
        this._triggerMetricHighlight('vowel', 0.7);
        this._triggerMetricHighlight('bounce', 0.75);

        const set = (id, val) => {
          document.getElementById(id).style.width = (val * 100) + '%';
        };
        set('meterBounce', m.bounce);
        set('meterTempo', m.tempo);
        set('meterVowel', m.vowel);
        set('meterArtic', m.articulation);

        const hz = this.analyzer.smoothPitchHz;
        const pitchPos = pitchHzToPosition(hz, 80, 300);
        const pitchEl = document.getElementById('meterPitch');
        pitchEl.style.left = (pitchPos * 100) + '%';
        pitchEl.style.width = '3px';
        document.getElementById('valPitch').textContent =
          this.analyzer.lastPitch > 0 ? Math.round(hz) + ' Hz' : '— Hz';

        const res = this.analyzer.smoothResonance;
        const resEl = document.getElementById('meterResonance');
        resEl.style.left = (res * 100) + '%';
        resEl.style.width = '3px';

        const resConf = this.analyzer.formantConfidence;
        if (resConf > 0.2 && this.analyzer.metrics.energy > 0.05) {
          const f1 = Math.round(this.analyzer.smoothF1);
          const f2 = Math.round(this.analyzer.smoothF2);
          const f3 = Math.round(this.analyzer.smoothF3);
          document.getElementById('valResonance').textContent = `${f1}/${f2}/${f3}`;
        } else {
          document.getElementById('valResonance').textContent = '—';
        }

        document.getElementById('valBounce').textContent = this._meterLabel(m.bounce, 'Flat', 'Varied', 'Wild');
        document.getElementById('valTempo').textContent = this._meterLabel(m.tempo, 'Steady', 'Varied', 'Dynamic');
        document.getElementById('valVowel').textContent = this._meterLabel(m.vowel, 'Short', 'Held', 'Sustained');
        document.getElementById('valArtic').textContent = this._meterLabel(m.articulation, 'Soft', 'Clear', 'Crisp');
        const highlightMap = {
          bounce: document.querySelector('.meter-bounce .meter-label'),
          tempo: document.querySelector('.meter-tempo .meter-label'),
          vowel: document.querySelector('.meter-vowel .meter-label'),
          articulation: document.querySelector('.meter-artic .meter-label'),
        };
        for (const [k, el] of Object.entries(highlightMap)) {
          this.metricHighlightTimers[k] = Math.max(0, this.metricHighlightTimers[k] - 1 / 60);
          if (el) el.classList.toggle('active-ping', this.metricHighlightTimers[k] > 0);
        }
        const mapSplatter = document.getElementById('mapSplatter');
        if (mapSplatter) mapSplatter.classList.toggle('active-ping', this.metricHighlightTimers.articulation > 0);

        const pitchStatus = document.getElementById('pitchProfileLearned');
        const tiltStatus = document.getElementById('tiltProfileLearned');
        const confidenceStatus = document.getElementById('frameConfidenceLabel');
        if (pitchStatus || tiltStatus || confidenceStatus) {
          const pitch = this.analyzer.pitchProfile;
          const tilt = this.analyzer.tiltProfile;
          if (pitchStatus) {
            const pct = Math.min(100, Math.round((pitch.voicedTime / Math.max(0.1, pitch.learningDuration)) * 100));
            pitchStatus.textContent = pitch.isLearned
              ? `${Math.round(pitch.min)}–${Math.round(pitch.max)} Hz learned`
              : `Learning… ${pct}%`;
          }
          if (tiltStatus) {
            const pct = Math.min(100, Math.round((tilt.voicedTime / Math.max(0.1, tilt.learningDuration)) * 100));
            tiltStatus.textContent = tilt.isLearned
              ? `${tilt.min.toFixed(1)} to ${tilt.max.toFixed(1)} dB learned`
              : `Learning… ${pct}%`;
          }
          if (confidenceStatus) confidenceStatus.textContent = `${Math.round(this.analyzer.frameConfidence * 100)}%`;
        }
    }

    setupOptimized() {
        this.domCache = {
            meterBounce: document.getElementById('meterBounce'),
            meterTempo: document.getElementById('meterTempo'),
            meterVowel: document.getElementById('meterVowel'),
            meterArtic: document.getElementById('meterArtic'),
            meterPitch: document.getElementById('meterPitch'),
            valPitch: document.getElementById('valPitch'),
            meterResonance: document.getElementById('meterResonance'),
            valResonance: document.getElementById('valResonance'),
            valBounce: document.getElementById('valBounce'),
            valTempo: document.getElementById('valTempo'),
            valVowel: document.getElementById('valVowel'),
            valArtic: document.getElementById('valArtic'),
            highlightBounce: document.querySelector('.meter-bounce .meter-label'),
            highlightTempo: document.querySelector('.meter-tempo .meter-label'),
            highlightVowel: document.querySelector('.meter-vowel .meter-label'),
            highlightArtic: document.querySelector('.meter-artic .meter-label'),
            mapSplatter: document.getElementById('mapSplatter'),
            pitchProfileLearned: document.getElementById('pitchProfileLearned'),
            tiltProfileLearned: document.getElementById('tiltProfileLearned'),
            frameConfidenceLabel: document.getElementById('frameConfidenceLabel'),
        };
    }

    updateMetersOptimized() {
        const m = this.analyzer.metrics;
        const c = this.domCache;
        if (!c.meterBounce) return; // Prevent crashes if not setup yet

        this._triggerMetricHighlight('articulation', 0.72);
        this._triggerMetricHighlight('vowel', 0.7);
        this._triggerMetricHighlight('bounce', 0.75);

        c.meterBounce.style.width = (m.bounce * 100) + '%';
        c.meterTempo.style.width = (m.tempo * 100) + '%';
        c.meterVowel.style.width = (m.vowel * 100) + '%';
        c.meterArtic.style.width = (m.articulation * 100) + '%';

        const hz = this.analyzer.smoothPitchHz;
        const pitchPos = pitchHzToPosition(hz, 80, 300);
        c.meterPitch.style.left = (pitchPos * 100) + '%';
        c.meterPitch.style.width = '3px';
        c.valPitch.textContent =
          this.analyzer.lastPitch > 0 ? Math.round(hz) + ' Hz' : '— Hz';

        const res = this.analyzer.smoothResonance;
        c.meterResonance.style.left = (res * 100) + '%';
        c.meterResonance.style.width = '3px';

        const resConf = this.analyzer.formantConfidence;
        if (resConf > 0.2 && m.energy > 0.05) {
          const f1 = Math.round(this.analyzer.smoothF1);
          const f2 = Math.round(this.analyzer.smoothF2);
          const f3 = Math.round(this.analyzer.smoothF3);
          c.valResonance.textContent = `${f1}/${f2}/${f3}`;
        } else {
          c.valResonance.textContent = '—';
        }

        c.valBounce.textContent = this._meterLabel(m.bounce, 'Flat', 'Varied', 'Wild');
        c.valTempo.textContent = this._meterLabel(m.tempo, 'Steady', 'Varied', 'Dynamic');
        c.valVowel.textContent = this._meterLabel(m.vowel, 'Short', 'Held', 'Sustained');
        c.valArtic.textContent = this._meterLabel(m.articulation, 'Soft', 'Clear', 'Crisp');

        this.metricHighlightTimers.bounce = Math.max(0, this.metricHighlightTimers.bounce - 1 / 60);
        if (c.highlightBounce) c.highlightBounce.classList.toggle('active-ping', this.metricHighlightTimers.bounce > 0);

        this.metricHighlightTimers.tempo = Math.max(0, this.metricHighlightTimers.tempo - 1 / 60);
        if (c.highlightTempo) c.highlightTempo.classList.toggle('active-ping', this.metricHighlightTimers.tempo > 0);

        this.metricHighlightTimers.vowel = Math.max(0, this.metricHighlightTimers.vowel - 1 / 60);
        if (c.highlightVowel) c.highlightVowel.classList.toggle('active-ping', this.metricHighlightTimers.vowel > 0);

        this.metricHighlightTimers.articulation = Math.max(0, this.metricHighlightTimers.articulation - 1 / 60);
        if (c.highlightArtic) c.highlightArtic.classList.toggle('active-ping', this.metricHighlightTimers.articulation > 0);

        if (c.mapSplatter) c.mapSplatter.classList.toggle('active-ping', this.metricHighlightTimers.articulation > 0);

        if (c.pitchProfileLearned || c.tiltProfileLearned || c.frameConfidenceLabel) {
          const pitch = this.analyzer.pitchProfile;
          const tilt = this.analyzer.tiltProfile;
          if (c.pitchProfileLearned) {
            const pct = Math.min(100, Math.round((pitch.voicedTime / Math.max(0.1, pitch.learningDuration)) * 100));
            c.pitchProfileLearned.textContent = pitch.isLearned
              ? `${Math.round(pitch.min)}–${Math.round(pitch.max)} Hz learned`
              : `Learning… ${pct}%`;
          }
          if (c.tiltProfileLearned) {
            const pct = Math.min(100, Math.round((tilt.voicedTime / Math.max(0.1, tilt.learningDuration)) * 100));
            c.tiltProfileLearned.textContent = tilt.isLearned
              ? `${tilt.min.toFixed(1)} to ${tilt.max.toFixed(1)} dB learned`
              : `Learning… ${pct}%`;
          }
          if (c.frameConfidenceLabel) c.frameConfidenceLabel.textContent = `${Math.round(this.analyzer.frameConfidence * 100)}%`;
        }
    }
}

const game = new GameMock();
const iters = 100000;

let start1 = performance.now();
for (let i = 0; i < iters; i++) {
    game.updateMetersUnoptimized();
}
let end1 = performance.now();
let time1 = end1 - start1;

game.setupOptimized();

let start2 = performance.now();
for (let i = 0; i < iters; i++) {
    game.updateMetersOptimized();
}
let end2 = performance.now();
let time2 = end2 - start2;

console.log(`Unoptimized: ${time1.toFixed(2)}ms`);
console.log(`Optimized: ${time2.toFixed(2)}ms`);
console.log(`Improvement: ${((time1 - time2) / time1 * 100).toFixed(2)}%`);
