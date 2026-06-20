// ============================================================
// METRICS HUD — live meters, windowed-average readouts, expanded
// metric panels, and the per-metric detail popups (graphs, orbs,
// spectrogram, vowel plot).
// ============================================================
// Owns all HUD-private state (history buffers, average caches, meter element
// cache, attack-orb animation, popup state). Reads a small set of values off the
// game via `this.game`: the analyzer and the per-metric display modes
// (pitchDisplayMode / weightMode / attackMode). Extracted from VoxBallGame to
// keep the game class focused; pure move, no behavior change.
import { pitchHzToPosition, normalizeAgainstRange } from './dsp-utils.js';
import { H1H2_HEAVY_DB, H1H2_LIGHT_DB } from './voice-analyzer.js';

export class MetricsHud {
  constructor(game) {
    this.game = game;

    this.metricHighlightTimers = { bounce: 0, tempo: 0, vowel: 0, articulation: 0, syllable: 0 };
    this.metricExtremeLatch = { bounce: false, tempo: false, vowel: false, articulation: false, syllable: false };

    // ====== EXPANDED METRICS STATE ======
    this.metersExpanded = false;
    this.metricPopupOpen = null; // null or metric key string
    this._metricHistoryMax = 120; // ~2 seconds at 60fps (default)
    this._metricHistoryMaxLong = 600; // ~10 seconds at 60fps (pitch, bounce)
    this._metricHistory = {
      pitch: [],       // raw Hz values
      resonance: [],   // 0-1 resonance score
      bounce: [],      // 0-1
      vowels: [],      // 0-1
      attack: [],      // 0-1 onset hardness
      weight: [],      // 0-1 perceived heaviness
    };
    this._vowelPlotPoints = []; // {x, y} for F1/F2 scatter
    this._vowelPlotMax = 80;
    // Vocal-attack orb animation: condenses gas→solid on each onset at a speed set by the
    // measured onset hardness, then evaporates. (Weight orb reads m.weight directly.)
    this._attackOrb = { solidity: 0, prevAttack: 0, hardness: 0, lastT: 0 };

    // ====== WINDOWED-AVERAGE READOUTS ======
    // Numeric readouts for pitch/resonance/attack/weight show a rolling time-window average
    // (calmer + more useful for voice training) instead of a jittery per-frame value. The live
    // bars/orbs/graphs stay instantaneous. Buffers are TIME-stamped and fed every frame.
    this._avgWindowSecs = 3.0;        // selectable window length; 0 ⇒ "Live" (instantaneous)
    this._avgWindowMaxSecs = 10;      // retain up to this much history so window switches are instant
    this._avgRefreshSecs = 0.6;       // throttle: only recompute the displayed number this often
    this._avgBuffers = { pitch: [], resonance: [], attack: [], weight: [] };
    this._avgCache = {};              // last computed summary per metric (or null)
    this._avgLastRefresh = 0;         // performance.now()/1000 of last cache recompute
    this._avgLastFrameId = -1;        // frame id of last Live-mode recompute (de-dupes per frame)
  }

  _pitchHzToNoteLabel(hz) {
    if (!hz || !Number.isFinite(hz)) return '—';
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const note = names[(midi + 1200) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${note}${octave}`;
  }

  _triggerMetricHighlight(metric, threshold = 0.75) {
    const val = this.game.analyzer.metrics[metric] || 0;
    const isExtreme = val >= threshold;
    if (isExtreme && !this.metricExtremeLatch[metric]) {
      this.metricHighlightTimers[metric] = 0.35;
    }
    this.metricExtremeLatch[metric] = isExtreme;
  }

  updateMeters() {
    this._triggerMetricHighlight('articulation', 0.72);

    // Cache the DOM lookups — this runs every frame, and getElementById/querySelector
    // ten times per frame is pure waste. The static 3px indicator width is set once here too.
    if (!this._meterEls) {
      this._meterEls = {
        pitch: document.getElementById('meterPitch'),
        valPitch: document.getElementById('valPitch'),
        resonance: document.getElementById('meterResonance'),
        valResonance: document.getElementById('valResonance'),
        highlight: {
          tempo: document.querySelector('.meter-tempo .meter-label'),
          articulation: document.querySelector('.meter-artic .meter-label'),
        },
        mapSplatter: document.getElementById('mapSplatter'),
        pitchStatus: document.getElementById('pitchProfileLearned'),
        tiltStatus: document.getElementById('tiltProfileLearned'),
        confidenceStatus: document.getElementById('frameConfidenceLabel'),
      };
      this._meterEls.pitch.style.width = '3px';
      this._meterEls.resonance.style.width = '3px';
    }
    const els = this._meterEls;

    // Pitch meter — position-based indicator (not fill width). The bar tracks the live pitch;
    // the numeric readout shows a windowed average (formatted per the Pitch display mode).
    // Map 80-300 Hz to 0-100% position on the gradient bar
    const hz = this.game.analyzer.smoothPitchHz;
    const pitchPos = pitchHzToPosition(hz, 80, 300);
    els.pitch.style.left = (pitchPos * 100) + '%';
    els.valPitch.textContent = this._pitchReadout();

    // Resonance meter — position-based indicator like pitch; numeric readout = windowed avg F1/F2
    const res = this.game.analyzer.smoothResonance;
    els.resonance.style.left = (res * 100) + '%';
    els.valResonance.textContent = this._resonanceReadout('hud');

    for (const [k, el] of Object.entries(els.highlight)) {
      this.metricHighlightTimers[k] = Math.max(0, this.metricHighlightTimers[k] - 1 / 60);
      if (el) el.classList.toggle('active-ping', this.metricHighlightTimers[k] > 0);
    }
    if (els.mapSplatter) els.mapSplatter.classList.toggle('active-ping', this.metricHighlightTimers.articulation > 0);

    const pitchStatus = els.pitchStatus;
    const tiltStatus = els.tiltStatus;
    const confidenceStatus = els.confidenceStatus;
    if (pitchStatus || tiltStatus || confidenceStatus) {
      const pitch = this.game.analyzer.pitchProfile;
      const tilt = this.game.analyzer.tiltProfile;
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
      if (confidenceStatus) confidenceStatus.textContent = `${Math.round(this.game.analyzer.frameConfidence * 100)}%`;
    }
  }

  _meterLabel(val, low, mid, high) {
    const pct = Math.round(val * 100);
    if (pct <= 15) return `${pct}% · ${low}`;
    if (pct <= 55) return `${pct}% · ${mid}`;
    return `${pct}% · ${high}`;
  }

  // ============================================================
  // WINDOWED-AVERAGE READOUTS (pitch / resonance / attack / weight)
  // ============================================================

  // Collect one time-stamped sample per metric every frame (voicing/confidence-gated so the
  // averages reflect actual phonation, not silence). Called unconditionally from the render
  // loop — independent of whether the expanded panel is open — so the always-visible HUD
  // readouts have history to average.
  _pushAvgSamples() {
    const a = this.game.analyzer, m = a.metrics;
    const t = performance.now() / 1000;
    const B = this._avgBuffers;

    if (a.lastPitch > 0 && a.smoothPitchHz > 0 && a.pitchConfidence > 0.35 && m.energy > 0.05) {
      B.pitch.push({ t, v: a.smoothPitchHz });
    }
    if (a.formantConfidence > 0.2 && m.energy > 0.05) {
      B.resonance.push({ t, f1: a.smoothF1, f2: a.smoothF2 });
    }
    if (m.attack > 0.02) {
      B.attack.push({ t, v: m.attack, rise: a.attackRiseHardness, abrupt: a.attackAbruptness });
    }
    if (a.spectralTiltConfidence > 0.2) {
      B.weight.push({ t, v: m.weight, tilt: 1 - a.spectralWeight, h1h2: a.h1h2SmoothedDb });
    }

    // Evict samples older than the retained max so buffers stay bounded; the active window
    // (which may be shorter, or 0 for "Live") is applied at read time in _recomputeAvgCache().
    const cutoff = t - this._avgWindowMaxSecs;
    for (const k in B) {
      const buf = B[k];
      while (buf.length && buf[0].t < cutoff) buf.shift();
    }
  }

  // Throttled accessor: returns a cached per-metric summary (or null when there aren't enough
  // samples). The whole cache is recomputed at most every _avgRefreshSecs so the displayed
  // numbers read calmly even though samples arrive at 60fps.
  _avgSummary(metric) {
    const t = performance.now() / 1000;
    if (this._avgWindowSecs <= 0) {
      // Live mode tracks every frame, but recompute at most once per frame (HUD + cards +
      // popup all call this), not once per readout.
      const frameId = Math.floor(t * 1000 / 16);
      if (frameId !== this._avgLastFrameId) { this._recomputeAvgCache(t); this._avgLastFrameId = frameId; }
    } else if (t - this._avgLastRefresh >= this._avgRefreshSecs) {
      this._recomputeAvgCache(t);
      this._avgLastRefresh = t;
    }
    return this._avgCache[metric] || null;
  }

  _recomputeAvgCache(now) {
    const B = this._avgBuffers;
    const live = this._avgWindowSecs <= 0;
    // In Live mode use only the most recent sample; otherwise the trailing time window.
    const within = (buf) => {
      if (!buf.length) return [];
      if (live) return buf.slice(-1);
      const cutoff = now - this._avgWindowSecs;
      let i = buf.length;
      while (i > 0 && buf[i - 1].t >= cutoff) i--;
      return buf.slice(i);
    };
    const MIN_N = live ? 1 : 5; // need a few samples for a stable window average

    // Pitch — mean Hz plus min/max and semitone range (range is the most training-useful cue).
    {
      const s = within(B.pitch);
      if (s.length >= MIN_N) {
        let sum = 0, min = Infinity, max = -Infinity;
        for (const p of s) { sum += p.v; if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
        const meanHz = sum / s.length;
        const rangeSemitones = (min > 0 && max > 0) ? 12 * Math.log2(max / min) : 0;
        this._avgCache.pitch = { n: s.length, meanHz, minHz: min, maxHz: max, rangeSemitones };
      } else this._avgCache.pitch = null;
    }

    // Resonance — mean F1/F2 and a bright/neutral/dark descriptor (from F2, matching the
    // resonance-score logic in the analyzer).
    {
      const s = within(B.resonance);
      if (s.length >= MIN_N) {
        let f1 = 0, f2 = 0;
        for (const p of s) { f1 += p.f1; f2 += p.f2; }
        const meanF1 = f1 / s.length, meanF2 = f2 / s.length;
        const descriptor = meanF2 >= 1900 ? 'Bright' : meanF2 >= 1500 ? 'Neutral' : 'Dark';
        this._avgCache.resonance = { n: s.length, meanF1, meanF2, descriptor };
      } else this._avgCache.resonance = null;
    }

    // Attack — mean blended hardness plus the two sub-cues (rise-rate vs abruptness).
    {
      const s = within(B.attack);
      if (s.length >= MIN_N) {
        let v = 0, rise = 0, abrupt = 0;
        for (const p of s) { v += p.v; rise += (p.rise || 0); abrupt += (p.abrupt || 0); }
        const mean = v / s.length;
        const descriptor = mean <= 0.15 ? 'Soft' : mean <= 0.55 ? 'Medium' : 'Hard';
        this._avgCache.attack = { n: s.length, mean, meanRise: rise / s.length, meanAbrupt: abrupt / s.length, descriptor };
      } else this._avgCache.attack = null;
    }

    // Weight — mean blended heaviness plus per-cue means (spectral tilt, H1–H2 in dB).
    {
      const s = within(B.weight);
      if (s.length >= MIN_N) {
        let v = 0, tilt = 0, h1h2 = 0;
        for (const p of s) { v += p.v; tilt += p.tilt; h1h2 += p.h1h2; }
        const mean = v / s.length;
        const descriptor = mean <= 0.35 ? 'Light' : mean <= 0.6 ? 'Balanced' : 'Heavy';
        this._avgCache.weight = { n: s.length, mean, meanTilt: tilt / s.length, meanH1H2: h1h2 / s.length, descriptor };
      } else this._avgCache.weight = null;
    }
  }

  // ---- Readout formatters (shared by HUD meters, expanded cards, and focus popup) ----

  _pitchReadout(rich = false) {
    const s = this._avgSummary('pitch');
    if (!s) return (rich || this.game.pitchDisplayMode === 'hz') ? '— Hz' : '—';
    const note = this._pitchHzToNoteLabel(s.meanHz);
    if (rich) return `${Math.round(s.meanHz)} Hz · ${note} · ±${(s.rangeSemitones / 2).toFixed(1)}st`;
    switch (this.game.pitchDisplayMode) {
      case 'note': return note;
      case 'range': return `${s.rangeSemitones.toFixed(1)} st`;
      default: return `${Math.round(s.meanHz)} Hz`;
    }
  }

  _resonanceReadout(format) {
    const s = this._avgSummary('resonance');
    if (!s) return '—';
    const f1 = Math.round(s.meanF1), f2 = Math.round(s.meanF2);
    if (format === 'popup') return `F1: ${f1} Hz  F2: ${f2} Hz`;
    if (format === 'card') return `${s.descriptor} · F2 ${f2}`;
    return `${f1}/${f2}`; // compact HUD
  }

  _attackReadout() {
    const s = this._avgSummary('attack');
    if (!s) return '—';
    const v = this.game.attackMode === 'rise' ? s.meanRise
            : this.game.attackMode === 'abrupt' ? s.meanAbrupt
            : s.mean;
    const d = v <= 0.15 ? 'Soft' : v <= 0.55 ? 'Medium' : 'Hard';
    return `${Math.round(v * 100)}% · ${d}`;
  }

  _weightReadout() {
    const s = this._avgSummary('weight');
    if (!s) return '—';
    let v;
    if (this.game.weightMode === 'tilt') v = s.meanTilt;
    else if (this.game.weightMode === 'h1h2') v = 1 - normalizeAgainstRange(s.meanH1H2, H1H2_HEAVY_DB, H1H2_LIGHT_DB);
    else v = s.mean;
    v = Math.max(0, Math.min(1, v));
    const d = v <= 0.35 ? 'Light' : v <= 0.6 ? 'Balanced' : 'Heavy';
    return `${Math.round(v * 100)}% · ${d}`;
  }

  // ============================================================
  // EXPANDED METRICS — History tracking & rendering
  // ============================================================

  _pushMetricHistory() {
    const m = this.game.analyzer.metrics;
    const h = this._metricHistory;
    const max = this._metricHistoryMax;

    h.pitch.push(this.game.analyzer.smoothPitchHz);
    h.resonance.push(this.game.analyzer.smoothResonance);
    h.bounce.push(m.bounce);
    h.vowels.push(m.vowel);
    h.attack.push(m.attack);
    h.weight.push(m.weight);

    for (const k of Object.keys(h)) {
      const limit = (k === 'pitch' || k === 'bounce') ? this._metricHistoryMaxLong : max;
      if (h[k].length > limit) h[k].shift();
    }

    // Vowel scatter plot: collect F1/F2 points during voiced speech
    if (m.energy > 0.05 && this.game.analyzer.formantConfidence > 0.25 && this.game.analyzer.lastPitch > 0) {
      const f1 = this.game.analyzer.smoothF1;
      const f2 = this.game.analyzer.smoothF2;
      this._vowelPlotPoints.push({ x: f2, y: f1 });
      if (this._vowelPlotPoints.length > this._vowelPlotMax) this._vowelPlotPoints.shift();
    }
  }

  _sizeExpandedCanvases() {
    const ids = ['expCanvasPitch', 'expCanvasResonance', 'expCanvasBounce',
                 'expCanvasVowels', 'expCanvasAttack', 'expCanvasWeight'];
    for (const id of ids) {
      const c = document.getElementById(id);
      if (c) {
        const r = c.getBoundingClientRect();
        c.width = Math.round(r.width * devicePixelRatio);
        c.height = Math.round(r.height * devicePixelRatio);
      }
    }
  }

  _sizePopupCanvas() {
    const c = document.getElementById('metricPopupCanvas');
    if (c) {
      const r = c.getBoundingClientRect();
      c.width = Math.round(r.width * devicePixelRatio);
      c.height = Math.round(r.height * devicePixelRatio);
    }
  }

  _updateExpandedMetrics() {
    if (!this.metersExpanded && !this.metricPopupOpen) return;
    this._pushMetricHistory();
    this._updateAttackOrb(this.game.analyzer.metrics.attack);

    const m = this.game.analyzer.metrics;

    if (this.metersExpanded) {
      // Update expanded card values — windowed averages (visuals below stay live)
      const pEl = document.getElementById('expValPitch');
      if (pEl) pEl.textContent = this._pitchReadout(true);
      const rEl = document.getElementById('expValResonance');
      if (rEl) rEl.textContent = this._resonanceReadout('card');
      const atkEl = document.getElementById('expValAttack');
      if (atkEl) atkEl.textContent = this._attackReadout();
      const wtEl = document.getElementById('expValWeight');
      if (wtEl) wtEl.textContent = this._weightReadout();

      // Render each card canvas
      this._drawLineGraph('expCanvasPitch', this._metricHistory.pitch, '#c084fc', 60, 400, true);
      this._drawSpectrogram('expCanvasResonance');
      this._drawLineGraph('expCanvasBounce', this._metricHistory.bounce, '#ff6b6b', 0, 1, false);
      this._drawVowelPlot('expCanvasVowels');
      this._drawOrb('expCanvasAttack', this._attackOrb.solidity, '#2ec4b6');
      this._drawOrb('expCanvasWeight', m.weight, '#e06c9f');
    }

    // Render popup if open
    if (this.metricPopupOpen) {
      this._renderPopupCanvas(this.metricPopupOpen);
      this._updatePopupValue(this.metricPopupOpen);
    }
  }

  // ---- Drawing helpers for expanded cards ----

  _drawLineGraph(canvasId, data, color, minVal, maxVal, isHz) {
    const c = document.getElementById(canvasId);
    if (!c || !data.length) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Data line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const range = maxVal - minVal || 1;
    const xMax = Math.max(data.length, 2) - 1;
    for (let i = 0; i < data.length; i++) {
      const x = (i / xMax) * w;
      const val = Math.max(minVal, Math.min(maxVal, data[i]));
      const y = h - ((val - minVal) / range) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Glow effect
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 6 * devicePixelRatio;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Current value label
    if (data.length > 0) {
      const last = data[data.length - 1];
      const lastY = h - ((Math.max(minVal, Math.min(maxVal, last)) - minVal) / range) * (h - 4) - 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(w - 2, lastY, 3 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Advance the vocal-attack orb's gas→solid animation. A rising edge of the (decaying) attack
  // impulse marks a fresh onset; the orb then condenses toward that hardness at a speed
  // proportional to it — a hard attack snaps solid almost instantly, a soft attack blooms
  // slowly — before evaporating back to gas, ready for the next onset. The condensation *speed*
  // (and the solidity it reaches) is the readable signal.
  _updateAttackOrb(attackVal) {
    const st = this._attackOrb;
    const now = performance.now();
    const dt = st.lastT ? Math.min(0.1, (now - st.lastT) / 1000) : 0.016;
    st.lastT = now;
    if (attackVal > st.prevAttack + 0.02) st.hardness = attackVal; // fresh onset captured
    st.prevAttack = attackVal;
    const a = st.hardness;
    if (a > 0.01 && st.solidity < a - 0.005) {
      const rate = Math.min(1, (1.5 + a * 12) * dt); // speed ∝ hardness
      st.solidity += (a - st.solidity) * rate;
    } else {
      st.solidity += (0 - st.solidity) * Math.min(1, 2.2 * dt); // evaporate back to gas
      st.hardness *= 0.96;
    }
  }

  // Draw a single "gas → solid" orb for solidity ∈ [0,1]: a wide faint glow when gassy, a bright
  // dense core with a crisp rim when solid. Used for the Vocal Attack and Weight visualizations
  // (reads the canvas size, so it scales for both the small cards and the larger focus popup).
  _drawOrb(canvasId, solidity, color) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const s = Math.max(0, Math.min(1, solidity || 0));
    const cx = w / 2, cy = h / 2;
    const n = parseInt(color.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const rgba = (a) => `rgba(${r},${g},${b},${a})`;
    const maxR = Math.min(w, h) * 0.42;

    // Halo — wide and faint when gassy, tighter and brighter when solid
    const haloR = maxR * (1.0 + (1 - s) * 0.8);
    const haloA = 0.08 + s * 0.22;
    const halo = ctx.createRadialGradient(cx, cy, maxR * 0.1, cx, cy, haloR);
    halo.addColorStop(0, rgba(haloA));
    halo.addColorStop(0.5, rgba(haloA * 0.4));
    halo.addColorStop(1, rgba(0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

    // Core — emerges from the gas and brightens as it solidifies
    const coreR = maxR * (0.30 + s * 0.55);
    const coreA = 0.12 + s * 0.82;
    const core = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.3, 0, cx, cy, coreR);
    core.addColorStop(0, rgba(Math.min(1, coreA + 0.15)));
    core.addColorStop(0.7, rgba(coreA));
    core.addColorStop(1, rgba(coreA * (0.2 + s * 0.5)));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

    // Rim — only crisp once solid
    if (s > 0.12) {
      ctx.strokeStyle = rgba(0.2 + s * 0.6);
      ctx.lineWidth = (0.5 + s * 1.5) * (window.devicePixelRatio || 1);
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _drawSpectrogram(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;

    // Shift existing content left by 1 column
    const imgData = ctx.getImageData(1, 0, w - 1, h);
    ctx.putImageData(imgData, 0, 0);

    // Draw new column on the right using frequency data
    const fData = this.game.analyzer.frequencyData;
    if (!fData || fData.length === 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(w - 1, 0, 1, h);
      return;
    }

    // Map frequency bins to vertical pixels (low freq at bottom)
    const binsToShow = Math.min(fData.length, 256); // focus on lower frequencies
    for (let y = 0; y < h; y++) {
      const binIdx = Math.floor(((h - y) / h) * binsToShow);
      const dbVal = fData[binIdx] || -100;
      // Map dB (-100 to 0) to intensity
      const intensity = Math.max(0, Math.min(1, (dbVal + 100) / 80));
      // Warm color map: black → blue → orange → gold
      const r = Math.round(intensity * intensity * 255);
      const g = Math.round(Math.pow(intensity, 3) * 200);
      const b = Math.round(intensity * 180);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(w - 1, y, 1, 1);
    }
  }

  _drawVowelPlot(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();

    // Reference vowel positions (approximate F2, F1 in Hz)
    const vowels = [
      { label: 'EE', f2: 2300, f1: 300 },
      { label: 'AH', f2: 1100, f1: 800 },
      { label: 'OO', f2: 800, f1: 350 },
      { label: 'EH', f2: 1800, f1: 550 },
      { label: 'AW', f2: 900, f1: 600 },
    ];

    // F2 range: 600-2600, F1 range: 200-1000
    const mapF2 = f2 => ((f2 - 600) / 2000) * w;
    const mapF1 = f1 => ((f1 - 200) / 800) * h;

    // Reference labels
    ctx.font = `${8 * devicePixelRatio}px "Space Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    for (const v of vowels) {
      const vx = mapF2(v.f2);
      const vy = mapF1(v.f1);
      ctx.fillText(v.label, vx, vy);
    }

    // Scatter points
    const pts = this._vowelPlotPoints;
    for (let i = 0; i < pts.length; i++) {
      const alpha = 0.2 + (i / pts.length) * 0.6;
      const size = 2 + (i / pts.length) * 2;
      ctx.fillStyle = `rgba(107, 203, 119, ${alpha})`;
      ctx.beginPath();
      ctx.arc(mapF2(pts[i].x), mapF1(pts[i].y), size * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Metric Popup ----

  _openMetricPopup(metric) {
    this.metricPopupOpen = metric;
    const backdrop = document.getElementById('metricPopupBackdrop');
    const title = document.getElementById('metricPopupTitle');
    const desc = document.getElementById('metricPopupDesc');

    const descriptions = {
      pitch: 'Displays the current fundamental frequency (F0). The color-coded slider shows your position in the pitch range. The line graph shows pitch stability and range over time.',
      resonance: 'Shows a real-time spectrogram tracking formant frequencies (F1, F2). The "Q" value indicates the sharpness of the resonance filter (Harmonic Envelope).',
      bounce: 'A stylized wave graph measuring prosodic inflection or "melody" in speech. Higher values suggest more dynamic pitch variation rather than monotonic delivery.',
      vowels: 'A vowel space plot (F1 vs F2) showing the brightness or darkness of vowel sounds like "EE" and "AH." Tracks resonance shifts during articulation.',
      attack: 'Vocal attack measures onset hardness — how steeply your voice rises into phonation. High = crisp glottal onsets; low = soft, breathy, gradual starts.',
      weight: 'Vocal weight is perceived heaviness from spectral tilt. High = thick, heavy, buzzy tone; low = light, bright, breathy tone.',
    };

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      vowels: '#6bcb77', attack: '#2ec4b6', weight: '#e06c9f',
    };

    title.textContent = metric.toUpperCase();
    title.style.color = colors[metric] || '#fff';
    desc.textContent = descriptions[metric] || '';

    backdrop.classList.add('show');
    // Allow layout, then size canvas
    requestAnimationFrame(() => this._sizePopupCanvas());
  }

  _closeMetricPopup() {
    this.metricPopupOpen = null;
    const backdrop = document.getElementById('metricPopupBackdrop');
    backdrop.classList.remove('show');
  }

  _updatePopupValue(metric) {
    const el = document.getElementById('metricPopupValue');
    if (!el) return;

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      vowels: '#6bcb77', attack: '#2ec4b6', weight: '#e06c9f',
    };
    el.style.color = colors[metric] || '#fff';

    switch (metric) {
      case 'pitch': el.textContent = this._pitchReadout(true); break;
      case 'resonance': el.textContent = this._resonanceReadout('popup'); break;
      // Bounce/Vowels: percentage readouts removed — the chart below is the readout.
      case 'bounce': el.textContent = ''; break;
      case 'vowels': el.textContent = ''; break;
      case 'attack': el.textContent = this._attackReadout(); break;
      case 'weight': el.textContent = this._weightReadout(); break;
    }
  }

  _renderPopupCanvas(metric) {
    const canvasId = 'metricPopupCanvas';
    switch (metric) {
      case 'pitch':
        this._drawLineGraph(canvasId, this._metricHistory.pitch, '#c084fc', 60, 400, true);
        break;
      case 'resonance':
        this._drawSpectrogram(canvasId);
        break;
      case 'bounce':
        this._drawLineGraph(canvasId, this._metricHistory.bounce, '#ff6b6b', 0, 1, false);
        break;
      case 'vowels':
        this._drawVowelPlot(canvasId);
        break;
      case 'attack':
        this._drawOrb(canvasId, this._attackOrb.solidity, '#2ec4b6');
        break;
      case 'weight':
        this._drawOrb(canvasId, this.game.analyzer.metrics.weight, '#e06c9f');
        break;
    }
  }
}
