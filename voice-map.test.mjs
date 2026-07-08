import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pitchHzToLogPosition,
  summarizeVoiceCloud,
  voiceMapZoneFromRules,
} from './dsp-utils.js';

// ====== pitchHzToLogPosition ======

test('pitchHzToLogPosition: endpoints and clamping', () => {
  assert.equal(pitchHzToLogPosition(80, 80, 400), 0);
  assert.equal(pitchHzToLogPosition(400, 80, 400), 1);
  assert.equal(pitchHzToLogPosition(40, 80, 400), 0);   // below range clamps
  assert.equal(pitchHzToLogPosition(800, 80, 400), 1);  // above range clamps
});

test('pitchHzToLogPosition: log spacing — one octave is a fixed fraction', () => {
  // 80→400 spans log2(5) octaves; 80→160 (one octave) should sit at 1/log2(5).
  const oneOctave = pitchHzToLogPosition(160, 80, 400);
  assert.ok(Math.abs(oneOctave - 1 / Math.log2(5)) < 1e-9);
  // Equal musical intervals map to equal position steps: 100→200 and 150→300.
  const step1 = pitchHzToLogPosition(200, 80, 400) - pitchHzToLogPosition(100, 80, 400);
  const step2 = pitchHzToLogPosition(300, 80, 400) - pitchHzToLogPosition(150, 80, 400);
  assert.ok(Math.abs(step1 - step2) < 1e-9);
});

test('pitchHzToLogPosition: invalid input returns 0', () => {
  assert.equal(pitchHzToLogPosition(0), 0);
  assert.equal(pitchHzToLogPosition(-50), 0);
  assert.equal(pitchHzToLogPosition(NaN), 0);
});

// ====== summarizeVoiceCloud ======

test('summarizeVoiceCloud: empty and invalid inputs return null', () => {
  assert.equal(summarizeVoiceCloud([]), null);
  assert.equal(summarizeVoiceCloud(null), null);
  assert.equal(summarizeVoiceCloud([{ hz: 0, res: 0.5 }]), null); // unvoiced filtered out
});

test('summarizeVoiceCloud: single point — zero spread, point stats', () => {
  const s = summarizeVoiceCloud([{ hz: 165, res: 0.6, w: 0.8 }]);
  assert.equal(s.n, 1);
  assert.ok(Math.abs(s.meanHz - 165) < 1e-9);
  assert.ok(Math.abs(s.meanRes - 0.6) < 1e-9);
  assert.equal(s.sdSemitones, 0);
  assert.equal(s.sdRes, 0);
  assert.equal(s.medianHz, 165);
  assert.ok(Math.abs(s.medianRes - 0.6) < 1e-9);
});

test('summarizeVoiceCloud: pitch mean is geometric, spread is in semitones', () => {
  // One octave apart with equal weight: geometric mean = sqrt(100*200), SD = 6 st each side.
  const s = summarizeVoiceCloud([
    { hz: 100, res: 0.4, w: 1 },
    { hz: 200, res: 0.6, w: 1 },
  ]);
  assert.ok(Math.abs(s.meanHz - Math.sqrt(100 * 200)) < 1e-6);
  assert.ok(Math.abs(s.sdSemitones - 6) < 1e-9);
  assert.ok(Math.abs(s.meanRes - 0.5) < 1e-9);
  assert.ok(Math.abs(s.sdRes - 0.1) < 1e-9);
  assert.equal(s.medianHz, 150); // arithmetic median of [100, 200]
});

test('summarizeVoiceCloud: confidence weights pull the mean toward confident samples', () => {
  const s = summarizeVoiceCloud([
    { hz: 100, res: 0.2, w: 0.001 },
    { hz: 200, res: 0.8, w: 1 },
  ]);
  assert.ok(s.meanHz > 195, `meanHz ${s.meanHz} should sit near the confident 200 Hz sample`);
  assert.ok(s.meanRes > 0.79);
});

test('summarizeVoiceCloud: missing weight defaults to 1', () => {
  const s = summarizeVoiceCloud([
    { hz: 100, res: 0.5 },
    { hz: 200, res: 0.5 },
  ]);
  assert.ok(Math.abs(s.meanHz - Math.sqrt(100 * 200)) < 1e-6);
});

test('summarizeVoiceCloud: resonance clamped to 0..1', () => {
  const s = summarizeVoiceCloud([{ hz: 150, res: 1.7, w: 1 }]);
  assert.equal(s.meanRes, 1);
  assert.equal(s.medianRes, 1);
});

// ====== voiceMapZoneFromRules ======

test('voiceMapZoneFromRules: no rules → null', () => {
  assert.equal(voiceMapZoneFromRules(null), null);
  assert.equal(voiceMapZoneFromRules([]), null);
  assert.equal(voiceMapZoneFromRules([{ metric: 'energy', direction: 'below', threshold: 10 }]), null);
});

test('voiceMapZoneFromRules: below = floor, above = ceiling', () => {
  const z = voiceMapZoneFromRules([
    { metric: 'pitch', direction: 'below', threshold: 150 },
    { metric: 'pitch', direction: 'above', threshold: 250 },
    { metric: 'resonance', direction: 'below', threshold: 30 },
    { metric: 'resonance', direction: 'above', threshold: 70 },
  ]);
  assert.equal(z.pitchMinHz, 150);
  assert.equal(z.pitchMaxHz, 250);
  assert.ok(Math.abs(z.resMin - 0.3) < 1e-9); // percent → 0..1
  assert.ok(Math.abs(z.resMax - 0.7) < 1e-9);
});

test('voiceMapZoneFromRules: partial rules leave other bounds open', () => {
  const z = voiceMapZoneFromRules([{ metric: 'pitch', direction: 'below', threshold: 165 }]);
  assert.equal(z.pitchMinHz, 165);
  assert.equal(z.pitchMaxHz, null);
  assert.equal(z.resMin, null);
  assert.equal(z.resMax, null);
});

test('voiceMapZoneFromRules: duplicate rules take the most restrictive bound', () => {
  const z = voiceMapZoneFromRules([
    { metric: 'pitch', direction: 'below', threshold: 140 },
    { metric: 'pitch', direction: 'below', threshold: 160 },
    { metric: 'pitch', direction: 'above', threshold: 300 },
    { metric: 'pitch', direction: 'above', threshold: 260 },
  ]);
  assert.equal(z.pitchMinHz, 160);
  assert.equal(z.pitchMaxHz, 260);
});

test('voiceMapZoneFromRules: contradictory bounds drop that axis', () => {
  // Floor above ceiling is meaningless — the axis is dropped; with nothing else, null.
  assert.equal(voiceMapZoneFromRules([
    { metric: 'pitch', direction: 'below', threshold: 300 },
    { metric: 'pitch', direction: 'above', threshold: 200 },
  ]), null);
  // But a valid resonance axis survives a contradictory pitch pair.
  const z = voiceMapZoneFromRules([
    { metric: 'pitch', direction: 'below', threshold: 300 },
    { metric: 'pitch', direction: 'above', threshold: 200 },
    { metric: 'resonance', direction: 'below', threshold: 40 },
  ]);
  assert.equal(z.pitchMinHz, null);
  assert.equal(z.pitchMaxHz, null);
  assert.ok(Math.abs(z.resMin - 0.4) < 1e-9);
});

test('voiceMapZoneFromRules: non-finite thresholds ignored', () => {
  assert.equal(voiceMapZoneFromRules([
    { metric: 'pitch', direction: 'below', threshold: NaN },
    { metric: 'resonance', direction: 'above', threshold: Infinity },
  ]), null);
});
