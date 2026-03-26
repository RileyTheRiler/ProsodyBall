import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationWizard } from './calibration-wizard.js';

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
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
    }
    this.childNodes = [];
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
  global.document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => new MockEl(),
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
