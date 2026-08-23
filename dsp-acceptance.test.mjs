import test from 'node:test';
import assert from 'node:assert/strict';

import {
  outputMetrics,
  frameAcceptanceFailures,
  FRAME_LIVE_ACCEPTANCE,
} from './tools/frame-validity.mjs';
import {
  rhoticLiveFailures,
  RHOTIC_LIVE_ACCEPTANCE,
} from './tools/rho-rhotic.mjs';

test('frame acceptance counts wrong output and abstention separately', () => {
  const m = outputMetrics([
    { outputErr: 0.01 },
    { outputErr: 0.10 },
    { outputErr: null },
  ], 'outputErr');
  assert.deepEqual(m, {
    n: 3,
    correct: 1,
    wrong: 1,
    abstain: 1,
    precision: 50,
    recall: 33.3,
    wrongRate: 33.3,
    abstainRate: 33.3,
  });
});

test('frame acceptance cannot hide a failed vowel in an aggregate', () => {
  const condition = {
    snrDb: 20,
    live: { precision: 90, recall: 70, wrongRate: 8, abstainRate: 22 },
    intervention: { falsePositiveRate: 10 },
    perVowel: { i: { recall: 70 }, u: { recall: 0 } },
    perF0: { 100: { recall: 60 }, 200: { recall: 60 } },
  };
  const failures = frameAcceptanceFailures(condition, FRAME_LIVE_ACCEPTANCE.get(20));
  assert.ok(failures.some((x) => x.includes('/u/ recall 0%')));
});

test('frame acceptance admits a condition only when aggregate and subgroups pass', () => {
  const condition = {
    snrDb: 20,
    live: { precision: 85, recall: 30, wrongRate: 15, abstainRate: 55 },
    intervention: { falsePositiveRate: 20 },
    perVowel: { i: { recall: 10 }, u: { recall: 8 } },
    perF0: { 100: { recall: 10 }, 200: { recall: 8 } },
  };
  assert.deepEqual(frameAcceptanceFailures(condition, FRAME_LIVE_ACCEPTANCE.get(20)), []);
});

test('frame acceptance rejects excessive gate false positives separately from output errors', () => {
  const condition = {
    snrDb: 20,
    live: { precision: 85, recall: 30, wrongRate: 15, abstainRate: 55 },
    intervention: { falsePositiveRate: 30 },
    perVowel: { i: { recall: 10 } },
    perF0: { 100: { recall: 10 } },
  };
  assert.deepEqual(frameAcceptanceFailures(condition, FRAME_LIVE_ACCEPTANCE.get(20)), [
    'intervention false positives 30% > 25%',
  ]);
});

test('live rhotic acceptance fails zero recall even when the average is high', () => {
  const result = {
    correct: 90,
    wrong: 8,
    abstain: 2,
    rhoticRecall: 0,
    detectorFalsePositiveRate: 1,
    perVowel: { i: { correct: 60 }, 'ɝ': { correct: 0 } },
  };
  const failures = rhoticLiveFailures(result, RHOTIC_LIVE_ACCEPTANCE);
  assert.ok(failures.some((x) => x.includes('/ɝ/ recall 0%')));
  assert.ok(failures.some((x) => x.includes('/ɝ/ has zero correct frames')));
});

test('live rhotic acceptance prevents recall bought with false positives', () => {
  const result = {
    correct: 75,
    wrong: 20,
    abstain: 5,
    rhoticRecall: 70,
    detectorFalsePositiveRate: 12,
    perVowel: { i: { correct: 30 }, 'ɝ': { correct: 30 } },
  };
  const failures = rhoticLiveFailures(result, RHOTIC_LIVE_ACCEPTANCE);
  assert.deepEqual(failures, ['rhotic false positives 12%']);
});
