import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DafEngine,
  clampDelaySeconds,
  outputLatencyMs,
  describeEffectiveDelay,
  supportsOutputSelection,
  browserSupportsOutputSelection,
  diagnoseSilentOutput,
  DAF_MAX_DELAY_SEC,
  DAF_OUTPUT_GAIN,
  DAF_FILTER_ON_HZ,
  DAF_FILTER_OFF_HZ,
  DAF_EFFECTIVE_MAX_MS,
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
  createOscillator() {
    const n = new FakeNode('oscillator');
    n.type = 'sine';
    n.frequency = new FakeParam(440);
    n.started = null;
    n.stopped = null;
    n.start = (t) => { n.started = t; };
    n.stop = (t) => { n.stopped = t; };
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

// ── Effective delay accounting ────────────────────────────────────────────

test('outputLatencyMs reads the sink latency and converts to ms', () => {
  assert.equal(outputLatencyMs({ outputLatency: 0.006 }), 6, 'wired sink');
  assert.equal(outputLatencyMs({ outputLatency: 0.184 }), 184, 'Bluetooth sink');
  assert.equal(outputLatencyMs({ outputLatency: 0 }), 0);
});

test('outputLatencyMs reports null rather than guessing when unavailable', () => {
  assert.equal(outputLatencyMs(null), null);
  assert.equal(outputLatencyMs(undefined), null);
  assert.equal(outputLatencyMs({}), null, 'Safari does not implement outputLatency');
  assert.equal(outputLatencyMs({ outputLatency: NaN }), null);
  assert.equal(outputLatencyMs({ outputLatency: -1 }), null);
});

test('outputLatencyMs never substitutes baseLatency for a missing outputLatency', () => {
  // baseLatency is graph-internal buffering only and is blind to the sink, so
  // falling back to it would report ~10ms for headphones that really add 200.
  assert.equal(outputLatencyMs({ baseLatency: 0.01 }), null);
});

test('a wired sink leaves the slider setting roughly honest', () => {
  const d = describeEffectiveDelay(75, 6);
  assert.equal(d.total, 81);
  assert.equal(d.wireless, false);
  assert.equal(d.status, 'good');
});

test('Bluetooth latency pushes a normal setting out of the useful range', () => {
  const d = describeEffectiveDelay(75, 184);
  assert.equal(d.total, 259);
  assert.equal(d.wireless, true);
  assert.equal(d.status, 'long');
  assert.match(d.text, /259 ms/);
  assert.match(d.text, /16 ms or less/, 'there is still slider headroom at 184ms');
  assert.match(d.text, /already supply the whole delay/,
    'a sink past the minimum is doing the DAF itself — explain why the number is so small');
});

test('a moderately slow sink is reported as fixable by lowering the slider', () => {
  const d = describeEffectiveDelay(200, 120);
  assert.equal(d.status, 'long');
  assert.equal(d.wireless, true);
  assert.match(d.text, /80 ms or less/, 'suggests the headroom that is left');
});

test('a sink under the useful minimum gets plain "drag it down" advice', () => {
  const d = describeEffectiveDelay(200, 30);
  assert.equal(d.status, 'long');
  assert.equal(d.wireless, false);
  assert.match(d.text, /170 ms or less/);
  assert.doesNotMatch(d.text, /already supply/, 'the sink is not dominating here');
});

test('a sink slower than the whole window cannot be rescued by the slider', () => {
  const d = describeEffectiveDelay(0, 260);
  assert.equal(d.status, 'long');
  assert.ok(260 > DAF_EFFECTIVE_MAX_MS);
  assert.match(d.text, /Wired or USB-C/);
});

test('zero delay on a fast sink is flagged as too short, not as fine', () => {
  const d = describeEffectiveDelay(0, 5);
  assert.equal(d.total, 5);
  assert.equal(d.status, 'short');
  assert.match(d.text, /45 ms or more/);
});

test('an unmeasurable sink says so instead of implying the slider is the truth', () => {
  const d = describeEffectiveDelay(75, null);
  assert.equal(d.total, null);
  assert.equal(d.status, 'unknown');
  assert.match(d.text, /won’t report output latency/);
  assert.match(d.text, /Bluetooth/);
});

test('describeEffectiveDelay tolerates junk slider values', () => {
  assert.equal(describeEffectiveDelay(undefined, 10).total, 10);
  assert.equal(describeEffectiveDelay(-40, 10).total, 10, 'negative delay clamps to 0');
  assert.equal(describeEffectiveDelay('75', 10).total, 85);
});

// ── Output routing ────────────────────────────────────────────────────────

test('supportsOutputSelection detects setSinkId', () => {
  assert.equal(supportsOutputSelection({ setSinkId: () => {} }), true);
  assert.equal(supportsOutputSelection({}), false, 'Safari and Firefox lack it');
  assert.equal(supportsOutputSelection(null), false);
  assert.equal(supportsOutputSelection({ setSinkId: 'nope' }), false);
});

test('browserSupportsOutputSelection answers without a live context', () => {
  // The panel can be opened before any session exists; probing a null context
  // there would report a capable browser as incapable.
  const capable = { AudioContext: function () {} };
  capable.AudioContext.prototype.setSinkId = () => {};
  assert.equal(browserSupportsOutputSelection(capable), true);

  const bare = { AudioContext: function () {} };
  assert.equal(browserSupportsOutputSelection(bare), false);

  assert.equal(browserSupportsOutputSelection({}), false, 'no AudioContext at all');
  assert.equal(browserSupportsOutputSelection(undefined), false);
});

test('browserSupportsOutputSelection checks the webkit-prefixed constructor too', () => {
  const legacy = { webkitAudioContext: function () {} };
  legacy.webkitAudioContext.prototype.setSinkId = () => {};
  assert.equal(browserSupportsOutputSelection(legacy), true);
});

test('echo cancellation is called out first — it is the one toggle that may fix it', () => {
  const d = diagnoseSilentOutput({
    echoCancellation: true, canSelectSink: true, outputDeviceCount: 3,
  });
  assert.equal(d.cause, 'echo-cancellation');
  assert.equal(d.canFix, true);
  assert.match(d.text, /call mode/);
});

test('a browser with sink control and devices points at the picker', () => {
  const d = diagnoseSilentOutput({ canSelectSink: true, outputDeviceCount: 2 });
  assert.equal(d.cause, 'sink-selectable');
  assert.equal(d.canFix, true);
});

test('sink control but an empty device list is a reconnect prompt', () => {
  const d = diagnoseSilentOutput({ canSelectSink: true, outputDeviceCount: 0 });
  assert.equal(d.cause, 'no-devices-listed');
  assert.equal(d.canFix, false);
});

test('no sink control explains the A2DP dead end and names the real fix', () => {
  const d = diagnoseSilentOutput({ canSelectSink: false });
  assert.equal(d.cause, 'no-sink-control');
  assert.equal(d.canFix, false);
  assert.match(d.text, /A2DP/);
  assert.match(d.text, /Wired or USB-C/);
});

test('diagnoseSilentOutput defaults to the phone case when told nothing', () => {
  assert.equal(diagnoseSilentOutput().cause, 'no-sink-control');
});

test('setOutputDevice resolves false when the browser has no setSinkId', async () => {
  const ctx = new FakeCtx();
  const daf = new DafEngine();
  daf.start(ctx, new FakeNode('source'));
  assert.equal(await daf.setOutputDevice('abc'), false);
});

test('setOutputDevice forwards the id, and maps empty to system default', async () => {
  const ctx = new FakeCtx();
  const calls = [];
  ctx.setSinkId = async (id) => { calls.push(id); };
  const daf = new DafEngine();
  daf.start(ctx, new FakeNode('source'));

  assert.equal(await daf.setOutputDevice('headphones-1'), true);
  assert.equal(await daf.setOutputDevice(''), true);
  assert.deepEqual(calls, ['headphones-1', '']);
});

test('setOutputDevice reports failure instead of throwing at the caller', async () => {
  const ctx = new FakeCtx();
  ctx.setSinkId = async () => { throw new Error('device vanished'); };
  const daf = new DafEngine();
  daf.start(ctx, new FakeNode('source'));
  assert.equal(await daf.setOutputDevice('gone'), false);
});

test('playTestTone feeds the live chain, not the destination directly', () => {
  const ctx = new FakeCtx();
  const daf = new DafEngine();
  daf.start(ctx, new FakeNode('source'));

  assert.equal(daf.playTestTone(), true);
  const osc = ctx.created.find((n) => n.kind === 'oscillator');
  assert.ok(osc, 'an oscillator was created');

  // Tone → envelope → input, so it traverses delay/filter/limiter/gain exactly
  // as the voice does. That is what makes it a valid output-path test.
  const env = osc.outputs[0];
  assert.equal(env.kind, 'gain');
  assert.ok(env.outputs.includes(daf.input), 'envelope lands on the DAF input');
  assert.ok(!env.outputs.includes(ctx.destination), 'must not shortcut to destination');
});

test('playTestTone envelopes the tone rather than clicking it on and off', () => {
  const ctx = new FakeCtx();
  const daf = new DafEngine();
  daf.start(ctx, new FakeNode('source'));
  daf.playTestTone({ durationSec: 0.5 });

  const osc = ctx.created.find((n) => n.kind === 'oscillator');
  const env = osc.outputs[0];
  assert.equal(env.gain.value, 0, 'starts silent');
  assert.equal(env.gain.automations.length, 2, 'ramps up, then back down');
  assert.ok(env.gain.automations.every((a) => a.type === 'setTargetAtTime'));
  assert.ok(osc.stopped > ctx.currentTime + 0.5, 'stops after the fade completes');
});

test('playTestTone is a no-op when DAF is not running', () => {
  const daf = new DafEngine();
  assert.equal(daf.playTestTone(), false, 'no graph means no output path to test');
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
