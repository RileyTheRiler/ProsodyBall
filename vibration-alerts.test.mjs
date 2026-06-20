import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VibrationAlerts } from './vibration-alerts.js';

function makeRule(overrides = {}) {
  return {
    id: 1, metric: 'energy', direction: 'above', threshold: 50,
    enabled: true, tripped: false, cooldownTimer: 0, ...overrides,
  };
}

function ctx(energy) {
  return {
    metrics: { energy, bounce: 0, vowel: 0, articulation: 0 },
    pitchHz: 0, resonance: 0, syllableSpeedFactor: 0,
    gameArea: null, reducedMotion: true, onLiveUpdate: null,
  };
}

test('a rule trips and fires feedback when its metric crosses the threshold', () => {
  const va = new VibrationAlerts();
  va.enabled = true;
  const rule = makeRule();
  va.rules.push(rule);

  va.check(0.016, ctx(0.6)); // energy*100 = 60 > 50

  assert.equal(rule.tripped, true);
  assert.equal(va.flashAlpha, 1);
  assert.equal(va.flashMetric, 'Energy');
  assert.ok(va.globalCooldown > 0);
  assert.ok(rule.cooldownTimer > 0);
});

test('the speech gate prevents tripping during silence', () => {
  const va = new VibrationAlerts();
  va.enabled = true;
  const rule = makeRule();
  va.rules.push(rule);

  va.check(0.016, ctx(0.02)); // energy below 0.05 speech gate

  assert.equal(rule.tripped, false);
  assert.equal(va.flashMetric, '');
});

test('the per-rule cooldown blocks a second trigger before it elapses', () => {
  const va = new VibrationAlerts();
  va.enabled = true;
  const rule = makeRule();
  va.rules.push(rule);

  va.check(0.016, ctx(0.6));
  va.flashAlpha = 0; // observe whether trigger re-fires
  va.check(0.016, ctx(0.6)); // still within cooldown

  assert.equal(va.flashAlpha, 0); // trigger did not re-fire
});

test('flash alpha decays even when disabled', () => {
  const va = new VibrationAlerts();
  va.flashAlpha = 1;
  va.check(0.1, ctx(0));
  assert.ok(va.flashAlpha < 1);
});
