import test from 'node:test';
import assert from 'node:assert/strict';
import { runCalibrationWithTimeout } from './calibration-runner.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('runCalibrationWithTimeout clears its guard after a successful run', async () => {
  let cancelCount = 0;
  const wizard = {
    run: async () => ({ outcome: 'calibrated' }),
    cancel: () => { cancelCount++; },
  };
  assert.deepEqual(await runCalibrationWithTimeout(wizard, {}, 10), { outcome: 'calibrated' });
  await wait(20);
  assert.equal(cancelCount, 0);
});

test('runCalibrationWithTimeout cancels and returns a stable timeout result', async () => {
  let cancelCount = 0;
  const wizard = {
    run: () => new Promise(() => {}),
    cancel: () => { cancelCount++; },
  };
  assert.deepEqual(await runCalibrationWithTimeout(wizard, {}, 5), {
    outcome: 'incomplete', skipped: true, reason: 'wizard-timeout',
  });
  assert.equal(cancelCount, 1);
});

test('runCalibrationWithTimeout clears its guard when the wizard rejects', async () => {
  let cancelCount = 0;
  const wizard = {
    run: async () => { throw new Error('calibration failed'); },
    cancel: () => { cancelCount++; },
  };
  await assert.rejects(runCalibrationWithTimeout(wizard, {}, 10), /calibration failed/);
  await wait(20);
  assert.equal(cancelCount, 0);
});
