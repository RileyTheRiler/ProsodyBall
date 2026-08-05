import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpeechGate,
  computeSpeechLikelihood,
  spectralFlatnessDb,
  bandEnergyDb,
  SPEECH_GATE_DEFAULTS,
} from './speech-gate.js';

// ── Synthetic spectra ─────────────────────────────────────────────────────
// dB magnitude spectra shaped like the things the mic actually picks up. The
// numbers are not calibrated to any real recording; they only need the gross
// spectral shape that distinguishes each source, which is what the gate reads.

const BIN_HZ = 44100 / 4096;   // ~10.77 Hz, matching the app's analyser
const BINS = 2048;
const FLOOR = -100;

const emptySpectrum = () => new Float32Array(BINS).fill(FLOOR);

/** Deterministic jitter so "noise" isn't suspiciously perfect. */
function pseudoRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function addPeak(spec, hz, db, widthHz = 25) {
  const centre = hz / BIN_HZ;
  const halfWidth = Math.max(1, widthHz / BIN_HZ);
  const lo = Math.max(0, Math.floor(centre - halfWidth));
  const hi = Math.min(BINS - 1, Math.ceil(centre + halfWidth));
  for (let i = lo; i <= hi; i++) {
    const falloff = Math.abs(i - centre) / halfWidth;
    const value = db - falloff * 20;
    if (value > spec[i]) spec[i] = value;
  }
}

/** Voiced vowel: harmonic stack at F0 shaped by three formants. */
function vowelSpectrum({ f0 = 200, formants = [700, 1800, 2600] } = {}) {
  const spec = emptySpectrum();
  for (let hz = f0; hz <= 4000; hz += f0) {
    // Amplitude follows proximity to the nearest formant, plus a source tilt.
    const nearest = Math.min(...formants.map((f) => Math.abs(hz - f)));
    const formantBoost = Math.max(0, 25 - nearest / 40);
    const sourceTilt = -12 * Math.log10(hz / f0);
    addPeak(spec, hz, -45 + formantBoost + sourceTilt);
  }
  return spec;
}

/** Broadband hiss: fan, rain, traffic, room tone, applause. */
function hissSpectrum({ db = -45, jitter = 3 } = {}) {
  const spec = emptySpectrum();
  const rand = pseudoRandom(7);
  for (let i = 1; i < BINS; i++) spec[i] = db + (rand() - 0.5) * jitter;
  return spec;
}

/** Tonal hum: fridge, transformer, fan blade tone. Tonal, plausible F0, no F2. */
function humSpectrum({ f0 = 120, harmonics = 3 } = {}) {
  const spec = emptySpectrum();
  for (let n = 1; n <= harmonics; n++) addPeak(spec, f0 * n, -25 - (n - 1) * 12);
  return spec;
}

/** Sub-band rumble: HVAC, traffic, handling thumps, wind on the mic. */
function rumbleSpectrum() {
  const spec = emptySpectrum();
  for (let hz = 10; hz <= 70; hz += 10) addPeak(spec, hz, -20);
  return spec;
}

/** Sum two spectra in the linear domain, as two sources at a mic would add. */
function mixSpectra(a, b) {
  const out = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    out[i] = 20 * Math.log10(Math.pow(10, a[i] / 20) + Math.pow(10, b[i] / 20));
  }
  return out;
}

const speechFrame = (extra = {}) => ({
  magnitudesDb: vowelSpectrum(),
  binHz: BIN_HZ,
  pitchHz: 200,
  harmonicity: 0.85,
  ...extra,
});

// ── spectralFlatnessDb ────────────────────────────────────────────────────

test('flatness is 1 for a perfectly flat spectrum and low for a peaky one', () => {
  const flat = new Float32Array(256).fill(-40);
  assert.ok(spectralFlatnessDb(flat, 0, 256) > 0.99, 'white noise is maximally flat');

  const peaky = new Float32Array(256).fill(-100);
  peaky[10] = 0;
  peaky[40] = -5;
  assert.ok(spectralFlatnessDb(peaky, 0, 256) < 0.1, 'a couple of tones are not flat');
});

test('flatness clamps empty bins instead of letting one collapse the result', () => {
  // The analysis path writes -200 dB into fully subtracted bins. Ungated, a
  // single such bin drives the geometric mean to ~0 and would make broadband
  // noise read as perfectly tonal — the exact opposite of the truth.
  const noise = new Float32Array(256).fill(-40);
  noise[77] = -200;
  assert.ok(spectralFlatnessDb(noise, 0, 256) > 0.85,
    'still recognisably noise despite the dead bin');
});

test('flatness handles degenerate ranges without throwing', () => {
  const spec = new Float32Array(64).fill(-40);
  assert.equal(spectralFlatnessDb(spec, 10, 10), 0, 'empty range');
  assert.equal(spectralFlatnessDb(spec, 50, 10), 0, 'inverted range');
  assert.ok(spectralFlatnessDb(spec, -5, 9999) > 0.99, 'out-of-bounds range is clipped');
});

test('bandEnergyDb sums only the requested band', () => {
  const spec = new Float32Array(128).fill(-200);
  spec[10] = 0;
  const inBand = bandEnergyDb(spec, 5, 20);
  const outOfBand = bandEnergyDb(spec, 30, 60);
  assert.ok(inBand > 0.9, 'a 0 dB bin contributes unit energy');
  assert.ok(outOfBand < 1e-9, 'nothing outside the band');
});

// ── Discrimination ────────────────────────────────────────────────────────

test('a voiced vowel scores as speech', () => {
  const { likelihood } = computeSpeechLikelihood(speechFrame());
  assert.ok(likelihood >= SPEECH_GATE_DEFAULTS.enterThreshold,
    `expected a vowel to clear the enter threshold, got ${likelihood.toFixed(3)}`);
});

test('broadband hiss is rejected', () => {
  // Flat spectrum, no harmonic structure — a fan or open room.
  const { likelihood, flatness } = computeSpeechLikelihood({
    magnitudesDb: hissSpectrum(), binHz: BIN_HZ, pitchHz: 0, harmonicity: 0.1,
  });
  assert.ok(flatness > 0.7, 'hiss is spectrally flat');
  assert.ok(likelihood < SPEECH_GATE_DEFAULTS.enterThreshold,
    `hiss should not open the gate, got ${likelihood.toFixed(3)}`);
});

test('KNOWN GAP: a steady tonal hum still reads as speech', () => {
  // Documented limitation, asserted so it stays visible rather than lurking.
  //
  // A hum is tonal, sits in the voice band and carries a plausible F0, so every
  // spectral feature here endorses it. An earlier version rejected it by
  // demanding energy above 1 kHz — that rule also threw out 13% of genuinely
  // voiced frames in the real rainbow-passage fixture, because a low-pitched
  // voice often has nothing measurable up there either. The two overlap on that
  // feature, so it cannot separate them.
  //
  // Separating them needs temporal evidence (a mechanical tone is steadier than
  // any larynx) over seconds. If that ever lands, this test should flip to
  // asserting rejection.
  const features = computeSpeechLikelihood({
    magnitudesDb: humSpectrum(), binHz: BIN_HZ, pitchHz: 120, harmonicity: 0.9,
  });
  assert.ok(features.flatness < 0.4, 'a hum really is tonal — which is why it fools the gate');
  assert.ok(features.upperPresence < 0.01, 'and has nothing above 1 kHz');
  assert.ok(features.likelihood >= SPEECH_GATE_DEFAULTS.enterThreshold,
    'currently passes; see the module header for why this is not patched over');
});

test('the features that DO separate noise are unaffected by that gap', () => {
  // Guard against a future anti-hum change quietly weakening the cases the gate
  // is actually relied on for.
  const hiss = computeSpeechLikelihood({
    magnitudesDb: hissSpectrum(), binHz: BIN_HZ, pitchHz: 0, harmonicity: 0.1,
  });
  const rumble = computeSpeechLikelihood({
    magnitudesDb: rumbleSpectrum(), binHz: BIN_HZ, pitchHz: 0, harmonicity: 0.2,
  });
  const voice = computeSpeechLikelihood(speechFrame());

  assert.ok(voice.likelihood > hiss.likelihood + 0.4, 'voice clears hiss by a wide margin');
  assert.ok(voice.likelihood > rumble.likelihood + 0.4, 'voice clears rumble by a wide margin');
});

test('low rumble is rejected on band ratio', () => {
  const features = computeSpeechLikelihood({
    magnitudesDb: rumbleSpectrum(), binHz: BIN_HZ, pitchHz: 0, harmonicity: 0.2,
  });
  assert.ok(features.voiceBandRatio < 0.35, 'rumble sits below the voice band');
  assert.ok(features.likelihood < SPEECH_GATE_DEFAULTS.enterThreshold);
});

test('silence scores zero rather than erroring', () => {
  const { likelihood } = computeSpeechLikelihood({
    magnitudesDb: emptySpectrum(), binHz: BIN_HZ, pitchHz: 0, harmonicity: 0,
  });
  assert.ok(likelihood < SPEECH_GATE_DEFAULTS.exitThreshold);
});

test('missing or malformed input is scored 0, not NaN', () => {
  for (const frame of [{}, { magnitudesDb: null, binHz: 10 },
    { magnitudesDb: new Float32Array(0), binHz: 10 },
    { magnitudesDb: emptySpectrum(), binHz: 0 }]) {
    const { likelihood } = computeSpeechLikelihood(frame);
    assert.ok(Number.isFinite(likelihood), 'likelihood stays finite');
    assert.equal(likelihood, 0);
  }
});

// ── The sustained-vowel constraint ────────────────────────────────────────

test('a sustained vowel is NOT rejected for lacking syllable-rate modulation', () => {
  // The textbook speech detector keys on 2-8 Hz amplitude modulation, which a
  // held vowel does not have. This app's calibration and resonance practice are
  // built on held vowels, so an unchanging frame must keep scoring as speech
  // for as long as it is held.
  const gate = new SpeechGate();
  let open = false;
  for (let i = 0; i < 200; i++) open = gate.update(speechFrame()).isSpeech;
  assert.equal(open, true, 'still open after ~200 identical frames');
});

test('a very low-pitched voice still passes', () => {
  const frame = {
    magnitudesDb: vowelSpectrum({ f0: 85, formants: [600, 1500, 2500] }),
    binHz: BIN_HZ, pitchHz: 85, harmonicity: 0.8,
  };
  assert.ok(computeSpeechLikelihood(frame).likelihood >= SPEECH_GATE_DEFAULTS.enterThreshold);
});

test('a high-pitched voice still passes', () => {
  const frame = {
    magnitudesDb: vowelSpectrum({ f0: 260, formants: [800, 2100, 2900] }),
    binHz: BIN_HZ, pitchHz: 260, harmonicity: 0.8,
  };
  assert.ok(computeSpeechLikelihood(frame).likelihood >= SPEECH_GATE_DEFAULTS.enterThreshold);
});

test('an implausible F0 costs evidence but absent F0 does not', () => {
  const base = { magnitudesDb: vowelSpectrum(), binHz: BIN_HZ, harmonicity: 0.85 };
  const good = computeSpeechLikelihood({ ...base, pitchHz: 200 });
  const absent = computeSpeechLikelihood({ ...base, pitchHz: 0 });
  const silly = computeSpeechLikelihood({ ...base, pitchHz: 1200 });

  assert.ok(absent.likelihood < good.likelihood, 'no pitch is weaker evidence');
  assert.ok(silly.likelihood < absent.likelihood,
    'an impossible F0 is worse than none — unvoiced consonants have no F0 and are still speech');
});

// ── Gate dynamics ─────────────────────────────────────────────────────────

test('the gate needs consecutive frames to open, rejecting one-frame transients', () => {
  const gate = new SpeechGate({ attackFrames: 2 });
  const noise = { magnitudesDb: hissSpectrum(), binHz: BIN_HZ, pitchHz: 0, harmonicity: 0.1 };

  // A key click: one speech-ish frame surrounded by noise.
  assert.equal(gate.update(noise).isSpeech, false);
  assert.equal(gate.update(speechFrame()).isSpeech, false, 'one frame is not enough');
  assert.equal(gate.update(noise).isSpeech, false);
  assert.equal(gate.update(noise).isSpeech, false);
});

test('two qualifying frames open it', () => {
  const gate = new SpeechGate({ attackFrames: 2 });
  assert.equal(gate.update(speechFrame()).isSpeech, false);
  assert.equal(gate.update(speechFrame()).isSpeech, true);
});

test('hangover holds the gate open through a word-final consonant', () => {
  const gate = new SpeechGate({ attackFrames: 2, hangoverFrames: 8 });
  gate.update(speechFrame());
  gate.update(speechFrame());
  assert.equal(gate.isOpen, true);

  // Voicing stops; the tail of the word is quiet and unvoiced.
  const silence = { magnitudesDb: emptySpectrum(), binHz: BIN_HZ, pitchHz: 0, harmonicity: 0 };
  for (let i = 0; i < 8; i++) {
    assert.equal(gate.update(silence).isSpeech, true, `still open during hangover frame ${i}`);
  }
  assert.equal(gate.update(silence).isSpeech, false, 'closes once the hangover is spent');
});

test('hysteresis keeps a marginal frame from chattering the gate', () => {
  // A real marginal case: a voice in a room noisy enough to half-bury it, which
  // scores between the two thresholds.
  const marginal = {
    magnitudesDb: mixSpectra(vowelSpectrum(), hissSpectrum({ db: -50 })),
    binHz: BIN_HZ, pitchHz: 200, harmonicity: 0.8,
  };
  const score = computeSpeechLikelihood(marginal).likelihood;
  assert.ok(score >= SPEECH_GATE_DEFAULTS.exitThreshold && score < SPEECH_GATE_DEFAULTS.enterThreshold,
    `fixture must sit between the thresholds, got ${score.toFixed(3)}`);

  const gate = new SpeechGate({ attackFrames: 1, hangoverFrames: 0 });
  assert.equal(gate.update(marginal).isSpeech, false, 'too weak to open from closed');
  gate.update(speechFrame());
  assert.equal(gate.isOpen, true);
  assert.equal(gate.update(marginal).isSpeech, true, 'but strong enough to hold open');
});

test('speech over ordinary room noise still opens the gate', () => {
  // The failure that would matter most to a user is the gate refusing to open
  // on their actual voice. Room tone well below the voice does not do that.
  for (const noiseDb of [-90, -70, -60, -55]) {
    const frame = {
      magnitudesDb: mixSpectra(vowelSpectrum(), hissSpectrum({ db: noiseDb })),
      binHz: BIN_HZ, pitchHz: 200, harmonicity: 0.8,
    };
    const { likelihood } = computeSpeechLikelihood(frame);
    assert.ok(likelihood >= SPEECH_GATE_DEFAULTS.enterThreshold,
      `speech over ${noiseDb} dB room noise should open the gate, got ${likelihood.toFixed(3)}`);
  }
});

test('once open, the gate rides out noise loud enough to bury the voice', () => {
  // Past roughly -50 dB room noise the instantaneous score falls under the enter
  // threshold. Hysteresis plus hangover mean an utterance already in progress
  // keeps being measured rather than cutting out mid-word.
  const gate = new SpeechGate();
  gate.update(speechFrame());
  gate.update(speechFrame());
  assert.equal(gate.isOpen, true);

  const buried = {
    magnitudesDb: mixSpectra(vowelSpectrum(), hissSpectrum({ db: -50 })),
    binHz: BIN_HZ, pitchHz: 200, harmonicity: 0.8,
  };
  for (let i = 0; i < 50; i++) gate.update(buried);
  assert.equal(gate.isOpen, true, 'stays open on a buried but present voice');
});

test('reset() returns the gate to closed', () => {
  const gate = new SpeechGate({ attackFrames: 1 });
  gate.update(speechFrame());
  assert.equal(gate.isOpen, true);
  gate.reset();
  assert.equal(gate.isOpen, false);
  assert.equal(gate.likelihood, 0);
});

test('a full utterance opens once and closes once', () => {
  const gate = new SpeechGate();
  const noise = { magnitudesDb: hissSpectrum(), binHz: BIN_HZ, pitchHz: 0, harmonicity: 0.1 };
  const silence = { magnitudesDb: emptySpectrum(), binHz: BIN_HZ, pitchHz: 0, harmonicity: 0 };

  let transitions = 0;
  let prev = false;
  const run = (frame, n) => {
    for (let i = 0; i < n; i++) {
      const { isSpeech } = gate.update(frame);
      if (isSpeech !== prev) { transitions++; prev = isSpeech; }
    }
  };

  run(noise, 30);       // room tone before speaking
  run(speechFrame(), 60); // an utterance
  run(silence, 30);     // pause after
  assert.equal(transitions, 2, 'exactly one open and one close, no chatter');
});
