import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DafEngine,
  clampDelaySeconds,
  DAF_MAX_DELAY_SEC,
  DAF_OUTPUT_GAIN,
  DAF_FILTER_ON_HZ,
  DAF_FILTER_OFF_HZ,
} from './daf-engine.js';

// ── Minimal Web Audio mock ────────────────────────────────────────────────
// Records the graph topology and every AudioParam automation call so the tests
// can assert both "what got built" and "how parameters changed" (step vs ramp).

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.automations = [];
  }
  setTargetAtTime(target, startTime, timeConstant) {
    this.automations.push({ type: 'setTargetAtTime', target, startTime, timeConstant });
  }
  cancelScheduledValues(t) {
    this.automations.push({ type: 'cancelScheduledValues', startTime: t });
  }
}

class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.outputs = [];
    this.disconnectCount = 0;
  }
  connect(dest) { this.outputs.push(dest); return dest; }
  disconnect() { this.disconnectCount++; this.outputs = []; }
}

class FakeCtx {
  constructor() {
    this.state = 'running';
    this.currentTime = 12.5;
    this.destination = new FakeNode('destination');
    this.created = [];
    this.maxDelayTimes = [];
  }
  _track(n) { this.created.push(n); return n; }
  createGain() {
    const n = new FakeNode('gain');
    n.gain = new FakeParam(1);
    return this._track(n);
  }
  createDelay(maxDelay) {
    this.maxDelayTimes.push(maxDelay);
    const n = new FakeNode('delay');
    n.delayTime = new FakeParam(0);
    return this._track(n);
  }
  createBiquadFilter() {
    const n = new FakeNode('biquad');
    n.type = 'lowpass';
    n.frequency = new FakeParam(350);
    return this._track(n);
  }
  createDynamicsCompressor() {
    const n = new FakeNode('compressor');
    n.threshold = new FakeParam(-24);
    n.knee = new FakeParam(30);
    n.ratio = new FakeParam(12);
    n.attack = new FakeParam(0.003);
    n.release = new FakeParam(0.25);
    return this._track(n);
  }
}

const kindsOf = (ctx) => ctx.created.map((n) => n.kind);

// ── clampDelaySeconds ─────────────────────────────────────────────────────

test('clampDelaySeconds converts ms to seconds and bounds the range', () => {
  assert.equal(clampDelaySeconds(75), 0.075);
  assert.equal(clampDelaySeconds(200), 0.2);
  assert.equal(clampDelaySeconds(0), 0);
  assert.equal(clampDelaySeconds(-50), 0, 'negative delay is meaningless');
  assert.equal(clampDelaySeconds(99999), DAF_MAX_DELAY_SEC, 'never exceeds DelayNode capacity');
  assert.equal(clampDelaySeconds(undefined), 0);
  assert.equal(clampDelaySeconds('120'), 0.12);
});

// ── Graph construction ────────────────────────────────────────────────────

test('start() builds source → input → delay → filter → limiter → gain → destination', () => {
  const ctx = new FakeCtx();
  const source = new FakeNode('source');
  const daf = new DafEngine({ delayMs: 75, bassFilter: false });

  assert.equal(daf.active, false);
  assert.equal(daf.start(ctx, source), true);
  assert.equal(daf.active, true);

  assert.deepEqual(kindsOf(ctx), ['gain', 'delay', 'biquad', 'compressor', 'gain']);
  assert.deepEqual(source.outputs, [daf.input], 'taps the live mic source');
  assert.deepEqual(daf.input.outputs, [daf.delay]);
  assert.deepEqual(daf.delay.outputs, [daf.filter]);
  assert.deepEqual(daf.filter.outputs, [daf.limiter]);
  assert.deepEqual(daf.limiter.outputs, [daf.gain]);
  assert.deepEqual(daf.gain.outputs, [ctx.destination]);
});

test('the delay is a native DelayNode, not a polled buffer loop', () => {
  // The crackling bug was a setInterval + AudioBufferSourceNode scheduler whose
  // chunk seams were waveform discontinuities. Delay must live on a DelayNode.
  const ctx = new FakeCtx();
  const daf = new DafEngine({ delayMs: 120 });
  daf.start(ctx, new FakeNode('source'));

  assert.equal(ctx.created.filter((n) => n.kind === 'delay').length, 1);
  assert.equal(daf.delay.delayTime.value, 0.12, 'delay set on the node, not in JS');
  assert.deepEqual(ctx.maxDelayTimes, [DAF_MAX_DELAY_SEC]);
  assert.ok(
    DAF_MAX_DELAY_SEC >= 0.2,
    'DelayNode capacity must cover the 200ms slider maximum',
  );
});

test('start() is idempotent and refuses to build without a context or source', () => {
  const ctx = new FakeCtx();
  const source = new FakeNode('source');
  const daf = new DafEngine();

  assert.equal(daf.start(null, source), false);
  assert.equal(daf.start(ctx, null), false);
  assert.equal(daf.active, false);
  assert.equal(ctx.created.length, 0);

  assert.equal(daf.start(ctx, source), true);
  const builtCount = ctx.created.length;
  assert.equal(daf.start(ctx, source), false, 'second start is a no-op');
  assert.equal(ctx.created.length, builtCount, 'no duplicate graph');
});

// ── Click-free transitions ────────────────────────────────────────────────

test('output gain fades in rather than snapping to full level', () => {
  const ctx = new FakeCtx();
  const daf = new DafEngine();
  daf.start(ctx, new FakeNode('source'));

  assert.equal(daf.gain.gain.value, 0, 'starts silent');
  const [fade] = daf.gain.gain.automations;
  assert.equal(fade.type, 'setTargetAtTime');
  assert.equal(fade.target, DAF_OUTPUT_GAIN);
  assert.ok(fade.timeConstant > 0, 'ramped, not stepped');
});

test('setDelayMs glides delayTime instead of stepping it', () => {
  const ctx = new FakeCtx();
  const daf = new DafEngine({ delayMs: 75 });
  daf.start(ctx, new FakeNode('source'));

  daf.setDelayMs(160);
  assert.equal(daf.delayMs, 160);
  const [glide] = daf.delay.delayTime.automations;
  assert.equal(glide.type, 'setTargetAtTime');
  assert.equal(glide.target, 0.16);
  assert.ok(glide.timeConstant > 0);
  assert.equal(daf.delay.delayTime.value, 0.075, 'no abrupt value assignment');
});

test('setBassFilter glides the corner and never tears down the graph', () => {
  const ctx = new FakeCtx();
  const daf = new DafEngine({ bassFilter: false });
  daf.start(ctx, new FakeNode('source'));
  const builtCount = ctx.created.length;
  const filter = daf.filter;

  assert.equal(filter.type, 'highpass');
  assert.equal(filter.frequency.value, DAF_FILTER_OFF_HZ,
    'off position still blocks DC/rumble that would eat playback headroom');

  daf.setBassFilter(true);
  assert.equal(filter.frequency.automations.at(-1).target, DAF_FILTER_ON_HZ);
  daf.setBassFilter(false);
  assert.equal(filter.frequency.automations.at(-1).target, DAF_FILTER_OFF_HZ);

  assert.equal(ctx.created.length, builtCount, 'no nodes rebuilt');
  assert.equal(filter.disconnectCount, 0, 'audio never dropped mid-utterance');
  assert.equal(daf.active, true);
});

test('a soft limiter guards against clipping on a hot mic', () => {
  const ctx = new FakeCtx();
  const daf = new DafEngine();
  daf.start(ctx, new FakeNode('source'));

  assert.ok(daf.limiter, 'limiter present');
  assert.ok(daf.limiter.threshold.value < 0, 'engages below full scale');
  assert.ok(daf.limiter.ratio.value >= 10, 'limiting, not gentle compression');
  assert.ok(daf.limiter.attack.value <= 0.005, 'fast enough to catch transients');
});

// ── Teardown ──────────────────────────────────────────────────────────────

test('stop() fades out, then disconnects every node', async () => {
  const ctx = new FakeCtx();
  const source = new FakeNode('source');
  const daf = new DafEngine();
  daf.start(ctx, source);
  const nodes = [daf.input, daf.delay, daf.filter, daf.limiter, daf.gain];
  const gain = daf.gain;

  daf.stop();
  assert.equal(daf.active, false, 'reported inactive immediately');
  assert.equal(gain.gain.automations.at(-1).target, 0, 'faded to silence');
  assert.equal(nodes.some((n) => n.disconnectCount > 0), false, 'not yet torn down');

  await new Promise((r) => setTimeout(r, 80));
  for (const n of nodes) {
    assert.equal(n.disconnectCount, 1, `${n.kind} disconnected exactly once`);
  }
});

test('stop() on a closed context tears down immediately without throwing', () => {
  const ctx = new FakeCtx();
  const daf = new DafEngine();
  daf.start(ctx, new FakeNode('source'));
  const nodes = [daf.input, daf.delay, daf.filter, daf.limiter, daf.gain];

  ctx.state = 'closed';
  daf.stop();

  assert.equal(daf.active, false);
  for (const n of nodes) assert.equal(n.disconnectCount, 1);
});

test('stop() is safe when never started, and restart rebuilds cleanly', () => {
  const daf = new DafEngine();
  assert.doesNotThrow(() => daf.stop());

  const ctx = new FakeCtx();
  const source = new FakeNode('source');
  daf.start(ctx, source);
  ctx.state = 'closed';
  daf.stop();
  assert.doesNotThrow(() => daf.stop(), 'double stop is a no-op');

  const ctx2 = new FakeCtx();
  assert.equal(daf.start(ctx2, new FakeNode('source')), true);
  assert.equal(daf.active, true);
});

test('settings survive a stop/start cycle', () => {
  const daf = new DafEngine({ delayMs: 75, bassFilter: false });
  const ctx = new FakeCtx();
  daf.start(ctx, new FakeNode('source'));
  daf.setDelayMs(185);
  daf.setBassFilter(true);
  ctx.state = 'closed';
  daf.stop();

  const ctx2 = new FakeCtx();
  daf.start(ctx2, new FakeNode('source'));
  assert.equal(daf.delay.delayTime.value, 0.185);
  assert.equal(daf.filter.frequency.value, DAF_FILTER_ON_HZ);
});

test('setters applied while stopped are stored and take effect on next start', () => {
  const daf = new DafEngine();
  assert.doesNotThrow(() => daf.setDelayMs(140));
  assert.doesNotThrow(() => daf.setBassFilter(true));

  const ctx = new FakeCtx();
  daf.start(ctx, new FakeNode('source'));
  assert.equal(daf.delay.delayTime.value, 0.14);
  assert.equal(daf.filter.frequency.value, DAF_FILTER_ON_HZ);
});
