import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClipMetrics } from './dsp-utils.js';

const voiced = (hz, extra = {}) => ({ hz, conf: 0.9, voiced: true, res: 0.5, prosody: 0.5, ...extra });

test('summarizeClipMetrics: returns null for empty and non-array input', () => {
  assert.equal(summarizeClipMetrics([]), null);
  assert.equal(summarizeClipMetrics(null), null);
  assert.equal(summarizeClipMetrics(undefined), null);
  assert.equal(summarizeClipMetrics('nope'), null);
});

test('summarizeClipMetrics: returns null when all samples are unvoiced or low-confidence', () => {
  const unvoiced = Array.from({ length: 20 }, () => voiced(180, { voiced: false }));
  assert.equal(summarizeClipMetrics(unvoiced), null);
  const lowConf = Array.from({ length: 20 }, () => voiced(180, { conf: 0.1 }));
  assert.equal(summarizeClipMetrics(lowConf), null);
});

test('summarizeClipMetrics: returns null when voiced count is below minVoiced', () => {
  const samples = [voiced(150), voiced(180), voiced(210), voiced(0, { voiced: false })];
  assert.equal(summarizeClipMetrics(samples), null); // 3 voiced < default 5
});

test('summarizeClipMetrics: computes exact pitch avg/min/max over voiced samples', () => {
  const samples = [voiced(150), voiced(180), voiced(210), voiced(150), voiced(210)];
  const m = summarizeClipMetrics(samples);
  assert.ok(m);
  assert.equal(m.pitchAvgHz, 180);
  assert.equal(m.pitchMinHz, 150);
  assert.equal(m.pitchMaxHz, 210);
});

test('summarizeClipMetrics: low-confidence samples excluded from stats but counted in sampleCount', () => {
  const samples = [
    ...Array.from({ length: 5 }, () => voiced(200)),
    voiced(900, { conf: 0.1 }), // outlier that must not affect stats
  ];
  const m = summarizeClipMetrics(samples);
  assert.ok(m);
  assert.equal(m.pitchAvgHz, 200);
  assert.equal(m.pitchMaxHz, 200);
  assert.equal(m.sampleCount, 6);
  assert.ok(Math.abs(m.voicedRatio - 5 / 6) < 1e-12);
});

test('summarizeClipMetrics: voicedRatio and sampleCount reflect the full sample set', () => {
  const samples = [
    ...Array.from({ length: 6 }, () => voiced(180)),
    ...Array.from({ length: 4 }, () => voiced(0, { voiced: false, hz: 0 })),
  ];
  const m = summarizeClipMetrics(samples);
  assert.ok(m);
  assert.equal(m.voicedRatio, 0.6);
  assert.equal(m.sampleCount, 10);
});

test('summarizeClipMetrics: clamps out-of-range resonance and prosody before averaging', () => {
  const samples = [
    ...Array.from({ length: 3 }, () => voiced(180, { res: -0.5, prosody: -2 })),
    ...Array.from({ length: 3 }, () => voiced(180, { res: 1.7, prosody: 3 })),
  ];
  const m = summarizeClipMetrics(samples);
  assert.ok(m);
  assert.equal(m.resonanceAvg, 0.5); // (0 + 1) / 2
  assert.equal(m.prosodyAvg, 0.5);
});

test('summarizeClipMetrics: missing res/prosody fields do not produce NaN', () => {
  const samples = Array.from({ length: 5 }, () => ({ hz: 180, conf: 0.9, voiced: true }));
  const m = summarizeClipMetrics(samples);
  assert.ok(m);
  assert.equal(m.resonanceAvg, 0);
  assert.equal(m.prosodyAvg, 0);
  assert.ok(Number.isFinite(m.pitchAvgHz));
});

test('summarizeClipMetrics: exactly minVoiced identical-pitch samples give avg === min === max', () => {
  const samples = Array.from({ length: 5 }, () => voiced(165));
  const m = summarizeClipMetrics(samples);
  assert.ok(m);
  assert.equal(m.pitchAvgHz, 165);
  assert.equal(m.pitchMinHz, 165);
  assert.equal(m.pitchMaxHz, 165);
});

test('summarizeClipMetrics: minConf and minVoiced options are respected', () => {
  const samples = [voiced(180, { conf: 0.2 }), voiced(200, { conf: 0.2 })];
  assert.equal(summarizeClipMetrics(samples), null);
  const m = summarizeClipMetrics(samples, { minConf: 0.15, minVoiced: 2 });
  assert.ok(m);
  assert.equal(m.pitchAvgHz, 190);
  // Raising minVoiced above the voiced count nulls it again.
  assert.equal(summarizeClipMetrics(samples, { minConf: 0.15, minVoiced: 3 }), null);
});
