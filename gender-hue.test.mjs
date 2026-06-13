import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGenderScore, genderScoreToHue } from './dsp-utils.js';

test('genderScoreToHue maps the palette anchors (blue -> purple -> pink)', () => {
  assert.equal(genderScoreToHue(0), 210);    // masculine = blue
  assert.equal(genderScoreToHue(0.5), 275);  // androgynous/nonbinary = purple center
  assert.equal(genderScoreToHue(1), 340);    // feminine = pink
});

test('genderScoreToHue clamps out-of-range scores', () => {
  assert.equal(genderScoreToHue(-1), 210);
  assert.equal(genderScoreToHue(2), 340);
});

test('genderScoreToHue colorblind ramp goes blue -> yellow', () => {
  assert.equal(genderScoreToHue(0, true), 220);
  assert.equal(genderScoreToHue(1, true), 55);
});

test('low pitch + low resonance reads masculine (score < 0.5)', () => {
  const score = computeGenderScore({
    pitchHz: 110, resonance: 0.15,
    pitchConfidence: 0.9, formantConfidence: 0.9,
  });
  assert.ok(score < 0.4, `expected masculine, got ${score}`);
});

test('high pitch + high resonance reads feminine (score > 0.5)', () => {
  const score = computeGenderScore({
    pitchHz: 220, resonance: 0.9,
    pitchConfidence: 0.9, formantConfidence: 0.9,
  });
  assert.ok(score > 0.6, `expected feminine, got ${score}`);
});

// Core acceptance: a deep-voiced singer (Johnny Cash) hitting high notes has a high
// F0 but masculine vocal-tract resonance. The resonance cue must pull the score back
// below center so the orb stays blue/purple, NOT pink.
test('Johnny-Cash regression: high pitch + low resonance does NOT read feminine', () => {
  const score = computeGenderScore({
    pitchHz: 200, resonance: 0.2,
    pitchConfidence: 0.9, formantConfidence: 0.9,
  });
  assert.ok(score < 0.5, `expected sub-center (masculine-leaning), got ${score}`);
  const hue = genderScoreToHue(score);
  assert.ok(hue < 275, `expected blue/purple hue (<275), got ${hue}`);
});

test('low confidence on both cues collapses toward androgynous center (~0.5)', () => {
  const score = computeGenderScore({
    pitchHz: 230, resonance: 0.95,
    pitchConfidence: 0.05, formantConfidence: 0.05,
  });
  assert.ok(Math.abs(score - 0.5) < 0.1, `expected near 0.5, got ${score}`);
});

test('confident resonance outweighs an unreliable pitch estimate', () => {
  // Pitch looks high but is untrusted; resonance is clearly masculine and trusted.
  const score = computeGenderScore({
    pitchHz: 230, resonance: 0.1,
    pitchConfidence: 0.1, formantConfidence: 0.95,
  });
  assert.ok(score < 0.5, `expected resonance to win (masculine), got ${score}`);
});

test('zero/unknown pitch defaults pitch cue to neutral, not masculine', () => {
  const score = computeGenderScore({
    pitchHz: 0, resonance: 0.5,
    pitchConfidence: 0, formantConfidence: 0.5,
  });
  assert.ok(Math.abs(score - 0.5) < 0.1, `expected near 0.5, got ${score}`);
});
