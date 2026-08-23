import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { getElementById: () => null };
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: {} },
  configurable: true,
});

let contexts = [];
class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.closed = false;
    contexts.push(this);
  }
  close() {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
  createMediaStreamSource() {
    throw new Error('source creation failed');
  }
}

globalThis.window = { AudioContext: MockAudioContext };

const { VoiceAnalyzer } = await import('./app.js');

test.beforeEach(() => { contexts = []; });

test('VoiceAnalyzer.start closes its AudioContext when microphone access fails', async () => {
  const denied = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' });
  navigator.mediaDevices.getUserMedia = async () => { throw denied; };
  const analyzer = new VoiceAnalyzer();

  const result = await analyzer.start();

  assert.equal(result.ok, false);
  assert.equal(result.error, 'NotAllowedError');
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closed, true);
  assert.equal(analyzer.audioCtx, null);
});

test('VoiceAnalyzer.start stops acquired tracks when later setup fails', async () => {
  let stopCount = 0;
  const stream = {
    getTracks: () => [{ stop: () => { stopCount++; } }],
  };
  navigator.mediaDevices.getUserMedia = async () => stream;
  const analyzer = new VoiceAnalyzer();

  const result = await analyzer.start();

  assert.equal(result.ok, false);
  assert.equal(stopCount, 1);
  assert.equal(contexts[0].closed, true);
  assert.equal(analyzer.stream, null);
  assert.equal(analyzer.audioCtx, null);
});
