import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationWizard, VOWEL_SET_PROMPTS, VOWEL_MIN_WINDOWS } from './calibration-wizard.js';

class MockClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

class MockEl {
  constructor() {
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.classList = new MockClassList();
    this.listeners = new Map();
    this.nodeType = 1;
    this.children = [];
  }
  appendChild(child) {
    this.children.push(child);
  }
  getContext() {
    return {
      clearRect: () => {},
      fillRect: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fillStyle: ''
    };
  }
  append(...nodes) {

    if (!this.childNodes) this.childNodes = [];
    for (const n of nodes) {
      if (typeof n === 'string') {
        this.textContent += n;
      } else {
        this.children.push(n);
        this.childNodes.push(n);
        this.textContent += n.textContent || '';
      }
    }
  }
  appendChild(node) {
    this.append(node);
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
  }
  removeEventListener(type, cb) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((fn) => fn !== cb));
  }
  click() {
    for (const cb of this.listeners.get('click') || []) cb();
  }
}

function buildWizard() {
  const els = {
    calibrationOverlay: new MockEl(),
    calStepTitle: new MockEl(),
    calStepDesc: new MockEl(),
    calProgressFill: new MockEl(),
    calNextBtn: new MockEl(),
    calSkipBtn: new MockEl()
  };
  global.Node = class MockNode {};
  global.window = {
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    getComputedStyle: () => ({ getPropertyValue: () => '#000000' })
  };
  global.document = {
    documentElement: new MockEl(),
    getElementById: (id) => els[id] || null,
    createElement: (tag) => {
      const el = new MockEl();
      if (tag === 'canvas') {
        el.getContext = () => null;
      }
      return el;
    },
    createDocumentFragment: () => {
      const frag = new MockEl();
      Object.setPrototypeOf(frag, new Proxy(MockEl.prototype, {
        getPrototypeOf() { return global.Node.prototype; }
      }));
      return frag;
    },
    createTextNode: (text) => {
      const node = new MockEl();
      node.textContent = text;
      Object.setPrototypeOf(node, new Proxy(MockEl.prototype, {
        getPrototypeOf() { return global.Node.prototype; }
      }));
      return node;
    }
  };
  Object.setPrototypeOf(els.calStepDesc, new Proxy(MockEl.prototype, {
        getPrototypeOf() { return global.Node.prototype; }
  }));
  return { wizard: new CalibrationWizard(), els };
}

test('calibration wizard returns skipped outcome on initial skip', async () => {
  const { wizard, els } = buildWizard();
  const analyzer = { update() {}, isCalibrated: false, noiseCalibrationDuration: 0.1, metrics: { vowel: 0, energy: 0 } };

  const runPromise = wizard.run(analyzer);
  els.calSkipBtn.click();
  const result = await runPromise;

  assert.equal(result.outcome, 'skipped');
  assert.equal(result.reason, 'user-skip');
});

test('calibration wizard completes when analyzer passes checks', async () => {
  const { wizard, els } = buildWizard();
  const analyzer = {
    noiseCalibrationDuration: 0.01,
    isCalibrated: false,
    metrics: { vowel: 0.5, energy: 0.2 },
    update() {
      this.isCalibrated = true;
      this.metrics.vowel = 0.5;
      this.metrics.energy = 0.2;
    }
  };

  const runPromise = wizard.run(analyzer);
  els.calNextBtn.click(); // start
  await new Promise((r) => setTimeout(r, 120));
  els.calNextBtn.click(); // step 1 next
  await new Promise((r) => setTimeout(r, 120));
  els.calNextBtn.click(); // step 2 next

  const result = await runPromise;
  assert.equal(result.outcome, 'completed');
});

// ===== Phase 4: the guided vowel-set flow =====================================================
//
// docs/RESONANCE_REDESIGN.md §5's Phase 4 entry. What is pinned here is the ORDER and the
// INPUT SHAPE, because both were arrived at by measurement and both are silently breakable:
// the ceiling search must receive one segment PER PRODUCTION (a flat frame list rigs it — see
// VoiceAnalyzer.calibrateLpcCeiling), and the postures must be measured AFTER the ceiling is
// applied, or the span is built from readings the next frame invalidates.

// A stand-in analyzer that records the order of what happened to it. It is deliberately not a
// VoiceAnalyzer: this test is about the wizard's protocol, and the DSP is measured elsewhere
// (tools/lpc-ceiling.mjs, tools/resonance-two-scale.mjs).
function scriptedAnalyzer({ absoluteByPosture = [0.50, 0.62, 0.40], windowSize = 8 } = {}) {
  const events = [];
  let postureIdx = -1;
  let framesInPosture = 0;
  const a = {
    isActive: true,
    metrics: { energy: 0.2, vowel: 0.5 },
    timeDomainData: new Float32Array(windowSize),
    resonancePresent: false,
    resonanceAbsolute: null,
    lpcCeilingHz: null,
    lpcCeilingSource: 'default',
    events,
    update() {
      framesInPosture++;
      // Only report an absolute reading once the ceiling has been chosen. If the wizard ever
      // measured postures first, every posture array would come back empty and the flow would
      // fail rather than quietly building a span on the wrong ceiling.
      if (a.lpcCeilingSource === 'calibrated' && postureIdx >= 0) {
        a.resonancePresent = true;
        a.resonanceAbsolute = absoluteByPosture[Math.min(postureIdx, absoluteByPosture.length - 1)];
      } else {
        a.resonancePresent = false;
        a.resonanceAbsolute = null;
      }
    },
    calibrateLpcCeiling(segments) {
      events.push({ kind: 'ceiling', segments: segments.map((s) => s.length) });
      a.lpcCeilingHz = 5000;
      a.lpcCeilingSource = 'calibrated';
      postureIdx = -1;
      return { selected: true, ceilingHz: 5000, scored: [] };
    },
    beginPosture() { postureIdx++; framesInPosture = 0; },
    applyVowelSetCalibration(args) {
      events.push({ kind: 'apply', args });
      return {
        ok: true,
        profile: { metricVersion: 2, spanId: 'calibrated/0.3900-0.6300', span: { min: 0.39, max: 0.63 } },
        span: { min: 0.39, max: 0.63, spreadFloored: false },
        counts: { habitual: 10, brighter: 10, darker: 10 },
      };
    },
  };
  return a;
}

test('the vowel set reaches calibrateLpcCeiling as SEPARATE segments, one per production', async () => {
  const { wizard, els } = buildWizard();
  const analyzer = scriptedAnalyzer();
  // The wizard advances each posture by driving update(); step the posture index whenever the
  // wizard moves on. It sets the step title, so hook that.
  const origSetStep = wizard._setStep.bind(wizard);
  wizard._setStep = (title, desc, pct) => {
    if (typeof title === 'string' && title.startsWith('Your range')) analyzer.beginPosture();
    return origSetStep(title, desc, pct);
  };

  const run = wizard.runVowelSetCalibration(analyzer);
  els.calNextBtn.click();                       // start
  const result = await run;

  assert.equal(result.outcome, 'completed', `outcome was ${result.outcome}/${result.reason}`);
  const ceilingEvent = analyzer.events.find((e) => e.kind === 'ceiling');
  assert.ok(ceilingEvent, 'calibrateLpcCeiling was never called');
  assert.equal(ceilingEvent.segments.length, VOWEL_SET_PROMPTS.length,
    'the five vowels must arrive as five segments, not one concatenated list');
  for (const n of ceilingEvent.segments) {
    assert.ok(n >= VOWEL_MIN_WINDOWS, `a segment carried only ${n} windows`);
  }
});

test('the postures are measured AFTER the ceiling is applied, and only the two extremes set ends', async () => {
  const { wizard, els } = buildWizard();
  const analyzer = scriptedAnalyzer({ absoluteByPosture: [0.50, 0.62, 0.40] });
  const origSetStep = wizard._setStep.bind(wizard);
  wizard._setStep = (title, desc, pct) => {
    if (typeof title === 'string' && title.startsWith('Your range')) analyzer.beginPosture();
    return origSetStep(title, desc, pct);
  };

  const run = wizard.runVowelSetCalibration(analyzer);
  els.calNextBtn.click();
  await run;

  const order = analyzer.events.map((e) => e.kind);
  assert.deepEqual(order, ['ceiling', 'apply'], 'the ceiling must be chosen before the span is built');
  const applied = analyzer.events.find((e) => e.kind === 'apply').args;
  assert.equal(applied.ceilingHz, 5000, 'the chosen ceiling must be handed to the profile');
  // Every posture collected readings, which is only possible if they ran after the ceiling was
  // applied — the scripted analyzer reports nothing before that.
  for (const key of ['habitual', 'brighter', 'darker']) {
    assert.ok(applied.postures[key].length > 0, `${key} collected no readings`);
  }
  assert.ok(applied.postures.brighter.every((v) => v === 0.62));
  assert.ok(applied.postures.darker.every((v) => v === 0.40));
});

test('the wizard hands back a versioned profile and never writes storage itself', async () => {
  const { wizard, els } = buildWizard();
  const analyzer = scriptedAnalyzer();
  const origSetStep = wizard._setStep.bind(wizard);
  wizard._setStep = (title, desc, pct) => {
    if (typeof title === 'string' && title.startsWith('Your range')) analyzer.beginPosture();
    return origSetStep(title, desc, pct);
  };
  let handed = null;
  const run = wizard.runVowelSetCalibration(analyzer, { onProfile: (p) => { handed = p; } });
  els.calNextBtn.click();
  const result = await run;

  assert.equal(result.outcome, 'completed');
  assert.ok(handed, 'the profile was never handed to the caller');
  assert.equal(handed.metricVersion, 2, 'the stored profile must carry the metric version');
  // There is no localStorage in this harness at all. If the wizard touched it, this test would
  // have thrown — which is the point: one place knows the storage key.
});

test('a cancelled vowel-set calibration changes nothing', async () => {
  const { wizard, els } = buildWizard();
  const analyzer = scriptedAnalyzer();
  const run = wizard.runVowelSetCalibration(analyzer);
  els.calSkipBtn.click();
  const result = await run;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(analyzer.events.length, 0, 'a cancelled run must not calibrate anything');
});

test('too few usable vowel productions declines instead of calibrating on what it got', async () => {
  const { wizard, els } = buildWizard();
  const analyzer = scriptedAnalyzer();
  // No audio at all: every segment comes back empty, so none clears VOWEL_MIN_WINDOWS.
  analyzer.timeDomainData = new Float32Array(0);
  const run = wizard.runVowelSetCalibration(analyzer);
  els.calNextBtn.click();
  const result = await run;
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.reason, 'insufficient-vowels');
  assert.equal(analyzer.events.length, 0, 'the ceiling search must not run on too little audio');
});
