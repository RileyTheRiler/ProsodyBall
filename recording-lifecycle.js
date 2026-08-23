const MIB = 1024 * 1024;

// Recordings are intentionally memory-only. These product limits bound a tab's retained
// recording state without deleting an existing clip behind the user's back.
export const RECORDING_LIMITS = Object.freeze({
  maxDurationMs: 10 * 60 * 1000,
  maxSavedRecordings: 20,
  maxRetainedAudioBytes: 256 * MIB,
  maxActiveAudioBytes: 64 * MIB,
  metricSamplesPerSecond: 25,
  mediaRecorderTimesliceMs: 1000,
  recorderStopTimeoutMs: 5000,
  downloadUrlReleaseMs: 1000,
  maxPendingDownloads: 4,
});

export function retainedAudioBytes(recordings) {
  return (Array.isArray(recordings) ? recordings : []).reduce(
    (total, recording) => total + Math.max(0, Number(recording?.blob?.size) || 0),
    0,
  );
}

export function retainedMetricSamples(recordings) {
  return (Array.isArray(recordings) ? recordings : []).reduce(
    (total, recording) => total + (Array.isArray(recording?.contourSeries) ? recording.contourSeries.length : 0),
    0,
  );
}

export function recordingCapacity(recordings, limits = RECORDING_LIMITS) {
  const count = Array.isArray(recordings) ? recordings.length : 0;
  const bytes = retainedAudioBytes(recordings);
  if (count >= limits.maxSavedRecordings) {
    return { ok: false, count, bytes, availableBytes: 0, reason: 'clip-count' };
  }
  const availableBytes = Math.max(0, limits.maxRetainedAudioBytes - bytes);
  if (availableBytes <= 0) {
    return { ok: false, count, bytes, availableBytes, reason: 'audio-bytes' };
  }
  return { ok: true, count, bytes, availableBytes, reason: null };
}

// Owns all transient arrays for one take. Moving the arrays out at finalization and clearing
// them on cancellation makes ownership visible and prevents an old recorder callback from
// appending into a later take.
export class RecordingAttempt {
  constructor({ id, startedAtMs, retainedBytes = 0, limits = RECORDING_LIMITS }) {
    this.id = id;
    this.startedAtMs = startedAtMs;
    this.limits = limits;
    this.audioByteLimit = Math.max(0, Math.min(
      limits.maxActiveAudioBytes,
      limits.maxRetainedAudioBytes - retainedBytes,
    ));
    this.encodedChunks = [];
    this.pcmChunks = [];
    this.metricSamples = [];
    this.activeAudioBytes = 0;
    this.nextMetricAtMs = startedAtMs;
    this.detached = false;
  }

  accepts(id) {
    return !this.detached && id === this.id;
  }

  addMetric(id, nowMs, sample) {
    if (!this.accepts(id) || nowMs < this.nextMetricAtMs) return false;
    const intervalMs = 1000 / this.limits.metricSamplesPerSecond;
    const maxSamples = Math.ceil(this.limits.maxDurationMs / intervalMs) + 1;
    if (this.metricSamples.length >= maxSamples) return false;
    this.metricSamples.push(sample);
    // Advance the ideal schedule so rounding an 11.6 ms recorder tick does not compound
    // into a lower sample rate. After a real stall, resume from now instead of backfilling.
    this.nextMetricAtMs = nowMs - this.nextMetricAtMs > intervalMs
      ? nowMs + intervalMs
      : this.nextMetricAtMs + intervalMs;
    return true;
  }

  addEncodedChunk(id, chunk) {
    if (!this.accepts(id) || !chunk || !(chunk.size > 0)) return false;
    this.encodedChunks.push(chunk);
    this.activeAudioBytes += chunk.size;
    return this.activeAudioBytes >= this.audioByteLimit;
  }

  addPcmFrame(id, floatSamples) {
    if (!this.accepts(id) || !floatSamples?.length) return false;
    const pcm = new Int16Array(floatSamples.length);
    for (let i = 0; i < floatSamples.length; i++) {
      const sample = Math.max(-1, Math.min(1, floatSamples[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    this.pcmChunks.push(pcm);
    this.activeAudioBytes += pcm.byteLength;
    return this.activeAudioBytes >= this.audioByteLimit;
  }

  durationLimitReached(nowMs) {
    return nowMs - this.startedAtMs >= this.limits.maxDurationMs;
  }

  detach(id) {
    if (!this.accepts(id)) return null;
    this.detached = true;
    const resources = {
      encodedChunks: this.encodedChunks,
      pcmChunks: this.pcmChunks,
      metricSamples: this.metricSamples,
      activeAudioBytes: this.activeAudioBytes,
    };
    this.encodedChunks = [];
    this.pcmChunks = [];
    this.metricSamples = [];
    this.activeAudioBytes = 0;
    return resources;
  }

  clear() {
    this.detached = true;
    this.encodedChunks = [];
    this.pcmChunks = [];
    this.metricSamples = [];
    this.activeAudioBytes = 0;
  }

  snapshot() {
    return {
      attemptId: this.id,
      activeChunks: this.encodedChunks.length + this.pcmChunks.length,
      activeAudioBytes: this.activeAudioBytes,
      activeMetricSamples: this.metricSamples.length,
      audioByteLimit: this.audioByteLimit,
    };
  }
}

// Object URLs have explicit consumers. Playback releases synchronously on stop/end/error;
// downloads release after the click task has handed the URL to the browser.
export class RecordingObjectUrlPool {
  constructor({
    createObjectURL = (blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    this._create = createObjectURL;
    this._revoke = revokeObjectURL;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._owners = new Map();
    this._timers = new Map();
  }

  create(blob, owner) {
    const url = this._create(blob);
    this._owners.set(url, owner);
    return url;
  }

  release(url) {
    if (!url || !this._owners.has(url)) return false;
    const timer = this._timers.get(url);
    if (timer != null) this._clearTimer(timer);
    this._timers.delete(url);
    this._owners.delete(url);
    this._revoke(url);
    return true;
  }

  releaseAfter(url, delayMs) {
    if (!this._owners.has(url)) return;
    const oldTimer = this._timers.get(url);
    if (oldTimer != null) this._clearTimer(oldTimer);
    this._timers.set(url, this._setTimer(() => this.release(url), delayMs));
  }

  releaseAll() {
    for (const url of [...this._owners.keys()]) this.release(url);
  }

  snapshot() {
    return { activeObjectUrls: this._owners.size, objectUrlTimers: this._timers.size };
  }
}
