import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingObjectUrlPool } from './recording-lifecycle.js';

globalThis.document = { getElementById: () => null };
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
globalThis.window = {};

const { VoxBallGame } = await import('./app.js');

class MockMediaRecorder {
  static isTypeSupported(type) { return type.includes('webm'); }
  constructor(_stream, options = {}) {
    this.mimeType = options.mimeType || 'audio/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(1024)], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
}

function makeGame() {
  const game = Object.create(VoxBallGame.prototype);
  game.analyzer = {
    audioCtx: { sampleRate: 48000 },
    analyserRec: { fftSize: 512, getFloatTimeDomainData: (target) => target.fill(0.05) },
    recTimeDomainData: new Float32Array(512),
    stream: { getTracks: () => [{ readyState: 'live' }] },
    isCalibrated: true,
    noiseFloor: 0.001,
    smoothPitchHz: 180,
    pitchConfidence: 0.9,
    lastPitch: 180,
    smoothResonance: 0.5,
    syllableImpulse: 0,
  };
  Object.assign(game, {
    isRecording: false,
    _recInterval: null,
    _recDurationTimer: null,
    _recStopTimer: null,
    _recSampleRate: 48000,
    _mediaRecorder: null,
    _recUseMediaRecorder: false,
    _recMimeType: null,
    _recordingGeneration: 0,
    _recordingAttempt: null,
    _recordingFinalizePromise: null,
    _recordingLimitStopRequested: false,
    _recordingUrls: new RecordingObjectUrlPool({
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => {},
    }),
    _playbackGeneration: 0,
    _recordingListenerCount: 0,
    recordings: [],
    currentPlayback: null,
    currentSpeech: null,
    _pendingClipLabel: null,
    _pendingPhrase: null,
    _pendingPhraseDef: null,
    prosodyScore: 0.5,
    goalMode: 'feminization',
    practice: { active: false },
  });
  game.updateRecordingsUI = () => {};
  game._updateVoiceRecBtn = () => {};
  return game;
}

test.beforeEach(() => { globalThis.MediaRecorder = MockMediaRecorder; });

test('100 record/stop/delete cycles release all take-owned resources', async () => {
  const game = makeGame();
  for (let i = 0; i < 100; i++) {
    assert.equal(game.startRecording(), true);
    await game.stopRecording();
    assert.equal(game.recordings.length, 1);
    assert.equal(game.recordings[0].blob.size, 1024);
    assert.equal('dataUrl' in game.recordings[0], false);
    game.deleteRecording(0);
  }
  const snapshot = game.getRecordingResourceSnapshot();
  assert.equal(snapshot.retainedAudioBytes, 0);
  assert.equal(snapshot.activeChunks, 0);
  assert.equal(snapshot.activeMetricSamples, 0);
  assert.equal(snapshot.recordingTimers, 0);
  assert.equal(game._mediaRecorder, null);
});

test('cancel invalidates queued recorder callbacks so no clip can reappear', async () => {
  const game = makeGame();
  assert.equal(game.startRecording(), true);
  const recorder = game._mediaRecorder;
  game.cancelRecording('test');
  await Promise.resolve();
  recorder.ondataavailable?.({ data: new Blob(['late']) });
  recorder.onstop?.();
  assert.equal(game.recordings.length, 0);
  assert.equal(game.getRecordingResourceSnapshot().recordingTimers, 0);
});

test('MediaRecorder start failure clears intervals, timeouts, callbacks and buffers', () => {
  class FailingMediaRecorder extends MockMediaRecorder {
    start() { throw new Error('start failed'); }
  }
  globalThis.MediaRecorder = FailingMediaRecorder;
  const game = makeGame();
  game._notifyRecording = () => {};
  assert.equal(game.startRecording(), false);
  const snapshot = game.getRecordingResourceSnapshot();
  assert.equal(snapshot.activeChunks, 0);
  assert.equal(snapshot.activeMetricSamples, 0);
  assert.equal(snapshot.recordingTimers, 0);
  assert.equal(game._mediaRecorder, null);
});
