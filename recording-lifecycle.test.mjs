import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORDING_LIMITS,
  RecordingAttempt,
  RecordingObjectUrlPool,
  recordingCapacity,
  retainedAudioBytes,
  retainedMetricSamples,
} from './recording-lifecycle.js';

const tinyLimits = (overrides = {}) => ({
  ...RECORDING_LIMITS,
  maxDurationMs: 1000,
  maxSavedRecordings: 3,
  maxRetainedAudioBytes: 100,
  maxActiveAudioBytes: 40,
  metricSamplesPerSecond: 10,
  ...overrides,
});

test('long takes retain a deterministic metric-sample ceiling', () => {
  const attempt = new RecordingAttempt({ id: 1, startedAtMs: 0 });
  const timerTickMs = 11;
  for (let now = 0; now <= RECORDING_LIMITS.maxDurationMs + 1000; now += timerTickMs) {
    attempt.addMetric(1, now, { hz: 180 });
  }
  const snapshot = attempt.snapshot();
  assert.ok(snapshot.activeMetricSamples <= 15001);
  assert.ok(snapshot.activeMetricSamples >= 14900);
  assert.equal(attempt.durationLimitReached(RECORDING_LIMITS.maxDurationMs), true);
});

test('active PCM bytes trigger the per-take bound and clear on cancellation', () => {
  const attempt = new RecordingAttempt({ id: 7, startedAtMs: 0, limits: tinyLimits() });
  assert.equal(attempt.addPcmFrame(7, new Float32Array(10)), false); // 20 bytes
  assert.equal(attempt.addPcmFrame(7, new Float32Array(10)), true);  // 40 bytes
  assert.deepEqual(attempt.snapshot(), {
    attemptId: 7,
    activeChunks: 2,
    activeAudioBytes: 40,
    activeMetricSamples: 0,
    audioByteLimit: 40,
  });
  attempt.clear();
  assert.equal(attempt.snapshot().activeChunks, 0);
  assert.equal(attempt.snapshot().activeAudioBytes, 0);
});

test('detached and stale attempts cannot restore resources', () => {
  const attempt = new RecordingAttempt({ id: 3, startedAtMs: 0, limits: tinyLimits() });
  attempt.addEncodedChunk(3, new Blob(['abc']));
  attempt.addMetric(3, 0, { hz: 180 });
  const resources = attempt.detach(3);
  assert.equal(resources.encodedChunks.length, 1);
  assert.equal(resources.metricSamples.length, 1);
  assert.equal(attempt.addEncodedChunk(3, new Blob(['late'])), false);
  assert.equal(attempt.addMetric(4, 200, { hz: 999 }), false);
  assert.equal(attempt.snapshot().activeChunks, 0);
});

test('saved clip count and retained bytes block new recordings without deleting clips', () => {
  const limits = tinyLimits();
  const recordings = [
    { blob: new Blob([new Uint8Array(30)]), contourSeries: [{}, {}] },
    { blob: new Blob([new Uint8Array(40)]), contourSeries: [{}] },
  ];
  assert.equal(retainedAudioBytes(recordings), 70);
  assert.equal(retainedMetricSamples(recordings), 3);
  assert.deepEqual(recordingCapacity(recordings, limits), {
    ok: true, count: 2, bytes: 70, availableBytes: 30, reason: null,
  });
  recordings.push({ blob: new Blob([new Uint8Array(1)]) });
  assert.equal(recordingCapacity(recordings, limits).reason, 'clip-count');
  assert.equal(recordings.length, 3);
});

test('playback URLs revoke on release and download URLs wait for their consumer', () => {
  let nextUrl = 0;
  const revoked = [];
  const timers = new Map();
  let nextTimer = 0;
  const pool = new RecordingObjectUrlPool({
    createObjectURL: () => `blob:test-${++nextUrl}`,
    revokeObjectURL: (url) => revoked.push(url),
    setTimer: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id),
  });

  const playback = pool.create(new Blob(['play']), 'playback');
  assert.equal(pool.snapshot().activeObjectUrls, 1);
  pool.release(playback);
  assert.deepEqual(revoked, [playback]);

  const download = pool.create(new Blob(['download']), 'download');
  pool.releaseAfter(download, 1000);
  assert.deepEqual(pool.snapshot(), { activeObjectUrls: 1, objectUrlTimers: 1 });
  [...timers.values()][0]();
  assert.deepEqual(pool.snapshot(), { activeObjectUrls: 0, objectUrlTimers: 0 });
  assert.deepEqual(revoked, [playback, download]);
});

test('repeated start/cancel cycles retain no active chunks or samples', () => {
  for (let id = 1; id <= 200; id++) {
    const attempt = new RecordingAttempt({ id, startedAtMs: 0, limits: tinyLimits() });
    attempt.addEncodedChunk(id, new Blob(['chunk']));
    attempt.addMetric(id, 0, { hz: 180 });
    attempt.clear();
    assert.equal(attempt.snapshot().activeChunks, 0);
    assert.equal(attempt.snapshot().activeMetricSamples, 0);
  }
});
