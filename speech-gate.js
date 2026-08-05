/**
 * Optional speech-only gate — reject frames that are not a human voice.
 *
 * What the existing gate already does, and why it isn't enough
 * -----------------------------------------------------------
 * `computeFrameReliability` (dsp-utils) gates on energy, pitch/formant/tilt
 * confidence and SNR. That handles *quiet* and *muddy*, which is a different
 * problem from *not speech*. A loud fan, a fridge hum, keyboard clatter and
 * road noise all clear an energy gate comfortably, and some of them clear the
 * pitch gate too — YIN will happily lock onto the blade-pass tone of a fan and
 * report it with high confidence. Those frames then get measured as if they
 * were voice, dragging the pitch profile and the resonance estimate with them.
 *
 * The design constraint that shapes everything here
 * -------------------------------------------------
 * This app treats sustained vowels as first-class (held-vowel calibration,
 * `sustainedThreshold`, the resonance profile). The textbook speech/non-speech
 * discriminator is 2-8 Hz syllable-rate amplitude modulation — and a sustained
 * vowel has almost none of it. So modulation cannot be a requirement here. Any
 * feature that punishes a steady signal would punish exactly the exercise the
 * app is built around.
 *
 * What separates voice from the noises that actually get through
 * -------------------------------------------------------------
 *  - Broadband noise (hiss, fan, rain, traffic, applause) has a near-flat
 *    spectrum. Voiced speech is peaky — harmonics and formants. Spectral
 *    flatness separates these cleanly and does not care whether the voice is
 *    sustained or moving.
 *  - Low rumble (HVAC, handling thumps, traffic) lives below the voice band.
 *    An energy-in-band ratio drops it.
 *  - Transients (key clicks, cutlery, door bumps) are broadband and brief, so
 *    flatness plus the attack count in `SpeechGate` handles them.
 *
 * What this gate does NOT catch, and why
 * --------------------------------------
 * Steady tonal hum — a fridge compressor, a transformer, a fan's blade tone.
 * It is tonal, so flatness endorses it; it sits in the voice band; and it has a
 * plausible F0, so the pitch estimator endorses it too.
 *
 * An earlier version of this file rejected hum by requiring energy above 1 kHz,
 * on the reasoning that every vowel has F2 up there. Measured against the real
 * rainbow-passage fixture that turned out to be false: a low-pitched voice
 * (~104 Hz F0) frequently puts *nothing* measurable above 1 kHz once the source
 * tilt and spectral subtraction have had their way, and the rule threw out 13%
 * of genuinely voiced frames. Real speech and a hum overlap on that feature, so
 * it cannot separate them, and a rule that silences a user's actual voice is far
 * worse than one that lets a fridge through.
 *
 * Separating hum from a held vowel honestly needs temporal evidence — a
 * mechanical tone is stable in a way no human larynx is — measured over seconds
 * rather than frames. That is a bigger change and, without a real hum recording
 * to validate against, would risk repeating exactly the mistake above. It is
 * left undone rather than guessed at.
 *
 * Nothing here is a classifier. It is a weighted evidence score with hysteresis,
 * tuned to be conservative: when in doubt it opens, because clipping the start
 * of a word is worse than measuring a little noise.
 */

export const SPEECH_GATE_DEFAULTS = {
  // Band edges.
  voiceBandLoHz: 80,      // below this is rumble, not voice
  voiceBandHiHz: 4000,    // above this is mostly sibilance/hiss
  upperBandLoHz: 1000,    // F2/F3 territory — the vowel-vs-hum discriminator

  // Plausible human F0. Generous on both ends: low male modal down to 60,
  // high female/child head voice up to 400.
  f0MinHz: 60,
  f0MaxHz: 400,

  // Spectral flatness (Wiener entropy). Voiced speech sits well under 0.45;
  // broadband noise approaches 1.
  flatnessTonalMax: 0.45,
  flatnessNoiseMin: 0.75,

  // Fraction of total energy inside the voice band.
  voiceBandMin: 0.35,
  voiceBandGood: 0.70,

  // Evidence weights. Sum to 1. Harmonicity carries the most because it is the
  // one feature measured by a dedicated estimator (YIN) rather than inferred
  // from gross spectral shape.
  weightHarmonicity: 0.45,
  weightTonality: 0.30,
  weightBandRatio: 0.15,
  weightF0: 0.10,

  // Hysteresis. Opening is stricter than staying open so the gate doesn't
  // chatter on and off through a quiet consonant.
  enterThreshold: 0.55,
  exitThreshold: 0.38,

  // Consecutive qualifying frames before opening — rejects single-frame
  // transients (key clicks, cutlery) that would otherwise flash through.
  attackFrames: 2,

  // Frames to hold the gate open after evidence drops. Word-final consonants
  // and breathy tails are quiet and unvoiced; cutting them at the instant the
  // score dips would chop the end off every utterance.
  hangoverFrames: 8,

  // Bins below this are treated as empty rather than as -Infinity. The analysis
  // path writes -200 dB into fully subtracted bins, and a single such bin would
  // otherwise drag the geometric mean to zero and make noise look tonal.
  floorDb: -120,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Ramp 0→1 across [lo, hi]; flat outside. Returns 0 when the span is empty. */
function ramp(value, lo, hi) {
  if (!(hi > lo)) return value >= hi ? 1 : 0;
  return clamp01((value - lo) / (hi - lo));
}

/** Inverse ramp: 1 below lo, 0 above hi. */
function rampDown(value, lo, hi) {
  return 1 - ramp(value, lo, hi);
}

const binOf = (hz, binHz) => Math.max(0, Math.round(hz / binHz));

/**
 * Spectral flatness (geometric mean / arithmetic mean) over a bin range, taken
 * directly from a dB spectrum.
 *
 * Working in dB is not a shortcut around the maths, it is the same quantity:
 * the geometric mean of magnitudes is 10^(mean(dB)/20), so the whole statistic
 * comes out of one pass with no linear scratch array.
 *
 * Returns 0..1 — near 0 tonal/harmonic, near 1 white-noise-like — or 0 for an
 * empty range.
 */
export function spectralFlatnessDb(magnitudesDb, loBin, hiBin, floorDb = SPEECH_GATE_DEFAULTS.floorDb) {
  const lo = Math.max(0, Math.min(loBin, magnitudesDb.length));
  const hi = Math.max(lo, Math.min(hiBin, magnitudesDb.length));
  const n = hi - lo;
  if (n <= 0) return 0;

  let sumDb = 0;
  let sumLinear = 0;
  for (let i = lo; i < hi; i++) {
    const db = Math.max(floorDb, magnitudesDb[i]);
    sumDb += db;
    sumLinear += Math.pow(10, db / 20);
  }

  const arithmetic = sumLinear / n;
  if (arithmetic <= 0) return 0;
  const geometric = Math.pow(10, (sumDb / n) / 20);
  return clamp01(geometric / arithmetic);
}

/** Summed linear energy over a bin range of a dB spectrum. */
export function bandEnergyDb(magnitudesDb, loBin, hiBin, floorDb = SPEECH_GATE_DEFAULTS.floorDb) {
  const lo = Math.max(0, Math.min(loBin, magnitudesDb.length));
  const hi = Math.max(lo, Math.min(hiBin, magnitudesDb.length));
  let sum = 0;
  for (let i = lo; i < hi; i++) {
    const mag = Math.pow(10, Math.max(floorDb, magnitudesDb[i]) / 20);
    sum += mag * mag;
  }
  return sum;
}

/**
 * Score one frame's spectrum and pitch evidence as speech-like, 0..1.
 *
 * `harmonicity` is the caller's existing pitch confidence — this module does
 * not re-run pitch detection, it reuses what the analyser already computed.
 */
export function computeSpeechLikelihood({
  magnitudesDb,
  binHz,
  pitchHz = 0,
  harmonicity = 0,
} = {}, options = {}) {
  const o = { ...SPEECH_GATE_DEFAULTS, ...options };

  if (!magnitudesDb || !magnitudesDb.length || !(binHz > 0)) {
    return { likelihood: 0, flatness: 1, voiceBandRatio: 0, upperPresence: 0, f0Score: 0 };
  }

  const loBin = binOf(o.voiceBandLoHz, binHz);
  const hiBin = binOf(o.voiceBandHiHz, binHz);
  const upperBin = binOf(o.upperBandLoHz, binHz);

  const flatness = spectralFlatnessDb(magnitudesDb, loBin, hiBin, o.floorDb);
  const voiceEnergy = bandEnergyDb(magnitudesDb, loBin, hiBin, o.floorDb);
  const totalEnergy = bandEnergyDb(magnitudesDb, 0, magnitudesDb.length, o.floorDb);
  const upperEnergy = bandEnergyDb(magnitudesDb, upperBin, hiBin, o.floorDb);

  const voiceBandRatio = totalEnergy > 0 ? clamp01(voiceEnergy / totalEnergy) : 0;
  const upperPresence = voiceEnergy > 0 ? clamp01(upperEnergy / voiceEnergy) : 0;

  // Plausible-F0 evidence. A missing pitch is not disqualifying — unvoiced
  // consonants have no F0 and are still speech — so absence scores neutral
  // rather than zero.
  const f0Score = pitchHz > 0
    ? (pitchHz >= o.f0MinHz && pitchHz <= o.f0MaxHz ? 1 : 0)
    : 0.5;

  const tonality = rampDown(flatness, o.flatnessTonalMax, o.flatnessNoiseMin);
  const bandScore = ramp(voiceBandRatio, o.voiceBandMin, o.voiceBandGood);

  const likelihood =
    clamp01(harmonicity) * o.weightHarmonicity +
    tonality * o.weightTonality +
    bandScore * o.weightBandRatio +
    f0Score * o.weightF0;

  return {
    likelihood: clamp01(likelihood),
    flatness,
    voiceBandRatio,
    upperPresence,
    f0Score,
  };
}

/**
 * Stateful gate with hysteresis, an attack count and a hangover tail.
 *
 * Frame-by-frame thresholding alone produces a gate that stutters mid-word and
 * amputates word endings. The three pieces of state here exist to stop that:
 * `attackFrames` before opening, a lower bar to stay open than to open, and
 * `hangoverFrames` of grace before closing.
 */
export class SpeechGate {
  constructor(options = {}) {
    this.options = { ...SPEECH_GATE_DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.isOpen = false;
    this.likelihood = 0;
    this._qualifyingFrames = 0;
    this._hangover = 0;
  }

  /**
   * Advance one frame. Returns { isSpeech, likelihood, features }.
   *
   * `isSpeech` is the gate decision (with hysteresis applied); `likelihood` is
   * the raw instantaneous score, useful for a meter or for debugging.
   */
  update(frame) {
    const o = this.options;
    const features = computeSpeechLikelihood(frame, o);
    const likelihood = features.likelihood;
    this.likelihood = likelihood;

    if (this.isOpen) {
      if (likelihood >= o.exitThreshold) {
        this._hangover = o.hangoverFrames;
      } else if (this._hangover > 0) {
        this._hangover -= 1;
      } else {
        this.isOpen = false;
        this._qualifyingFrames = 0;
      }
    } else {
      if (likelihood >= o.enterThreshold) {
        this._qualifyingFrames += 1;
        if (this._qualifyingFrames >= o.attackFrames) {
          this.isOpen = true;
          this._hangover = o.hangoverFrames;
        }
      } else {
        this._qualifyingFrames = 0;
      }
    }

    return { isSpeech: this.isOpen, likelihood, features };
  }
}
