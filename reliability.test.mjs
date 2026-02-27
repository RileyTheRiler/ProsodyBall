import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAudioContextRunning } from './reliability.js';

test('ensureAudioContextRunning handles missing context', async () => {
  const result = await ensureAudioContextRunning(null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-context');
});

test('ensureAudioContextRunning resumes suspended context', async () => {
  const ctx = {
    state: 'suspended',
    async resume() {
      this.state = 'running';
    }
  };
  const result = await ensureAudioContextRunning(ctx);
  assert.equal(result.ok, true);
});

test('ensureAudioContextRunning surfaces resume failure reason', async () => {
  const ctx = {
    state: 'suspended',
    async resume() {
      throw new Error('blocked-by-policy');
    }
  };
  const result = await ensureAudioContextRunning(ctx);
  assert.equal(result.ok, false);
  assert.match(result.reason, /blocked-by-policy/);
});
