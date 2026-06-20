// AudioWorkletProcessor: time-domain syllable-ONSET timing on the audio thread.
//
// This is the incremental "timing only" slice of the analysis pipeline. It keeps
// a sliding-window RMS over the most recent `windowSize` samples (matching the
// main-thread analyser window) and runs the SAME gated on/off hysteresis state
// machine the main thread used to run on the rAF loop. On each silent→voiced
// transition it posts `{type:'onset'}`; it also posts a lightweight `{type:'rms'}`
// heartbeat so the main thread can confirm the processor is actually running
// before it hands off onset detection (graceful fallback otherwise).
//
// All thresholds (noiseFloor + on/off levels) stay owned by the main thread and
// are pushed in via the port — this module is a pure timing engine with no FFT or
// spectral work. Everything else (energy metric, attack, pitch, formants) remains
// on the main thread, unchanged.

class OnsetProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = (options && options.processorOptions) || {};
    this.windowSize = opt.windowSize || 4096;
    this.ring = new Float32Array(this.windowSize);
    this.ringIdx = 0;
    this.sumSq = 0;
    this.blockCount = 0;

    // Detection thresholds — owned by the main thread, refreshed via the port.
    this.noiseFloor = typeof opt.noiseFloor === 'number' ? opt.noiseFloor : 0.015;
    this.onThreshold = typeof opt.onThreshold === 'number' ? opt.onThreshold : 0.02;
    this.offThreshold = typeof opt.offThreshold === 'number' ? opt.offThreshold : 0.01;

    this.state = 'silent';
    this.armed = false;            // only emit onsets once the main thread calibrates
    this._heartbeatDivider = 8;    // post an rms heartbeat every ~8 render quanta

    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (typeof d.noiseFloor === 'number') this.noiseFloor = d.noiseFloor;
      if (typeof d.onThreshold === 'number') this.onThreshold = d.onThreshold;
      if (typeof d.offThreshold === 'number') this.offThreshold = d.offThreshold;
      if (typeof d.armed === 'boolean') {
        // On (re)arming, start from silence so the next voiced run is a clean onset.
        if (d.armed && !this.armed) this.state = 'silent';
        this.armed = d.armed;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    const ws = this.windowSize;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      const old = this.ring[this.ringIdx];
      this.sumSq += s * s - old * old;
      this.ring[this.ringIdx] = s;
      this.ringIdx = this.ringIdx + 1 === ws ? 0 : this.ringIdx + 1;
    }

    // Periodically resync the running sum to bound floating-point drift.
    this.blockCount++;
    if (this.blockCount >= 512) {
      this.blockCount = 0;
      let acc = 0;
      for (let i = 0; i < ws; i++) acc += this.ring[i] * this.ring[i];
      this.sumSq = acc;
    }

    const rms = Math.sqrt(Math.max(0, this.sumSq) / ws);
    const gated = Math.max(0, rms - this.noiseFloor);

    if (this.armed) {
      if (gated > this.onThreshold && this.state === 'silent') {
        this.state = 'voiced';
        this.port.postMessage({ type: 'onset' });
      } else if (gated < this.offThreshold) {
        this.state = 'silent';
      }
    }

    // Heartbeat: lets the main thread confirm process() is live before it relies
    // on us for onsets, and carries the current gated level for debugging.
    if (this.blockCount % this._heartbeatDivider === 0) {
      this.port.postMessage({ type: 'rms', gated });
    }

    return true; // keep the processor alive
  }
}

registerProcessor('onset-processor', OnsetProcessor);
