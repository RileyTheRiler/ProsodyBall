import test from 'node:test';
import assert from 'node:assert/strict';

// app.js reaches for the DOM at module scope (it constructs the game when #app exists).
// Stub just enough for the import; VoiceAnalyzer's own constructor is DOM-free.
global.document = { getElementById: () => null };
global.window = { AudioContext: class {}, webkitAudioContext: class {}, navigator: { mediaDevices: {} } };
Object.defineProperty(global, 'navigator', { value: global.window.navigator, writable: true, configurable: true });

const { VoiceAnalyzer } = await import('./app.js');

// Stand in for the accumulation update() does during the room check: noiseSpectralProfile
// holds a running SUM of each frame's per-bin magnitude, awaiting the divide-by-N that
// finalizeNoiseCalibration() performs.
function analyzerWithPartialCalibration(frames, perFrameMag = 0.02) {
  const a = new VoiceAnalyzer();
  a.noiseSpectralProfile = new Float32Array(16).fill(perFrameMag * frames);
  a.noiseCalibrationSamples = Array.from({ length: frames }, () => 0.004);
  a.hfCalibrationSamples = Array.from({ length: frames }, () => 0.001);
  a.micCalibrationTiltSamples = Array.from({ length: frames }, () => -20);
  return a;
}

test('finalizeNoiseCalibration averages the accumulated per-bin noise profile', () => {
  const frames = 12;
  const a = analyzerWithPartialCalibration(frames);

  a.finalizeNoiseCalibration();

  assert.equal(a.isCalibrated, true);
  assert.ok(a.noiseSpectralProfile, 'a well-sampled profile is kept');
  // The stored value must be the per-frame mean, not the raw sum.
  assert.ok(Math.abs(a.noiseSpectralProfile[0] - 0.02) < 1e-6,
    `expected the mean 0.02, got ${a.noiseSpectralProfile[0]}`);
});

test('finalizeNoiseCalibration drops a profile built from too few frames', () => {
  const a = analyzerWithPartialCalibration(3);

  a.finalizeNoiseCalibration();

  assert.equal(a.isCalibrated, true, 'the session still starts');
  assert.equal(a.noiseSpectralProfile, null,
    'an under-sampled profile is discarded in favour of the scalar fallback');
});

// The regression this guards: the wizard's skip/cancel/timeout paths used to set
// isCalibrated = true directly, leaving noiseSpectralProfile holding the raw SUM. A profile
// N frames too loud pinned SNR to the red tier and made spectral subtraction floor the whole
// spectrum, so the ball stayed grey for the entire session.
test('a cancelled room check never leaves an un-averaged noise profile in place', () => {
  for (const frames of [1, 3, 7, 8, 12, 40]) {
    const a = analyzerWithPartialCalibration(frames);
    const rawSum = a.noiseSpectralProfile[0];

    a.finalizeNoiseCalibration();

    assert.equal(a.isCalibrated, true);
    if (a.noiseSpectralProfile) {
      assert.ok(a.noiseSpectralProfile[0] < rawSum || frames === 1,
        `profile at ${frames} frames was never divided by N`);
      assert.ok(Math.abs(a.noiseSpectralProfile[0] - 0.02) < 1e-6,
        `profile at ${frames} frames is not the per-frame mean`);
    }
  }
});

test('finalizeNoiseCalibration is a no-op once calibration has completed', () => {
  const a = analyzerWithPartialCalibration(12);
  a.finalizeNoiseCalibration();
  const averaged = a.noiseSpectralProfile[0];

  a.finalizeNoiseCalibration(); // e.g. the skip-path guard firing after a real calibration

  assert.ok(Math.abs(a.noiseSpectralProfile[0] - averaged) < 1e-9,
    'a second call must not divide the profile again');
});

test('finalizeNoiseCalibration survives a skip with no samples at all', () => {
  const a = new VoiceAnalyzer(); // user hit Skip on the welcome step; update() never ran

  a.finalizeNoiseCalibration();

  assert.equal(a.isCalibrated, true);
  assert.equal(a.noiseSpectralProfile, null);
  assert.ok(a.noiseFloor >= 0.008 && Number.isFinite(a.noiseFloor),
    `noiseFloor must stay finite without samples, got ${a.noiseFloor}`);
  assert.ok(Number.isFinite(a.hfNoiseFloor), 'hfNoiseFloor must not become NaN');
});

test('a real calibration can lower thresholds set by an earlier noisier room', () => {
  const a = analyzerWithPartialCalibration(12, 0.02);
  a.syllableThreshold = 0.5; // stale values from a previous, much louder room
  a.sustainedThreshold = 0.6;

  a.finalizeNoiseCalibration();

  assert.ok(a.syllableThreshold < 0.5, 'recalibration must replace, not max(), the thresholds');
  assert.ok(Math.abs(a.syllableThreshold - a.noiseFloor * 1.2) < 1e-9);
  assert.ok(Math.abs(a.sustainedThreshold - a.noiseFloor * 1.5) < 1e-9);
});
