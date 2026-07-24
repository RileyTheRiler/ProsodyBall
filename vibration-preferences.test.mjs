import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVibrationPreferences,
  serializeVibrationPreferences,
} from './vibration-preferences.js';

test('vibration preferences round-trip durable rule fields only', () => {
  const source = {
    enabled: true,
    rules: [{
      id: 7,
      metric: 'pitch',
      direction: 'below',
      threshold: 155,
      enabled: true,
      cooldownTimer: 0.4,
      tripped: true,
    }],
  };

  const restored = parseVibrationPreferences(serializeVibrationPreferences(source));
  assert.equal(restored.enabled, true);
  assert.deepEqual(restored.rules, [{
    id: 7,
    metric: 'pitch',
    direction: 'below',
    threshold: 155,
    enabled: true,
    cooldownTimer: 0,
    tripped: false,
  }]);
  assert.equal(restored.nextId, 8);
});

test('vibration preferences reject corrupt data and clamp thresholds', () => {
  assert.deepEqual(parseVibrationPreferences('{nope'), { enabled: false, rules: [], nextId: 1 });

  const restored = parseVibrationPreferences({
    enabled: 'yes',
    rules: [
      { id: 2, metric: 'resonance', direction: 'above', threshold: 999 },
      { id: 3, metric: 'unknown', direction: 'below', threshold: 20 },
    ],
  });
  assert.equal(restored.enabled, false);
  assert.equal(restored.rules.length, 1);
  assert.equal(restored.rules[0].threshold, 100);
});
