/**
 * Delayed Auditory Feedback (DAF) — native Web Audio delay line.
 *
 * Graph:  source → input → DelayNode → highpass → limiter → gain → destination
 *
 * Why a DelayNode and not a JS buffer loop
 * ----------------------------------------
 * The original implementation polled an AnalyserNode on a `setInterval` and
 * re-scheduled each 512-sample window as its own AudioBufferSourceNode. That
 * crackled by construction, for three independent reasons:
 *
 *  1. `getFloatTimeDomainData()` returns the most recent `fftSize` samples *at
 *     the moment of the call*. `setInterval` has no sample-accurate timing, so
 *     consecutive reads overlapped (repeating audio) or skipped (dropping it).
 *     Every seam was a step discontinuity in the waveform — an audible click,
 *     ~90 times a second at 512 samples / 48 kHz.
 *  2. The poll period was `Math.round(1000 * 512 / 48000)` = 11 ms, but a
 *     512-sample chunk only holds 10.67 ms of audio. The loop consumed audio
 *     ~3% slower than it arrived, so it shed samples regardless of timer jitter.
 *  3. Playback time advanced by exact chunk duration while chunks arrived on
 *     the slower wall clock, so the scheduler ran dry, tripped the
 *     `nextPlayTime < currentTime` guard, and hard-reset — a gap plus a phase
 *     jump, continuously.
 *
 * It also mixed two unrelated clocks (`performance.now()` for capture,
 * `audioCtx.currentTime` for playback), which drift apart over a session.
 *
 * A DelayNode has none of these failure modes: it is sample-continuous by
 * definition, runs on the audio rendering thread, and cannot be starved by
 * main-thread jank (GC pauses, layout, the render loop).
 */

export const DAF_MAX_DELAY_SEC = 0.5;      // DelayNode capacity; UI tops out at 200 ms, headroom to spare
export const DAF_OUTPUT_GAIN = 0.9;        // Playback level of the delayed voice
export const DAF_FADE_SEC = 0.02;          // Gain fade in/out so enable/disable doesn't click
export const DAF_DELAY_GLIDE_SEC = 0.08;   // Glide when the delay slider moves (brief pitch bend, not a click)
export const DAF_FILTER_ON_HZ = 150;       // Highpass corner when "cut bass" is on
export const DAF_FILTER_OFF_HZ = 20;       // Transparent for voice, still blocks DC/rumble that would eat headroom
export const DAF_FILTER_GLIDE_SEC = 0.03;  // Glide when toggling the bass cut

// A soft limiter sits before the output gain. autoGainControl defaults off in
// this app, so a hot mic plus 0.9 playback gain can drive the destination past
// full scale — and that hard clip is itself heard as crackle, entirely
// separately from any buffering problem.
export const DAF_LIMIT_THRESHOLD_DB = -6;
export const DAF_LIMIT_KNEE_DB = 4;
export const DAF_LIMIT_RATIO = 12;
export const DAF_LIMIT_ATTACK_SEC = 0.003;
export const DAF_LIMIT_RELEASE_SEC = 0.12;

// ── Effective delay accounting ────────────────────────────────────────────
//
// The delay the user *hears* is not the number on the slider. It is:
//
//     slider delay  +  output path latency  +  input path latency
//
// On a wired sink the last two are a few milliseconds and the slider is a good
// approximation. Over Bluetooth the output path alone is 100-250 ms, because
// A2DP buffers heavily to survive a lossy radio link — that buffering is the
// codec's whole reason for existing and no amount of app-side work removes it.
// So a 75 ms slider setting over Bluetooth is really ~250 ms in the ear, past
// the window where DAF does anything useful.
//
// Web Audio exposes the output half of that via `AudioContext.outputLatency`,
// which reports the real sink latency including the device's own buffers. The
// input half has no equivalent API, so the totals below are a floor, not an
// exact figure.

/** Output latency at or above this is a wireless sink; wired is single digits. */
export const DAF_WIRELESS_LATENCY_MS = 40;

/** The band where delayed feedback actually changes speech timing. */
export const DAF_EFFECTIVE_MIN_MS = 50;
export const DAF_EFFECTIVE_MAX_MS = 200;

/**
 * Measured output latency in ms, or null when the browser will not report it.
 *
 * Deliberately does NOT fall back to `baseLatency`: that covers only the audio
 * graph's internal buffering (~10 ms) and is blind to the sink, so reporting it
 * for a Bluetooth device would confidently state ~10 ms when the truth is 200.
 * Null means "unknown", which the UI can say honestly.
 */
export function outputLatencyMs(audioCtx) {
  const secs = audioCtx?.outputLatency;
  if (typeof secs !== 'number' || !Number.isFinite(secs) || secs < 0) return null;
  return Math.round(secs * 1000);
}

/**
 * Describe the delay actually reaching the ear, given the slider setting and a
 * measured output latency (null when unmeasurable).
 *
 * Returns { total, wireless, status, text } where status is one of
 * 'unknown' | 'short' | 'good' | 'long'.
 */
export function describeEffectiveDelay(delayMs, measuredOutputMs) {
  const set = Math.max(0, Math.round(Number(delayMs) || 0));

  if (measuredOutputMs === null || measuredOutputMs === undefined) {
    return {
      total: null,
      wireless: false,
      status: 'unknown',
      text: `Set to ${set} ms. This browser won’t report output latency — on Bluetooth `
        + `the delay you hear can be 150-250 ms longer than this.`,
    };
  }

  const out = Math.max(0, Math.round(measuredOutputMs));
  const total = set + out;
  const wireless = out >= DAF_WIRELESS_LATENCY_MS;
  const path = wireless ? `${out} ms wireless output` : `${out} ms output`;

  if (total > DAF_EFFECTIVE_MAX_MS) {
    const headroom = DAF_EFFECTIVE_MAX_MS - out;
    const lead = `You hear about ${total} ms (${set} ms + ${path}).`;

    // The sink alone blows the window — no slider position helps.
    if (headroom <= 0) {
      return {
        total,
        wireless,
        status: 'long',
        text: `${lead} Your headphones alone add ${out} ms, so no delay setting gets under `
          + `${DAF_EFFECTIVE_MAX_MS} ms. Wired or USB-C headphones are the only fix.`,
      };
    }

    // Lowering the slider still lands in range — but if the sink is already
    // supplying a full DAF's worth on its own, say that too. "Drag to 16 ms" is
    // correct and useless-sounding without the reason behind it.
    const dominated = out >= DAF_EFFECTIVE_MIN_MS;
    return {
      total,
      wireless,
      status: 'long',
      text: dominated
        ? `${lead} Your headphones already supply the whole delay on their own — drag the `
          + `setting down to ${headroom} ms or less. Wired headphones would give you real `
          + `control over the amount.`
        : `${lead} Too long — drag the delay down to about ${headroom} ms or less.`,
    };
  }

  if (total < DAF_EFFECTIVE_MIN_MS) {
    return {
      total,
      wireless,
      status: 'short',
      text: `You hear about ${total} ms (${set} ms + ${path}) — too short to slow speech. `
        + `Raise the delay to about ${DAF_EFFECTIVE_MIN_MS - out} ms or more.`,
    };
  }

  return {
    total,
    wireless,
    status: 'good',
    text: `You hear about ${total} ms (${set} ms + ${path}) — in the useful range.`,
  };
}

/** setTargetAtTime reaches ~95% of target after 3 time constants. */
const timeConstant = (seconds) => seconds / 3;

export function clampDelaySeconds(delayMs) {
  const secs = (Number(delayMs) || 0) / 1000;
  if (!Number.isFinite(secs)) return 0;
  return Math.min(DAF_MAX_DELAY_SEC, Math.max(0, secs));
}

export class DafEngine {
  constructor({ delayMs = 75, bassFilter = false } = {}) {
    this.delayMs = delayMs;
    this.bassFilter = bassFilter;
    this.ctx = null;
    this.input = null;
    this.delay = null;
    this.filter = null;
    this.limiter = null;
    this.gain = null;
  }

  /** True while the delay line is live in the audio graph. */
  get active() {
    return !!this.delay;
  }

  /**
   * Build and connect the delay line. No-op if already running, or if the
   * caller has no context/source to tap.
   */
  start(audioCtx, sourceNode) {
    if (this.active || !audioCtx || !sourceNode) return false;

    const ctx = audioCtx;
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.input.gain.value = 1;

    this.delay = ctx.createDelay(DAF_MAX_DELAY_SEC);
    this.delay.delayTime.value = clampDelaySeconds(this.delayMs);

    // The filter is always in the chain so toggling the bass cut is a parameter
    // glide rather than a graph teardown (which would drop audio mid-utterance).
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'highpass';
    this.filter.frequency.value = this.bassFilter ? DAF_FILTER_ON_HZ : DAF_FILTER_OFF_HZ;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = DAF_LIMIT_THRESHOLD_DB;
    this.limiter.knee.value = DAF_LIMIT_KNEE_DB;
    this.limiter.ratio.value = DAF_LIMIT_RATIO;
    this.limiter.attack.value = DAF_LIMIT_ATTACK_SEC;
    this.limiter.release.value = DAF_LIMIT_RELEASE_SEC;

    this.gain = ctx.createGain();
    // Start silent and fade up — snapping to full gain is itself a click.
    this.gain.gain.value = 0;
    this.gain.gain.setTargetAtTime(DAF_OUTPUT_GAIN, ctx.currentTime, timeConstant(DAF_FADE_SEC));

    sourceNode.connect(this.input);
    this.input.connect(this.delay);
    this.delay.connect(this.filter);
    this.filter.connect(this.limiter);
    this.limiter.connect(this.gain);
    this.gain.connect(ctx.destination);
    return true;
  }

  /** Fade out, then disconnect. Safe to call when already stopped. */
  stop() {
    const ctx = this.ctx;
    const nodes = [this.input, this.delay, this.filter, this.limiter, this.gain];
    const gain = this.gain;
    this.input = null;
    this.delay = null;
    this.filter = null;
    this.limiter = null;
    this.gain = null;
    this.ctx = null;

    const teardown = () => {
      for (const n of nodes) {
        if (n) { try { n.disconnect(); } catch (e) { /* context already closed */ } }
      }
    };

    if (!ctx || ctx.state === 'closed' || !gain) {
      teardown();
      return;
    }
    try {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setTargetAtTime(0, ctx.currentTime, timeConstant(DAF_FADE_SEC));
    } catch (e) {
      teardown();
      return;
    }
    setTimeout(teardown, DAF_FADE_SEC * 1000 * 2);
  }

  /** Glide to a new delay time — a step change in delayTime clicks. */
  setDelayMs(delayMs) {
    this.delayMs = delayMs;
    if (!this.delay || !this.ctx) return;
    this.delay.delayTime.setTargetAtTime(
      clampDelaySeconds(delayMs), this.ctx.currentTime, timeConstant(DAF_DELAY_GLIDE_SEC));
  }

  /** Glide the highpass corner instead of rebuilding the graph. */
  setBassFilter(on) {
    this.bassFilter = !!on;
    if (!this.filter || !this.ctx) return;
    this.filter.frequency.setTargetAtTime(
      this.bassFilter ? DAF_FILTER_ON_HZ : DAF_FILTER_OFF_HZ,
      this.ctx.currentTime,
      timeConstant(DAF_FILTER_GLIDE_SEC));
  }
}
