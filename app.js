import { computeProsodyScore, computeRawProsody, pitchHzToPosition, getMicDiagnostics, ensureAudioContextRunning, clamp01, computeFrameReliability, normalizeAgainstPercentiles, normalizeAgainstRange, computeWeightTarget, computeAttackHardness, computeGenderScore, genderScoreToHue, computeSpectralCentroid, fitFormantDispersion, formantEstimateConfidence, computeCepstrum, computeCPP, computeGenderScoreMulti, computeModalF0Femininity, computeSibilantFemininity, dispersionToFemininity, cppToFemininity, correctOctaveError, aPosterioriSnrDb, snrToConfidence, snrTier, adaptiveOverSubtraction, NOISE_PROFILE_UPDATE_RATE, steadyStateWeight, selectResonanceMethod, FEMINIZATION_CUE_WEIGHTS, MASCULINIZATION_CUE_WEIGHTS, pitchHzToLogPosition, summarizeVoiceCloud, voiceMapZoneFromRules, fitPersonalRange, rangeFromExtremeSamples, summarizeClipMetrics, summarizePhraseTake, fitFormantScale, formantPatternResiduals, resonanceAbsoluteV2, poolFormantScale, resonanceScoreV1, classifyVowel, f2PositionFromResidual, normalizeResidualScale, VOWEL_TEMPLATE_FORMANTS, ResonanceAggregator, frameValidity, formantMeasurementNoise, crossEstimatorAgreement, resonanceConfidence, RESONANCE_CONFIDENCE_FLOOR, spectralBrightness, windowHomogeneity, rhoticFromRho, residualScaleFactor, selectLpcCeiling, LPC_DEFAULT_CEILING_HZ, LPC_CEILING_CANDIDATES_HZ, LPC_CEILING_MIN_FRAMES, FORMANT_NOISE_F0_REF_HZ } from './dsp-utils.js';
import {
  RESONANCE_METRIC_VERSION, RESONANCE_SCALE_ABSOLUTE, RESONANCE_SCALE_CONTROL,
  RESONANCE_POPULATION_SPAN, RESONANCE_PROFILE_KEY,
  resonanceControl, spanFromPostures, makeResonanceProfile, serializeResonanceProfile,
  parseResonanceProfile, spanIdFor, makeReading, aggregateReadings,
  migrateResonanceRules, ruleMayFire, confirmResonanceRule,
} from './resonance-metric.js';
import { SNR_VOICE_BAND_LO_HZ, SNR_VOICE_BAND_HI_HZ, YIN_THRESHOLD, PITCH_CONFIDENCE_FACTOR } from './dsp-constants.generated.js';
import { SpeechGate } from './speech-gate.js';
import { PRACTICE_PHRASES, scorePhraseTake, buildContourSeries, practiceTipForGoal } from './phrase-coach.js';
import { buildPhraseSpeechSummary } from './speech-feedback.js';
import { PerformanceMonitor } from './performance-monitor.js';
import { CalibrationWizard } from './calibration-wizard.js';
import { runCalibrationWithTimeout } from './calibration-runner.js';
import { BulbController } from './bulb-controller.js';
import { NecklaceController, HapticSrc } from './necklace-controller.js';
import {
  VIBRATION_METRIC_SPECS,
  VIBRATION_STORAGE_KEY,
  parseVibrationPreferences,
  serializeVibrationPreferences,
} from './vibration-preferences.js';
import { ModalFocusManager } from './ui-dialog-manager.js';
import { exportPortableSettings, importPortableSettings, resetPortableSettings } from './settings-transfer.js';
import { SessionWakeLock, registerPwa } from './pwa.js';
import {
  RECORDING_LIMITS,
  RecordingAttempt,
  RecordingObjectUrlPool,
  recordingCapacity,
  retainedAudioBytes,
  retainedMetricSamples,
} from './recording-lifecycle.js';
import {
  DafEngine,
  outputLatencyMs,
  describeEffectiveDelay,
  supportsOutputSelection,
  browserSupportsOutputSelection,
  diagnoseSilentOutput,
} from './daf-engine.js';

function escapeHtml(text) {
  if (!text) return text;
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Guided phrase practice curriculum + scoring now live in phrase-coach.js:
// each phrase declares what it trains (focus), the expected phrase-final
// contour, a coaching tip, and its leniently-graded function words.

// ============================================================
// DSP TUNING CONSTANTS
// Centralised so they're easy to find, tweak, and document.
// ============================================================
// YIN_THRESHOLD and PITCH_CONFIDENCE_FACTOR now come from dsp-constants.generated.js
// (single source of truth: dsp-constants.json) — imported above, not defined here.
const INTONATION_ST_DIVISOR = 6.0;        // Semitone std-dev mapped to [0,1] bounce (0–1 ST flat, 2–4 conversational, 4–6 expressive)
const TEMPO_TRANSITION_DIVISOR = 12;      // Energy crossings → [0,1] tempo
const VOWEL_ONSET_SECS = 0.15;           // Seconds of sustain before vowel metric starts rising (sustain/diagnostic mode)
const VOWEL_SATURATION_SECS = 0.6;       // Additional seconds to reach vowel = 1.0 (sustain/diagnostic mode)
const VOWEL_DECAY_RATE = 0.85;           // Per-frame decay multiplier when not vowel-like (sustain mode)
const VOWEL_CONNECTED_ONSET_SECS = 0.05; // Onset delay for connected-speech mode
const VOWEL_CONNECTED_SATURATION_SECS = 0.20; // Saturation time for connected-speech mode
const VOWEL_CONNECTED_DECAY_RATE = 0.92; // Per-frame decay for connected-speech mode
const VOWEL_SUSTAIN_MULT = 0.4;          // Energy percentile multiplier for vowel detection threshold
const ARTIC_SENSITIVITY_GAIN = 1.2;      // Gain applied to articulation normalisation
const MIN_NOISE_PROFILE_FRAMES = 8;      // Ambient frames needed before a per-bin noise profile is trusted
// Reported SNR is bounded before smoothing. Trust (snrToConfidence) and the over-subtraction
// factor both saturate at SNR_GREEN_DB, so readings past these edges carry no extra
// information — but an unbounded power ratio swings tens of dB per frame against near-digital
// silence (a hard noise gate, a clean recording's gaps), which makes the smoothed value, the
// tier, and the ball's vividness flap. Clamping keeps the tiers steady without touching the
// 10-20 dB region the ramp actually reads.
const SNR_DB_FLOOR = -10;
const SNR_DB_CEIL = 45;
const SYLLABLE_DEBOUNCE_SECS = 0.08;     // Minimum seconds between syllable onsets
const SYLLABLE_ON_MULT = 0.6;            // Energy range multiplier for syllable-on threshold
const SYLLABLE_OFF_MULT = 0.15;          // Energy range multiplier for syllable-off threshold
const SYLLABLE_IMPULSE_DECAY = 0.88;     // Per-frame decay of syllable impulse
// Estimator frames a formant may go unmeasured before it is dropped from the ΔF fit. Counted
// in frames where the estimator actually RAN (voiced + vowel-like), so ordinary silence never
// ages a formant out — only an estimator that keeps failing to find one does. ~12 frames is
// 0.2 s of continuous phonation at the rAF frame rate.
const FORMANT_STALE_FRAMES = 12;
// F4 admission bounds for the downsampled-LPC path (RESONANCE_REDESIGN.md §1.6). See the
// assignment loop in _resonanceLPC for why they are tighter than the F1-F3 bounds.
const F4_CEILING_HZ = 4800;
// F3 admission floor. 2000 Hz is v1's, unchanged; the canonical path uses the lower one so a
// rhotic F3 is reachable at all (P&B adult-male /ɝ/ F3 = 1690 Hz). 1500 Hz sits below every
// published adult F3 including the rhotic and above every published adult F2 except /i/ and
// /ɪ/, whose F2 is assigned before F3 is considered — so it widens the window for a rhotic
// without opening one for an F2.
const F3_FLOOR_HZ = 2000;
// Presentation ramps for the "no reading" state (§5 Phase 4). Both in SECONDS, integrated
// against the real frame interval. The fade-out is deliberately shorter than the shortest
// measured suppression run on the Rainbow Passage (3 frames = 100 ms at the live rate), so
// every real decline completes the transition; the fade-in is faster still, so a reading that
// comes back is not held behind an animation.
// A rule the user is creating or re-pointing RIGHT NOW is set against the metric that is
// running right now, so it carries the current version and no suspension. Only rules that came
// out of storage having been set against an older metric are suspended (§3.5) — which is why
// this is a separate function from the migrator and is never called on load.
function stampCurrentMetricVersion(rule, spanId = null) {
  if (rule && rule.metric === 'resonance') {
    rule.metricVersion = RESONANCE_METRIC_VERSION;
    rule.spanId = spanId;
    rule.suspended = false;
    delete rule.suspendedReason;
  }
  return rule;
}
const RESONANCE_FADE_OUT_SEC = 0.09;
const RESONANCE_FADE_IN_SEC = 0.06;
const F3_RHOTIC_FLOOR_HZ = 1500;
const F4_MAX_BW_HZ = 500;

// Rolling window the v2 formant scale is pooled over (RESONANCE_REDESIGN.md §5). 100 frames
// is ~1.7 s at the app's 60 fps update rate: several vowel nuclei of connected speech, so the
// shape excursion averages out, but short enough that a deliberate posture change still moves it.
const FORMANT_SCALE_POOL_FRAMES = 100;
// Per-estimator calibration onto the shared confidence scale (see formantEstimateConfidence).
// Calibrated so all four report a comparable median confidence on clean read speech, measured
// against fixtures/audio-eval/rainbow_passage.wav at the live frame rate; the parity is locked
// by resonance-reliability.test.mjs so this can't silently drift apart again. These express
// scale only — between-method PRECISION is expressed once, in RESONANCE_METHOD_TRUST below.
const FORMANT_CONF_GAIN = {
  harmonic: 1.0,   // reference: peak prominence over the harmonic envelope's dynamic range
  cepstral: 1.0,   // same prominence currency as harmonic
  lpc: 2.1,        // pole-bandwidth score runs low; replaces an ad-hoc inline ×2.5
  centroid: 3.0,   // spectral concentration runs lowest of the four
};
// Measurement precision per estimator, used ONLY as the Kalman measurement-noise scale. Kept
// separate from FORMANT_CONF_GAIN so "how sure am I this frame has formants" and "how precise
// is this estimator when it is sure" stay distinct quantities.
const RESONANCE_METHOD_TRUST = {
  lpc: 1.0,      // precise root-solved values -> low measurement noise
  harmonic: 0.7, // good but harmonic-resolution limited
  cepstral: 0.5, // smooth but broad
  centroid: 0.3, // conflates pitch
};
// ============================================================
// PHASE 3 — ESTIMATOR DISCIPLINE (docs/RESONANCE_REDESIGN.md §5)
// ============================================================
// How often the secondary estimators run as cross-checks. §3.4 is the whole reason this is a
// number greater than 1: "three LPC solves per frame at 60 fps on a phone, a watch and an
// ESP32 is not affordable". The cross-checks are cheap (both work off the FFT magnitudes the
// frame already computed — no root solve), but they are still not free, and they are answering
// a question that does not change frame to frame: "is the primary estimator describing the
// same spectrum the other methods see?" Every 6th frame is 10 Hz at the 60 fps update rate,
// which is faster than any real tracking failure develops.
//
// The two run on OPPOSITE frames rather than together, so the per-frame cost is one
// cross-check, not two.
// EXPRESSED IN SECONDS, NOT FRAMES, and that is not a stylistic choice. DSP_CONTRACT's
// frame-rate fidelity section records what happens otherwise: "every EMA rate, steady-state
// tolerance and profile-learning duration in the resonance stage is expressed per frame — so
// the harness was validating the pipeline at an operating point no user ever runs at." A
// cross-check cadence in frames has the same defect, and it showed up as a number: at the
// 735-sample hop the reporting tools use (33 ms on the 22.05 kHz fixture) the pooled cepstral/
// LPC ratio is 1.057 and 10% of clean frames are suppressed; at the rAF loop's true 60 fps the
// same audio gives 1.275 and 33%. Same recording, same estimators, different statistic —
// because a 16-reading pool covered 3.2 s at one rate and 1.6 s at the other.
const CROSS_CHECK_PERIOD_SEC = 0.1;
// Seconds of cross-check history each secondary pools. ~2 s, the same order as the scale's own
// pooling window, which is the point: the two statistics have to describe the same stretch of
// speech.
const CROSS_CHECK_POOL_SEC = 2.0;
const CROSS_CHECK_MIN_POOL = 6;
// Frames between background re-checks of the LPC analysis ceiling. §5: "with a low-rate
// background re-check during use". 900 frames is 15 s at 60 fps, and each re-check is ONE
// extra LPC solve on ONE alternate ceiling — 1/900th of a solve per frame amortised, against
// the per-frame multi-solve §3.4 rules out. The candidates are visited round-robin, so the
// full five-ceiling sweep takes ~75 s of continuous phonation to complete once.
const CEILING_RECHECK_PERIOD_FRAMES = 900;
// Frames of validity history the validity RATE is computed over — the term that reaches
// resonanceConfidence. One rejected frame is not a reason to stop showing a number; a run of
// them is. ~0.5 s at 60 fps.
const VALIDITY_HISTORY_FRAMES = 30;

const WEIGHT_TILT_BASE = 0.45;           // Baseline blend weight for spectral-tilt heaviness
const WEIGHT_H1H2_BLEND = 0.25;          // Max blend weight for the H1-H2 breathiness cue (× confidence)
const WEIGHT_CPP_BLEND = 0.30;           // Blend weight for CPP breathiness cue (× confidence); source-only, no filter contamination
const H1H2_HEAVY_DB = -2;                // H1-H2 (dB) anchor for pressed/heavy phonation
const H1H2_LIGHT_DB = 14;                // H1-H2 (dB) anchor for breathy/light phonation
const WEIGHT_SMOOTH_BASE = 0.10;         // Base EMA rate toward the weight target
const ATTACK_RISE_WINDOW_SECS = 0.06;    // Capture peak energy-rise within 60ms of an onset
const ATTACK_IMPULSE_DECAY = 0.90;       // Per-frame decay of the vocal-attack impulse
const ATTACK_RISE_LEARN_RATE = 0.02;     // EMA rate for the adaptive rise-rate ceiling
const ATTACK_ABRUPT_BLEND = 0.30;        // Blend weight for onset-abruptness vs amplitude-rise hardness
const MAX_SPARKLES = 100;                // Maximum sparkle particles in ball mode

// ============================================================
// VOICE ANALYZER
// ============================================================
export class VoiceAnalyzer {
  constructor() {
    this._buffers = {}; // Pre-allocated typed arrays for performance
    this.audioCtx = null;
    this.analyser = null;
    this.analyserFormant = null;
    this.analyserHF = null;
    this.analyserRec = null;     // dedicated small-FFT analyser for recording capture
    this.recTimeDomainData = null;
    this.source = null;
    this.stream = null;
    this.audioElement = null; // store audio element for cleanup
    this.isActive = false;

    this.timeDomainData = null;
    this.hfFrequencyData = null;
    this.frequencyData = null; // full-spectrum for formant/resonance analysis
    this.formantFreqData = null; // dedicated low-smoothing spectrum for formant peaks
    this.pitchBuf = null; // Downsampled buffer for optimized pitch detection

    // Pitch
    this.pitchHistory = [];
    this.pitchHistoryMax = 30;
    this.lastPitch = 0;
    this.smoothPitchHz = 160; // smoothed Hz for color mapping
    this._pitchMedianBuf = []; // for octave-jump suppression
    this.pitchConfidence = 0;  // 0=unreliable, 1=very confident (from YIN CMND)
    this.pitchWorker = null;
    this.pitchWorkerPending = false;
    this.pitchWorkerSequence = 0;
    this.pitchWorkerResult = null;
    this.pitchWorkerLastConsumed = 0;
    this.pitchWorkerLastHz = 0;

    // Resonance — harmonic envelope formant estimation
    // 'auto' picks an estimator per-frame from the smoothed SNR (see selectResonanceMethod);
    // the rest force one estimator. 'auto' is the default so the live number leans on whichever
    // method degrades least in the current noise instead of one static choice.
    this.resonanceMethod = 'auto'; // 'auto' | 'harmonic' | 'cepstral' | 'lpc' | 'centroid'
    this.activeResonanceMethod = 'harmonic'; // estimator actually used this frame (resolves 'auto')
    this.smoothResonance = 0.5; // 0=low/dark resonance, 1=high/bright resonance
    this.smoothF1 = 500;        // smoothed F1 estimate (Hz)
    this.smoothF2 = 1500;       // smoothed F2 estimate (Hz) — primary resonance correlate
    this.smoothF3 = 2700;       // smoothed F3 estimate (Hz) — secondary resonance cue
    this.formantConfidence = 0;  // how reliable current F1/F2/F3 estimates are
    this.vowelLikelihood = 0;   // 0=not vowel-like, 1=strong vowel formants
    // Steady-state targeting: weight live frames by how "held" they are so vowel targets
    // dominate the estimate over onset/offset/coarticulation frames (see steadyStateWeight).
    this.formantSteadiness = 1;  // smoothed steady-state weight [floor..1] for the live score
    this._prevResF1 = 0;         // last accepted raw F1 candidate (for frame-to-frame delta)
    this._prevResF2 = 0;         // last accepted raw F2 candidate
    // Frames since each formant was last actually MEASURED (not merely coasted). smoothF1/2/3
    // hold their defaults until an estimator supplies a value and hold their last value when
    // one stops finding it — so without this, ΔF (55% of the resonance score) can be driven by
    // a constant 2700 Hz F3 the mic never saw. Anything past FORMANT_STALE_FRAMES is dropped
    // from the ΔF fit, which degrades to the F1/F2 pair instead of trusting a frozen number.
    this._f1Age = Infinity;
    this._f2Age = Infinity;
    this._f3Age = Infinity;
    this.dispersionFitQuality = 0;  // 0..1 goodness-of-fit of the last uniform-tube ΔF fit
    this.dispersionFormantsUsed = 0; // how many formants that fit actually used

    // ====== RESONANCE v2 (docs/RESONANCE_REDESIGN.md §5 — instrumented only) ======
    // Computed alongside v1 every frame and displayed nowhere. v1 above remains the
    // metric the ball, HUD, haptics, gender score, necklace and bulb all read.
    this.smoothF4 = 0;           // 0 = F4 never measured. No default: unlike F1/F2/F3 there is
                                 // no fallback value that is better than admitting absence,
                                 // and F3/F4 carry the scale regression between them, so a
                                 // fabricated F4 would be a fabricated tract length.
    this._f4Age = Infinity;
    this.formantScaleHz = 0;     // pooled, upper-formant-weighted ΔF (Hz) — the tract SIZE
    this.formantScaleFrameHz = 0;// this frame's unpooled weighted ΔF, for divergence logging
    this.apparentVtlV2Cm = 0;    // 35000 / (2·formantScaleHz)
    this.formantPattern = [];    // r_i = F_i/((i-0.5)·ΔF) — the tract SHAPE. Phase 2 input.
    // ---- THE TWO SCALES (§4). Phase 4: these are what the app displays. ----
    // Both are `null` when the frame produced no reading, never 0. 0 is a real position on
    // either axis — "as long a tract as this scale goes" — and a suppressed frame is not that.
    // Everything downstream tests for null; nothing coerces it.
    this.resonanceAbsolute = null;  // ΔF_scale / 2ΔF_ref. Perception model, cross-session,
                                    // cross-device. Never personally normalised, which is the
                                    // whole point of keeping it separate (§2.7).
    this.resonanceControl = null;   // where that sits inside a SPAN — the population span
                                    // until the user calibrates, their own after. Ball, HUD,
                                    // haptics. This is the displayed number.
    this.resonancePresent = false;  // one boolean the UI reads, so "is there a reading" is not
                                    // re-derived from three different fields in four places.
    this.formantScaleFitQuality = 0;
    this.formantScaleFormantsUsed = 0;
    this._scalePool = [];        // rolling window of per-frame weighted ΔF + confidence

    // ------ Phase 2: vowel conditioning (docs/RESONANCE_REDESIGN.md §5) ------
    // Also instrumented only. None of this reaches the interface: §6 is explicit that the
    // user still sees one ring, and five internal variables is an implementation detail.
    this.formantPatternNormalized = [];  // formantPattern on the scale-invariant frame
    this.formantPatternScaleFactor = 0;  // ρ = ΔF_frame / ΔF_pooled. Phase 3's rhotic cue.
    this.vowelId = null;         // classified vowel, or null for "no vowel this frame".
                                 // null is a real answer, not a missing one — §6 requires
                                 // this to degrade to abstention rather than guess.
    this.vowelPosterior = 0;     // 0..1 confidence in that identity
    this.vowelDistance = 0;      // distance to the nearest template, in across-vowel SDs
    this.vowelAbstainReason = 'no-residuals';
    this.f2PositionRatio = 0;    // F2 / expected F2 for this vowel at this speaker's scale.
                                 // 0 = no reading; 1.0 = exactly on the published norm.
    this._v2FrameIndex = 0;      // frame counter, so nucleus gaps are detectable
    // Exercise mode drives what the ball would show; speech mode is what session statistics
    // read (§5). Both run over the same stream so they can never be computed from two
    // different frame sets and then compared.
    this.v2Aggregator = new ResonanceAggregator();
    this.f2PositionAggregator = new ResonanceAggregator();

    // ------ Phase 3: estimator discipline (docs/RESONANCE_REDESIGN.md §5) ------
    // Still instrumented only. §6: the user sees one ring; five internal variables is an
    // implementation detail and if it reaches the interface the redesign has failed.
    //
    // The canonical measurement. Root-solved LPC at this speaker's own analysis ceiling, run
    // every frame regardless of `resonanceMethod`, with its own Kalman filters so that nothing
    // downstream of it can be moved by which estimator the room's noise selected. v1 keeps its
    // own smoothF1/F2/F3 above and is untouched.
    this.canonicalF1 = 0;
    this.canonicalF2 = 0;
    this.canonicalF3 = 0;
    this.canonicalF4 = 0;
    this.canonicalConfidence = 0;
    this.canonicalSteadiness = 1;
    this._canF1Age = Infinity; this._canF2Age = Infinity;
    this._canF3Age = Infinity; this._canF4Age = Infinity;
    this._prevCanF1 = 0; this._prevCanF2 = 0;
    // Per-user LPC analysis ceiling. null = not calibrated, use the published default, which is
    // byte-identical to the pre-Phase-3 arithmetic. Set by calibrateLpcCeiling() (Phase 4 owns
    // the guided vowel-set UI that would call it) and nudged by the background re-check.
    this.lpcCeilingHz = null;
    this.lpcCeilingSource = 'default';   // 'default' | 'calibrated' | 'background'

    // ---- Which assignment defines the canonical MEASUREMENT (§5 Phase 4, item a) ----
    //
    // Phase 3 handed this over as a problem: the LPC loop admits a pole as F3 only above
    // 2000 Hz, P&B's adult-male /ɝ/ has F3 = 1690 Hz, and the live path therefore named a
    // synthesized /ɝ/ correctly on 0.0% of frames. Phase 3 could not widen the slot because the
    // assignment was shared with v1 and v1's output was frozen. Phase 4 retires v1, so the
    // constraint is gone and the question becomes a measurement rather than a blocker.
    //
    // 'standard' — the shipped policy. F3 admitted only above 2000 Hz.
    // 'rhotic'   — the widened floor (F3_RHOTIC_FLOOR_HZ) AS THE MEASUREMENT. Same solve, same
    //              pole list, second slot assignment, so no extra LPC.
    //
    // MEASURED IN tools/rhotic-assignment.mjs, AND THE RESULT IS NOT WHAT PHASE 3 PREDICTED.
    // Phase 3 recorded that widening the slot "manufactures rhotics at F0 180 (/ɔ/ → /ɝ/ on 47
    // of 67)". As the measurement rather than as Phase 3's ρ-corroborated detector, it does not:
    // false positives are 0% on /ɔ/ and /ɪ/ at F0 110/130/180 and 0.2-0.3% over all non-rhotic
    // frames, /ɝ/ recall goes 0% → 92.5% / 25.4% / 31.3%, and overall correctness RISES at every
    // F0 (86.7→96.0, 86.6→89.1, 64.5→67.5). The manufacturing was the detector's, not the slot's.
    //
    // IT STILL SHIPS OFF, for reasons that are not "it fabricates rhotics":
    //   - above F0 110 the rhotic reads as /æ/ instead of /ʊ/ — a different wrong answer, so
    //     §6's confidently-wrong-vowel failure is reduced rather than removed;
    //   - on the Rainbow Passage it costs 3.8 points of vowel yield (85.3% → 81.5%) and moves
    //     the mean displayed value 2.1 points (0.4718 → 0.4507), so it is not free;
    //   - and every one of those numbers is from a Klatt cascade whose /ɝ/ F3 is placed by
    //     construction. Phase 3 said this fix needs an assignment v1 no longer constrains —
    //     which Phase 4 has now provided and measured — "validated against real rhotic
    //     recordings rather than a Klatt cascade, which is Phase 5". That validation is the
    //     remaining blocker, and half-building Phase 5 to reach it would be worse than leaving
    //     a measured, exposed, unused option here.
    this.canonicalAssignment = 'standard';

    // ---- The personal span, and the versioned profile it came from (§3.5, §5 Phase 4) ----
    // No profile = not calibrated = the PUBLISHED POPULATION SPAN, which is a real axis with
    // real ends rather than an absent one, so `resonanceControl` is defined on frame one and
    // the ball works out of the box. Calibrating replaces it with the speaker's own.
    //
    // The span is NOT reset by stop() or by a new session: it is a property of the speaker, it
    // is persisted, and losing it on reload is exactly the defect §3.5's "learned personal
    // ranges" bullet describes and that the grep in resonance-metric.js found to be the actual
    // state of the app before this phase.
    this.resonanceProfileV2 = null;
    this.resonanceSpan = RESONANCE_POPULATION_SPAN;
    this.resonanceSpanId = RESONANCE_POPULATION_SPAN.spanId;
    this.resonanceMetricVersion = RESONANCE_METRIC_VERSION;
    this._ceilingTracks = null;          // per-candidate frame history during a search
    this._ceilingRecheckIdx = 0;
    this._ceilingRecheckFrames = 0;
    // Frame validity (§5). `frameValid` is this frame's verdict; the history behind it is what
    // reaches confidence, because one bad frame is not a reason to stop showing a number.
    this.frameValid = false;
    this.frameInvalidReasons = [];
    this.canonicalRaw = [0, 0, 0, 0];      // this frame's raw LPC solve, pre-gate
    this.canonicalAccepted = [0, 0, 0, 0]; // what survived the gates
    this.validityRate = 0;
    this._validityHistory = [];
    // The last VALID observation of EACH formant, so one rejected frame does not become the
    // reference a whole run is judged against, and a valid frame that missed F3 does not wipe
    // the F3 reference. Aged out on the same bound the scale fit uses.
    this._lastValidRef = [0, 0, 0, 0];
    this._lastValidRefAge = [Infinity, Infinity, Infinity, Infinity];
    this._lpcSolveCount = 0;             // LPC solves this session; tools/estimator-budget.mjs
    // Cross-estimator agreement (§3.4). The secondaries never redefine the scale; they produce
    // this one number and nothing else.
    this.crossEstimatorAgreement = null; // null = no check has run yet
    this.crossCheckDeltaFHz = { cepstral: 0, harmonic: 0 };
    this._crossPool = { cepstral: [], harmonic: [] };
    this._crossCheckClock = 0;
    this._crossCheckTurn = 0;
    // The confidence model of §4's diagram, and the gate that suppresses the readout below it.
    this.resonanceConfidenceV2 = 0;
    this.resonanceSuppressionConfidence = 0;
    this.resonanceSuppressed = true;
    this.resonanceSuppressReason = 'no-reading';
    // The demoted centroid (§5, D1). A secondary brightness feature, never a resonance
    // substitute: it resolves no F3, so it cannot fit a tract or name a vowel.
    this.spectralBrightness = 0;
    // ρ, and whether this window makes it readable (Phase 2's hand-off).
    this.windowHomogeneityCv = 0;
    this.windowIsHomogeneous = true;
    this.rhoticDetected = false;
    this.rhoRelative = 0;
    this.rhoReason = 'no-rho';
    this._rhoWindow = [];                // recent (rho, vowel) for the running median
    this._resFrameSeq = 0;
    this._lpcCacheFrame = -1; this._lpcCacheCeiling = 0; this._lpcCache = null;

    // ====== PERCEIVED-GENDER CUES (multi-cue model) ======
    // Modal (habitual median) pitch over a voiced window, not the momentary note.
    this.modalF0Buf = [];
    this.modalF0BufMax = 90;     // ~1.5s of voiced frames
    this.modalF0Hz = 0;
    this.modalF0Confidence = 0;
    // Sibilant /s/ center-of-gravity (higher = shorter front cavity = feminine).
    this.sibilantCentroidHz = 0;
    this.sibilantConfidence = 0;
    // Mean formant spacing (ΔF) -> apparent vocal-tract length.
    this.formantDispersionHz = 0;
    // Cepstral Peak Prominence (breathiness; lower = breathier = feminine).
    this.cppDb = 12;
    this.cppConfidence = 0;
    this._cppFrameCounter = 0;   // CPP runs every Nth frame (cost control)

    // Kalman filters for formants
    const initKalman = () => ({
      x: [0, 0], // [freq, velocity]
      P: [[10000, 0], [0, 1000]],
      Q: [[100, 0], [0, 10]],
      initialized: false
    });
    this._kalmanF1 = initKalman();
    this._kalmanF2 = initKalman();
    this._kalmanF3 = initKalman();
    this._kalmanF4 = initKalman();
    // Phase 3: the canonical path tracks its own formants. Sharing v1's filters would make the
    // canonical value depend on which estimator fed them, which is the whole thing this phase
    // removes; and the canonical filters carry F0 in their measurement noise, which v1's must
    // not, because v1's displayed output may not move.
    this._kalmanCanF1 = initKalman();
    this._kalmanCanF2 = initKalman();
    this._kalmanCanF3 = initKalman();
    this._kalmanCanF4 = initKalman();

    // Spectral tilt diagnostic (light vs heavy vocal weight)
    this.spectralTiltRawDb = -14;
    this.spectralTiltSmoothedDb = -14;
    this.spectralWeight = 0.5; // 0=heavy, 1=light
    this.spectralTiltConfidence = 0;
    this.micTiltBaselineDb = 0;
    this.micCalibrationTiltSamples = [];

    // Vocal weight (heaviness, 0=light .. 1=heavy) and vocal attack (onset hardness)
    this.weightSmoothed = 0.5;
    this.prevGatedRms = 0;
    this.attackRisePeak = 0;
    this.attackWindowTimer = -1; // <0 = inactive; >=0 = counting up during capture window
    this.attackRiseCeiling = 0.02;
    this.attackImpulse = 0;
    this.attackPeakTime = 0;     // time (s) into the onset window at which the rise peaked
    this.attackRiseHardness = 0; // latched per-onset rise-rate hardness (display sub-cue)
    this.attackAbruptness = 0;   // latched per-onset onset abruptness (display sub-cue)
    this.h1h2SmoothedDb = 6;     // smoothed H1-H2 (dB); ~6 ≈ modal-voice default → mid weight
    this.h1h2Confidence = 0;     // 0..1 trust in the current H1-H2 estimate

    // Energy
    this.energyHistory = [];
    this.energyHistoryMax = 40;
    this.smoothEnergy = 0;
    this.energyBaselineWindow = [];
    this.energyBaselineWindowMax = 120;
    this.energyPercentiles = { p50: 0.002, p75: 0.004, p90: 0.008 };

    // Syllable detection
    this.syllableState = 'silent';
    this.syllableThreshold = 0.015;
    this.lastSyllableTime = 0;
    this.syllableImpulse = 0;

    // Vowel
    this.sustainedDuration = 0;
    this.sustainedThreshold = 0.02;
    this.defaultSustainedThreshold = 0.02;
    // Ring buffer of recent voiced-segment durations for vowel mode detection.
    this._phonationDurations = [];
    this._phonationDurMax = 20;
    this._currentPhonationStart = -1; // timestamp when current voiced segment began

    // Adaptive Pitch Range
    this.pitchProfile = {
      samples: [],
      min: 80,     // Default fallback
      max: 380,    // Default fallback
      isLearned: false,
      voicedTime: 0,
      learningDuration: 5.0
    };

    // Adaptive Spectral Tilt Range
    this.tiltProfile = {
      samples: [],
      min: -34,    // Default heavy fallback
      max: -4,     // Default light fallback
      isLearned: false,
      voicedTime: 0,
      learningDuration: 5.0
    };

    // Adaptive Resonance Range — learns the user's OWN F1 / F2 / formant-dispersion span
    // during the first several seconds of voiced vowels, so the resonance score's 0% and
    // 100% mean *this speaker's* darkest and brightest rather than fixed population anchors.
    // Until learned, the score falls back to the fixed-anchor formulas (byte-identical to the
    // pre-calibration behaviour, which the golden eval asserts on). Not persisted — relearned
    // each session, exactly like pitchProfile / tiltProfile.
    this.resonanceProfile = {
      samples: [],      // {f1, f2, disp} from clean held-vowel frames
      f1Min: 300, f1Max: 900,     // fixed-anchor fallbacks (mirror the old formulas)
      f2Min: 1000, f2Max: 2400,
      dispMin: 1029, dispMax: 1250, // dispersion (Hz) at aVTL 17 cm (longer/darker) → 14 cm (shorter/brighter)
      isLearned: false,
      voicedTime: 0,
      learningDuration: 6.0
    };

    // Adaptive HF energy tracking (for articulation normalisation)
    this.hfEnergyWindow = [];
    this.hfEnergyWindowMax = 60;
    this.hfPercentiles = { p50: 0, p90: 0.02 };

    // Noise floor calibration
    this.noiseFloor = 0.015; // default, will be calibrated
    this.hfNoiseFloor = 0; // HF baseline for fans/AC
    this.noiseCalibrationSamples = [];
    this.hfCalibrationSamples = [];
    this.noiseCalibrationDuration = 1.0; // seconds — longer for steady noise like fans
    this.noiseCalibrationTimer = 0;
    this.isCalibrated = false;
    this.noiseAdaptRate = 0.002; // ongoing adaptation for changing environments

    // Per-frame SNR / noise-trust (Layer A feature packet; see docs/DSP_CONTRACT.md).
    // Start optimistic (assume a quiet room) so the UI doesn't flash red before the
    // first measurement lands.
    this.snrDb = 20;            // raw a-posteriori SNR over the voice band this frame
    this.snrDbSmoothed = 20;    // EMA used for the over-subtraction factor + tiering
    this.snrConfidence = 1;     // 0..1 trust derived from SNR; folds into the gate
    this.snrTier = 'green';     // 'green' | 'yellow' | 'red' for UI/haptics
    this.overSubFactor = 1.5;   // SNR-adaptive spectral over-subtraction (was hardcoded 1.5)
    // Scalar voice-band noise power, learned on pause frames. Only used when there is no
    // per-bin noise profile (calibration skipped/cancelled), so the fallback still measures
    // SNR over the same 300-3500 Hz band the calibrated path does. 0 = not yet learned.
    this.voiceBandNoisePow = 0;

    this.metrics = {
      bounce: 0, vowel: 0,
      articulation: 0,
      pitch: 0, pitchEffort: 0, pitchZone: 0.5,
      energy: 0, resonance: 0,
      attack: 0, weight: 0,
      // Noise-trust surfaced to renderers/haptics (read-only, see docs/DSP_CONTRACT.md)
      snrDb: 20, snrTier: 'green', snrConfidence: 1,
      // Resonance diagnostics: steady-state weight applied this frame + active estimator
      // (resolves 'auto'). Read-only; surfaced for the eval harness / UI debugging.
      resSteadiness: 1, resMethod: 'harmonic'
    };
    this.pitchZoneLabel = 'Ambiguous';
    this.frameConfidence = 0; // overall frame confidence for game-level gating

    // Optional speech-only gate (see speech-gate.js). Off by default: it is a
    // second opinion layered on top of the SNR/confidence gate, and a user in a
    // quiet room gains nothing from it.
    this.speechGateEnabled = false;
    this.speechGate = new SpeechGate();
    this.isSpeechFrame = true;   // permissive when the gate is off
    this.speechLikelihood = 1;
    this.wasLastFrameReliable = false;
    this.noiseSpectralProfile = null;
  }

  // Helper to reuse typed arrays to prevent garbage collection spikes in hot loops
  _getBuffer(name, ArrayType, size) {
    if (!this._buffers[name] || this._buffers[name].length < size) {
      this._buffers[name] = new ArrayType(size);
    }
    return this._buffers[name];
  }

  _initPitchWorker() {
    if (this.pitchWorker || typeof Worker === 'undefined') return;
    try {
      this.pitchWorker = new Worker(new URL('./pitch-analysis-worker.js', import.meta.url), { type: 'module' });
      this.pitchWorker.addEventListener('message', ({ data }) => {
        this.pitchWorkerPending = false;
        this.pitchWorkerResult = data;
      });
      this.pitchWorker.addEventListener('error', (error) => {
        console.warn('Pitch worker unavailable; using main-thread analysis.', error.message);
        this.pitchWorker?.terminate();
        this.pitchWorker = null;
        this.pitchWorkerPending = false;
      });
    } catch {
      this.pitchWorker = null;
    }
  }

  async start(audioFile = null, inputOptions = {}) {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      // Kick resume immediately (fire-and-forget) while still in the user-gesture
      // call stack so iOS Safari grants permission to un-suspend the context before
      // getUserMedia breaks the synchronous gesture chain.
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      if (audioFile) {
        // Handle audio file input
        this.audioElement = new Audio();
        this.audioElement.src = URL.createObjectURL(audioFile);
        this.audioElement.loop = false;

        if (this.audioCtx.state === 'suspended') {
          await this.audioCtx.resume();
        }

        this.source = this.audioCtx.createMediaElementSource(this.audioElement);
        // Connect to destination so user can hear it
        this.source.connect(this.audioCtx.destination);
      } else if (inputOptions.stream) {
        this.stream = inputOptions.stream;
        this.source = this.audioCtx.createMediaStreamSource(this.stream);
      } else {
        // Handle microphone input
        const requestedConstraints = {
          echoCancellation: inputOptions.echoCancellation !== false,
          noiseSuppression: inputOptions.noiseSuppression !== false,
          autoGainControl: inputOptions.autoGainControl !== false,
        };
        if (inputOptions.deviceId) {
          requestedConstraints.deviceId = { exact: inputOptions.deviceId };
        }
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: requestedConstraints });
        this.source = this.audioCtx.createMediaStreamSource(this.stream);
      }

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 4096; // Larger window → better low-freq pitch resolution
      this.analyser.smoothingTimeConstant = 0.8;
      this.source.connect(this.analyser);

      // Dedicated formant analyser — lower smoothing for crisper spectral peaks
      this.analyserFormant = this.audioCtx.createAnalyser();
      this.analyserFormant.fftSize = 4096;
      this.analyserFormant.smoothingTimeConstant = 0.5; // Less temporal blur than main analyser
      this.source.connect(this.analyserFormant);

      this.analyserHF = this.audioCtx.createAnalyser();
      this.analyserHF.fftSize = 1024;
      this.analyserHF.smoothingTimeConstant = 0.3; // Fast response for consonant transients
      const hfFilter = this.audioCtx.createBiquadFilter();
      hfFilter.type = 'highpass';
      hfFilter.frequency.value = 2000; // Captures consonant bursts (s, t, k, etc.)
      this.source.connect(hfFilter);
      hfFilter.connect(this.analyserHF);

      this.timeDomainData = new Float32Array(this.analyser.fftSize);
      this.pitchBuf = new Float32Array(this.analyser.fftSize / 2); // 2x downsampling buffer
      this.frequencyData = new Float32Array(this.analyser.frequencyBinCount);
      this.formantFreqData = new Float32Array(this.analyserFormant.frequencyBinCount);
      this.hfFrequencyData = new Uint8Array(this.analyserHF.frequencyBinCount);
      this._initPitchWorker();

      // Dedicated small-FFT analyser for recording — polls time-domain samples
      // fftSize=512 → 11.6ms window at 44.1kHz, polled at matched interval
      this.analyserRec = this.audioCtx.createAnalyser();
      this.analyserRec.fftSize = 512;
      this.source.connect(this.analyserRec);
      this.recTimeDomainData = new Float32Array(512);

      this.isActive = true;

      // We must play it to get logic processing
      if (this.audioElement) {
        try {
          await this.audioElement.play();
        } catch (playErr) {
          console.error("Autoplay prevented:", playErr);
          this.stop();
          return { ok: false, error: "AutoPlayError", message: playErr.message };
        }
      }

      return { ok: true, audioElement: this.audioElement };
    } catch (e) {
      console.error('Mic/Audio access denied:', e);
      this.stop();
      return { ok: false, error: e.name, message: e.message };
    }
  }

  stop() {
    this.isActive = false;
    this.pitchWorker?.terminate();
    this.pitchWorker = null;
    this.pitchWorkerPending = false;
    this.pitchWorkerResult = null;

    if (this.audioElement) {
      this.audioElement.pause();
      URL.revokeObjectURL(this.audioElement.src);
      this.audioElement.src = "";
      this.audioElement = null;
    }

    if (this.source) { try { this.source.disconnect(); } catch (e) { } }
    // FIX: stop stream tracks so mic LED turns off
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => { });
    }
    this.audioCtx = null;
    this.analyser = null;
    this.analyserFormant = null;
    this.analyserHF = null;
    this.analyserRec = null;
    this.source = null;
    this.pitchBuf = null;
    this.pitchHistory = [];
    this.energyHistory = [];
    this.energyBaselineWindow = [];
    this.energyPercentiles = { p50: 0.002, p75: 0.004, p90: 0.008 };
    this.smoothPitchHz = 160;
    this._pitchMedianBuf = [];
    this.pitchConfidence = 0;
    this.smoothResonance = 0.5;
    this.smoothF1 = 500;
    this.smoothF2 = 1500;
    this.smoothF3 = 2700;
    this.formantConfidence = 0;
    this.vowelLikelihood = 0;
    this.formantSteadiness = 1;
    this._prevResF1 = 0;
    this._prevResF2 = 0;
    // Infinity, not 0: after a restart no formant has been measured yet, so none may be trusted
    // into the ΔF fit until an estimator actually supplies one.
    this._f1Age = Infinity;
    this._f2Age = Infinity;
    this._f3Age = Infinity;
    this.dispersionFitQuality = 0;
    this.dispersionFormantsUsed = 0;
    this.smoothF4 = 0;
    this._f4Age = Infinity;
    this.formantScaleHz = 0;
    this.formantScaleFrameHz = 0;
    this.apparentVtlV2Cm = 0;
    this.formantPattern = [];
    this.resonanceAbsolute = null;
    this.resonanceControl = null;
    this.resonancePresent = false;
    this.formantScaleFitQuality = 0;
    this.formantScaleFormantsUsed = 0;
    this._scalePool = [];
    this.formantPatternNormalized = [];
    this.formantPatternScaleFactor = 0;
    this.vowelId = null;
    this.vowelPosterior = 0;
    this.vowelDistance = 0;
    this.vowelAbstainReason = 'no-residuals';
    this.f2PositionRatio = 0;
    this._v2FrameIndex = 0;
    this.v2Aggregator.reset();
    this.f2PositionAggregator.reset();
    // Phase 3 state. The selected ceiling is deliberately NOT reset: it is a property of the
    // speaker, not of the session, and re-running a multi-ceiling search from scratch every
    // time the mic restarts would throw away the one thing calibration produced.
    this.canonicalF1 = 0; this.canonicalF2 = 0; this.canonicalF3 = 0; this.canonicalF4 = 0;
    this.canonicalConfidence = 0;
    this.canonicalSteadiness = 1;
    this._canF1Age = Infinity; this._canF2Age = Infinity;
    this._canF3Age = Infinity; this._canF4Age = Infinity;
    this._prevCanF1 = 0; this._prevCanF2 = 0;
    this._ceilingTracks = null;
    this._ceilingRecheckFrames = 0;
    this.frameValid = false;
    this.frameInvalidReasons = [];
    this.canonicalRaw = [0, 0, 0, 0];
    this.canonicalAccepted = [0, 0, 0, 0];
    this.validityRate = 0;
    this._validityHistory = [];
    this._lastValidRef = [0, 0, 0, 0];
    this._lastValidRefAge = [Infinity, Infinity, Infinity, Infinity];
    this._lpcSolveCount = 0;
    this.crossEstimatorAgreement = null;
    this.crossCheckDeltaFHz = { cepstral: 0, harmonic: 0 };
    this._crossPool = { cepstral: [], harmonic: [] };
    this._crossCheckClock = 0;
    this._crossCheckTurn = 0;
    this.resonanceConfidenceV2 = 0;
    this.resonanceSuppressionConfidence = 0;
    this.resonanceSuppressed = true;
    this.resonanceSuppressReason = 'no-reading';
    this.spectralBrightness = 0;
    this.windowHomogeneityCv = 0;
    this.windowIsHomogeneous = true;
    this.rhoticDetected = false;
    this.rhoRelative = 0;
    this.rhoReason = 'no-rho';
    this._rhoWindow = [];
    this._resFrameSeq = 0;
    this._lpcCacheFrame = -1; this._lpcCacheCeiling = 0; this._lpcCache = null;
    // Perceived-gender cue state
    this.modalF0Buf = [];
    this.modalF0Hz = 0;
    this.modalF0Confidence = 0;
    this.sibilantCentroidHz = 0;
    this.sibilantConfidence = 0;
    this.formantDispersionHz = 0;
    this.cppDb = 12;
    this.cppConfidence = 0;
    this._cppFrameCounter = 0;

    const initKalman = () => ({
      x: [0, 0],
      P: [[10000, 0], [0, 1000]],
      Q: [[100, 0], [0, 10]],
      initialized: false
    });
    this._kalmanF1 = initKalman();
    this._kalmanF2 = initKalman();
    this._kalmanF3 = initKalman();
    this._kalmanF4 = initKalman();
    this._kalmanCanF1 = initKalman();
    this._kalmanCanF2 = initKalman();
    this._kalmanCanF3 = initKalman();
    this._kalmanCanF4 = initKalman();

    this.spectralTiltRawDb = -14;
    this.spectralTiltSmoothedDb = -14;
    this.spectralWeight = 0.5;
    this.spectralTiltConfidence = 0;
    this.micTiltBaselineDb = 0;
    this.micCalibrationTiltSamples = [];
    this.weightSmoothed = 0.5;
    this.prevGatedRms = 0;
    this.attackRisePeak = 0;
    this.attackWindowTimer = -1;
    this.attackRiseCeiling = 0.02;
    this.attackImpulse = 0;
    this.attackPeakTime = 0;
    this.attackRiseHardness = 0;
    this.attackAbruptness = 0;
    this.h1h2SmoothedDb = 6;
    this.h1h2Confidence = 0;
    this.sustainedDuration = 0;
    this._phonationDurations = [];
    this._currentPhonationStart = -1;
    this.pitchZoneLabel = 'Ambiguous';
    this.syllableImpulse = 0;
    this.syllableState = 'silent';
    this.noiseCalibrationSamples = [];
    this.hfCalibrationSamples = [];
    this.noiseCalibrationTimer = 0;
    this.isCalibrated = false;
    this.noiseFloor = 0.015;
    this.hfNoiseFloor = 0;
    this.pitchProfile = { samples: [], min: 80, max: 380, isLearned: false, voicedTime: 0, learningDuration: 5.0 };
    this.tiltProfile = { samples: [], min: -34, max: -4, isLearned: false, voicedTime: 0, learningDuration: 5.0 };
    this.resonanceProfile = { samples: [], f1Min: 300, f1Max: 900, f2Min: 1000, f2Max: 2400, dispMin: 1029, dispMax: 1250, isLearned: false, voicedTime: 0, learningDuration: 6.0 };
    for (const k in this.metrics) this.metrics[k] = 0;
    this.metrics.pitchZone = 0.5;
    this.wasLastFrameReliable = false;
    this.noiseSpectralProfile = null;
  }

  /** Reset calibration state so a fresh calibration can run cleanly */
  resetCalibration() {
    this.noiseCalibrationSamples = [];
    this.hfCalibrationSamples = [];
    this.micCalibrationTiltSamples = [];
    this.noiseCalibrationTimer = 0;
    this.isCalibrated = false;
    this.noiseSpectralProfile = null;
    this.voiceBandNoisePow = 0;
  }

  /**
   * Close out noise calibration from whatever ambient samples were collected, and flip
   * isCalibrated on. update() calls this when its timer completes; the wizard's
   * skip/cancel/timeout paths call it too, so they can never mark the analyzer calibrated
   * while noiseSpectralProfile still holds the raw per-bin SUM that this step averages.
   * An un-averaged sum reads N x too loud: it pinned SNR to the red tier (leaving the ball
   * permanently grey) and made spectral subtraction floor the whole spectrum.
   *
   * Below MIN_NOISE_PROFILE_FRAMES ambient frames the room is not characterised well enough
   * to trust a per-bin profile at all, so the profile is dropped and the session runs on the
   * scalar voice-band fallback instead — no profile beats a bad one.
   */
  finalizeNoiseCalibration() {
    if (this.isCalibrated) return;
    const samples = this.noiseCalibrationSamples;
    const n = samples.length;

    if (n >= MIN_NOISE_PROFILE_FRAMES) {
      let sum = 0, sqSum = 0;
      for (let i = 0; i < n; i++) {
        sum += samples[i];
        sqSum += samples[i] * samples[i];
      }
      const mean = sum / n;
      // Optimize standard deviation with single pass: Math.sqrt(E[X^2] - (E[X])^2)
      const std = Math.sqrt(Math.max(0, (sqSum / n) - (mean * mean)));

      // Set floor at mean + 4*std — aggressively above ambient noise (fans, AC, etc)
      this.noiseFloor = Math.max(0.01, mean + std * 4);

      // HF noise floor — mean + 2*std of HF energy during silence
      const hfSamples = this.hfCalibrationSamples;
      let hfSum = 0, hfSqSum = 0;
      for (let i = 0; i < hfSamples.length; i++) {
        hfSum += hfSamples[i];
        hfSqSum += hfSamples[i] * hfSamples[i];
      }
      const hfMean = hfSamples.length ? hfSum / hfSamples.length : 0;
      const hfStd = hfSamples.length
        ? Math.sqrt(Math.max(0, (hfSqSum / hfSamples.length) - (hfMean * hfMean)))
        : 0;
      this.hfNoiseFloor = hfMean + hfStd * 2;

      if (this.micCalibrationTiltSamples.length > 0) {
        const sorted = [...this.micCalibrationTiltSamples].sort((a, b) => a - b);
        this.micTiltBaselineDb = sorted[Math.floor(sorted.length / 2)];
      }

      // Average the accumulated spectral profile
      if (this.noiseSpectralProfile) {
        for (let i = 0; i < this.noiseSpectralProfile.length; i++) {
          this.noiseSpectralProfile[i] /= n;
        }
      }
      // A real calibration replaces the thresholds outright, so recalibrating into a
      // quieter room can lower them again.
      this.syllableThreshold = this.noiseFloor * 1.2;
      this.sustainedThreshold = this.noiseFloor * 1.5;
      console.log(`Noise calibrated: floor=${(this.noiseFloor * 1000).toFixed(1)}mRMS, hfFloor=${this.hfNoiseFloor.toFixed(4)}, micTilt=${this.micTiltBaselineDb.toFixed(1)}dB, frames=${n}`);
    } else {
      // Nothing measured — only raise the thresholds toward the fallback floor, never
      // lower ones an earlier calibration had already established.
      this.noiseSpectralProfile = null;
      this.noiseFloor = Math.max(0.008, this.noiseFloor || 0.01);
      this.syllableThreshold = Math.max(this.syllableThreshold || 0, this.noiseFloor * 1.2);
      this.sustainedThreshold = Math.max(this.sustainedThreshold || 0, this.noiseFloor * 1.5);
      console.log(`Noise calibration incomplete (${n} frames) — using scalar voice-band SNR fallback.`);
    }

    this.isCalibrated = true;
  }

  /**
   * Reset the per-SPEAKER adaptive profiles (pitch / tilt / resonance) back to their unlearned
   * defaults so the next person recalibrates from scratch — for passing the app between people.
   * Deliberately keeps the room's NOISE calibration (isCalibrated / noiseFloor / noise profile)
   * intact, since the environment hasn't changed. Also neutralizes the live resonance readout so
   * the previous speaker's value doesn't linger on screen.
   */
  resetSpeakerProfiles() {
    this.pitchProfile = { samples: [], min: 80, max: 380, isLearned: false, voicedTime: 0, learningDuration: 5.0 };
    this.tiltProfile = { samples: [], min: -34, max: -4, isLearned: false, voicedTime: 0, learningDuration: 5.0 };
    this.resonanceProfile = { samples: [], f1Min: 300, f1Max: 900, f2Min: 1000, f2Max: 2400, dispMin: 1029, dispMax: 1250, isLearned: false, voicedTime: 0, learningDuration: 6.0 };
    this.smoothResonance = 0.5;
  }

  /**
   * Set the resonance range from a GUIDED calibration: two arrays each of {f1, f2, disp} samples
   * captured while the user deliberately held their darkest sound then their brightest. Maps the
   * dark extreme → 0% and the bright extreme → 100% (per axis), marks the profile learned, and
   * clears the passive-learning buffer so it can't overwrite the deliberate range. Returns false
   * (leaving the profile untouched) if any axis had no usable samples.
   */
  applyGuidedResonanceRange(dark, bright) {
    const f1 = rangeFromExtremeSamples(dark.f1, bright.f1, { minSpread: 120, absMin: 150, absMax: 1400 });
    const f2 = rangeFromExtremeSamples(dark.f2, bright.f2, { minSpread: 250, absMin: 700, absMax: 3200 });
    const disp = rangeFromExtremeSamples(dark.disp, bright.disp, { minSpread: 120, absMin: 600, absMax: 1800 });
    if (!f1 || !f2 || !disp) return false;
    const rp = this.resonanceProfile;
    rp.f1Min = f1.min; rp.f1Max = f1.max;
    rp.f2Min = f2.min; rp.f2Max = f2.max;
    rp.dispMin = disp.min; rp.dispMax = disp.max;
    rp.samples = [];
    rp.voicedTime = 0;
    rp.isLearned = true;
    this.smoothResonance = 0.5;
    return true;
  }

  // ================= Phase 4: the personal span, versioned ==========================
  //
  // docs/RESONANCE_REDESIGN.md §5's Phase 4 entry and §3.5. Three methods, and the ORDER they
  // are meant to be called in is the design:
  //
  //   1. `calibrateLpcCeiling(segments)` over the guided VOWEL SET — several distinct
  //      productions, one segment each, which is the input that search was built for.
  //   2. the three POSTURE holds, measured live AT THE CHOSEN CEILING, producing the absolute
  //      readings the span is built from.
  //   3. `applyVowelSetCalibration()`, which turns those into a span and a stored profile.
  //
  // Doing 2 before 1 would build the span on a ceiling that is about to change, and a span is
  // exactly the thing that must not be re-derived silently. This is also why the span is NOT
  // computed from the vowel-set holds: those are one posture, so they measure the speaker's
  // tract, not the speaker's range.

  // Install a parsed, version-checked profile. The only way the span ever moves.
  applyResonanceProfile(profile) {
    if (!profile || !profile.span || !Number.isFinite(profile.span.min) || !Number.isFinite(profile.span.max)) {
      return false;
    }
    this.resonanceProfileV2 = profile;
    this.resonanceSpan = {
      min: profile.span.min, max: profile.span.max,
      source: profile.spanSource || 'calibrated',
      metricVersion: profile.metricVersion,
    };
    this.resonanceSpanId = profile.spanId;
    // The ceiling travels with the span because they were measured together on the same voice.
    // A profile carrying a ceiling but restored onto a different microphone is still the right
    // ceiling — it is a property of the SPEAKER's tract, not of the room (§5 Phase 3).
    if (Number.isFinite(profile.ceilingHz) && profile.ceilingHz > 0) {
      this.lpcCeilingHz = profile.ceilingHz;
      this.lpcCeilingSource = 'calibrated';
    }
    return true;
  }

  // Back to the published population span. Used by the settings "reset calibration" control and
  // when a stored profile is refused for being on another metric version — in both cases the
  // app falls back to an axis it can defend, rather than to no axis at all.
  clearResonanceProfile() {
    this.resonanceProfileV2 = null;
    this.resonanceSpan = RESONANCE_POPULATION_SPAN;
    this.resonanceSpanId = RESONANCE_POPULATION_SPAN.spanId;
    this.lpcCeilingHz = null;
    this.lpcCeilingSource = 'default';
  }

  // `postures` = { habitual: [absolute…], brighter: [absolute…], darker: [absolute…] }, each an
  // array of the live `resonanceAbsolute` readings collected during that posture's hold.
  // Suppressed frames contribute nothing — they are not readings — so the caller filters nulls
  // rather than pushing zeros, and `minSamples` is what stops a span being fitted to two frames.
  applyVowelSetCalibration({ postures, ceilingHz = null, phraseAbsolute = null, at = null, minSamples = 8 } = {}) {
    const counts = {
      habitual: (postures?.habitual || []).length,
      brighter: (postures?.brighter || []).length,
      darker: (postures?.darker || []).length,
    };
    if (counts.brighter < minSamples || counts.darker < minSamples) {
      return { ok: false, reason: 'insufficient-samples', counts };
    }
    const span = spanFromPostures(postures);
    if (!span) return { ok: false, reason: 'no-span', counts };
    const profile = makeResonanceProfile({
      span,
      ceilingHz: Number.isFinite(ceilingHz) ? ceilingHz : this.lpcCeilingHz,
      calibratedAt: at || new Date().toISOString(),
      postureSamples: counts,
      phraseAbsolute,
    });
    if (!this.applyResonanceProfile(profile)) return { ok: false, reason: 'apply-failed', counts };
    return { ok: true, profile, span, counts };
  }

  // The reading, packaged so it can be stored or aggregated without the caller having to
  // remember which scale it is on or which version produced it. §3.5's first requirement, in
  // the one place that knows all three facts.
  currentResonanceReading(scale = RESONANCE_SCALE_CONTROL) {
    const value = scale === RESONANCE_SCALE_ABSOLUTE ? this.resonanceAbsolute : this.resonanceControl;
    if (value == null) return null;
    return makeReading(value, {
      scale,
      metricVersion: RESONANCE_METRIC_VERSION,
      spanId: scale === RESONANCE_SCALE_CONTROL ? this.resonanceSpanId : null,
    });
  }

  // Per-bin A-weighting lookup table. The gain for a bin depends only on the bin's
  // centre frequency, which is fixed for a given (sampleRate, fftSize) — computing
  // sqrt/log10/pow for hundreds of bins on every frame is wasted work.
  _aWeightTableFor(fftBinHz, numBins) {
    if (!this._aWeightTable || this._aWeightTable.length !== numBins || this._aWeightTableBinHz !== fftBinHz) {
      const t = new Float32Array(numBins);
      for (let i = 0; i < numBins; i++) t[i] = this._aWeightGain(i * fftBinHz);
      this._aWeightTable = t;
      this._aWeightTableBinHz = fftBinHz;
    }
    return this._aWeightTable;
  }

  // Helper: IEC 61672 A-weighting gain (linear)
  _aWeightGain(freqHz) {
    if (freqHz < 20) return 0.01;
    const f2 = freqHz * freqHz;
    const f4 = f2 * f2;
    const num = 12194 * 12194 * f4;
    const den = (f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + 12194 * 12194);
    const Ra = num / den;
    const A = 20 * Math.log10(Ra) + 2.0;
    return Math.pow(10, A / 10);
  }

  // Helper: 1D Constant-Velocity Kalman Filter Update
  _kalmanUpdate(filter, measurement, measurementNoise) {
    const dt = 1; // 1 frame
    // 1. Predict
    let [x, v] = filter.x;
    let P = filter.P;
    const Q = filter.Q;
    
    if (!filter.initialized) {
      filter.x = [measurement, 0];
      filter.P = [[10000, 0], [0, 1000]];
      filter.initialized = true;
      return measurement;
    }

    // x_pred = F * x
    const x_pred = [x + v * dt, v];
    
    // P_pred = F * P * F^T + Q
    const P_pred = [
      [P[0][0] + dt * P[1][0] + dt * (P[0][1] + dt * P[1][1]) + Q[0][0], P[0][1] + dt * P[1][1] + Q[0][1]],
      [P[1][0] + dt * P[1][1] + Q[1][0], P[1][1] + Q[1][1]]
    ];

    // 2. Update
    // y = z - H * x_pred (H = [1, 0])
    const y = measurement - x_pred[0];
    
    // S = H * P_pred * H^T + R
    const S = P_pred[0][0] + measurementNoise;
    
    // K = P_pred * H^T / S
    const K = [P_pred[0][0] / S, P_pred[1][0] / S];
    
    // x = x_pred + K * y
    filter.x = [x_pred[0] + K[0] * y, x_pred[1] + K[1] * y];
    
    // P = (I - K * H) * P_pred
    filter.P = [
      [(1 - K[0]) * P_pred[0][0], (1 - K[0]) * P_pred[0][1]],
      [-K[1] * P_pred[0][0] + P_pred[1][0], -K[1] * P_pred[0][1] + P_pred[1][1]]
    ];

    return filter.x[0];
  }

  // ========================================================
  // YIN pitch detector — research-grade monophonic f0 estimation
  // Based on de Cheveigné & Kawahara (2002)
  // Steps: difference function → cumulative mean normalized
  //        difference → absolute threshold → parabolic interp
  // Plus median filter for octave-jump suppression
  // ========================================================
  _percentile(values, p) {
    if (!values.length) return 0;
    // OPTIMIZATION: Use quickselect algorithm to find percentile without fully sorting
    const k = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * p)));
    return this._quickselect([...values], k, 0, values.length - 1);
  }

  _quickselect(arr, k, left, right) {
    while (left < right) {
      const pivotIndex = this._partition(arr, left, right);
      if (pivotIndex === k) {
        return arr[k];
      } else if (k < pivotIndex) {
        right = pivotIndex - 1;
      } else {
        left = pivotIndex + 1;
      }
    }
    return arr[k];
  }

  _partition(arr, left, right) {
    const pivot = arr[right];
    let i = left;
    for (let j = left; j < right; j++) {
      if (arr[j] <= pivot) {
        const temp = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
        i++;
      }
    }
    const temp = arr[i];
    arr[i] = arr[right];
    arr[right] = temp;
    return i;
  }

  _detectPitchSync(precomputedRms) {
    // timeDomainData already populated by update() — no need to re-read
    const buf = this.timeDomainData;
    const n = buf.length;
    const sampleRate = this.audioCtx.sampleRate;

    // RMS gate — reuse the value update() already computed for this frame when
    // provided, instead of re-summing the full 4096-sample buffer.
    let rms = precomputedRms;
    if (!Number.isFinite(rms)) {
      rms = 0;
      for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / n);
    }
    const silenceThreshold = this.isCalibrated ? this.noiseFloor * 2.5 : 0.015;
    if (rms < silenceThreshold) return 0;

    // OPTIMIZATION: Downsample by 2x for faster YIN calculation
    // Reduces complexity by ~4x (N^2 -> (N/2)^2)
    const dsRate = sampleRate / 2;
    const dsN = Math.floor(n / 2);
    const dsBuf = this._getBuffer('pitchBuf', Float32Array, dsN);

    // Simple 2x decimation with averaging (low-pass filter)
    for (let i = 0; i < dsN; i++) {
      dsBuf[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5;
    }

    // Adjust params for downsampled rate (Adaptive bounds based on voice profile)
    // Add a 15% safety buffer to variations on the frequency scale
    const safeMinHz = Math.max(40, this.pitchProfile.min * 0.85);
    const safeMaxHz = Math.min(600, this.pitchProfile.max * 1.15);

    // Convert safely to period limits (Inverted: Max Hz maps to Min Period)
    const minPeriod = Math.max(2, Math.floor(dsRate / safeMaxHz)); 
    const maxPeriod = Math.min(Math.floor(dsRate / safeMinHz), Math.floor(dsN / 2));
    const W = maxPeriod; // integration window

    // Step 1 & 2: Difference function d(τ) and CMND d'(τ)
    // OPTIMIZATION: Use running sum of squares to avoid (a-b)^2 in inner loop
    const cmnd = this._getBuffer('cmnd', Float32Array, maxPeriod + 1);
    cmnd[0] = 1.0;
    let runningSum = 0;

    let sumSq0 = 0;
    for (let i = 0; i < W; i++) sumSq0 += dsBuf[i] * dsBuf[i];

    let currentSumSqTau = 0;
    for (let i = 0; i < W; i++) currentSumSqTau += dsBuf[i + 1] * dsBuf[i + 1];

    for (let tau = 1; tau <= maxPeriod; tau++) {
      let crossCorr = 0;
      for (let i = 0; i < W; i++) {
        crossCorr += dsBuf[i] * dsBuf[i + tau];
      }

      let diff = sumSq0 + currentSumSqTau - 2 * crossCorr;
      if (diff < 0) diff = 0; // Floating point noise

      runningSum += diff;
      cmnd[tau] = diff * tau / (runningSum || 1);

      if (tau < maxPeriod) {
        const removeVal = dsBuf[tau];
        const addVal = dsBuf[tau + W];
        currentSumSqTau = currentSumSqTau - removeVal * removeVal + addVal * addVal;
      }
    }

    // Step 3: Absolute threshold — find first dip below threshold
    // This is the key to YIN's octave-error resistance
    const yinThreshold = YIN_THRESHOLD; // Stricter = more accurate, less sensitive
    let bestTau = -1;

    for (let tau = minPeriod; tau <= maxPeriod; tau++) {
      if (cmnd[tau] < yinThreshold) {
        // Walk to the local minimum
        while (tau + 1 <= maxPeriod && cmnd[tau + 1] < cmnd[tau]) {
          tau++;
        }
        bestTau = tau;
        break;
      }
    }

    // Fallback: if no dip below threshold, find global minimum
    if (bestTau < 0) {
      let minVal = Infinity;
      for (let tau = minPeriod; tau <= maxPeriod; tau++) {
        if (cmnd[tau] < minVal) {
          minVal = cmnd[tau];
          bestTau = tau;
        }
      }
      // Reject if global min is still high (likely unvoiced)
      if (minVal > 0.4) return 0;
    }

    // Octave-up guard: YIN's first-below-threshold rule can latch onto the 2x harmonic when the
    // fundamental dip is weak (common for deep voices), reporting double the pitch. Recover the
    // true (longer) period when an equally-good-or-better dip exists at a multiple of bestTau.
    bestTau = correctOctaveError(cmnd, bestTau, { maxPeriod });

    // Step 4: Parabolic interpolation for sub-sample accuracy
    let period = bestTau;
    // Capture CMND value at bestTau for confidence scoring
    const cmndAtBest = cmnd[bestTau];
    if (bestTau > 0 && bestTau < maxPeriod) {
      const a = cmnd[bestTau - 1];
      const b = cmnd[bestTau];
      const c = cmnd[bestTau + 1];
      const denom = 2 * (2 * b - a - c);
      if (Math.abs(denom) > 1e-10) {
        period = bestTau + (a - c) / denom;
      }
    }

    const rawHz = dsRate / period;

    // Pitch confidence: CMND < 0.05 = very confident, > 0.3 = unreliable
    // Map inversely: low CMND → high confidence
    this.pitchConfidence = Math.max(0, Math.min(1, 1 - cmndAtBest * PITCH_CONFIDENCE_FACTOR));

    // Step 5: Median filter — suppresses octave jumps and transient blips
    // Keep a small buffer of recent raw detections (7 frames so a brief 2-3 frame error can't
    // dominate the median).
    this._pitchMedianBuf.push(rawHz);
    if (this._pitchMedianBuf.length > 7) this._pitchMedianBuf.shift();

    if (this._pitchMedianBuf.length >= 3) {
      const sorted = [...this._pitchMedianBuf].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }
    return rawHz;
  }

  detectPitch(precomputedRms) {
    const silenceThreshold = this.isCalibrated ? this.noiseFloor * 2.5 : 0.015;
    if (Number.isFinite(precomputedRms) && precomputedRms < silenceThreshold) return 0;

    if (this.pitchWorker && !this.pitchWorkerPending && this.timeDomainData) {
      const samples = this.timeDomainData.slice();
      const id = ++this.pitchWorkerSequence;
      this.pitchWorkerPending = true;
      this.pitchWorker.postMessage({
        id,
        samples: samples.buffer,
        options: {
          sampleRate: this.audioCtx.sampleRate,
          minHz: Math.max(40, this.pitchProfile.min * 0.85),
          maxHz: Math.min(600, this.pitchProfile.max * 1.15),
          threshold: YIN_THRESHOLD,
          confidenceFactor: PITCH_CONFIDENCE_FACTOR,
        },
      }, [samples.buffer]);
    }

    const result = this.pitchWorkerResult;
    if (result?.id > this.pitchWorkerLastConsumed) {
      this.pitchWorkerLastConsumed = result.id;
      this.pitchConfidence = result.confidence;
      if (result.hz > 0) {
        this._pitchMedianBuf.push(result.hz);
        if (this._pitchMedianBuf.length > 7) this._pitchMedianBuf.shift();
        const sorted = [...this._pitchMedianBuf].sort((a, b) => a - b);
        this.pitchWorkerLastHz = sorted[Math.floor(sorted.length / 2)];
      } else {
        this.pitchWorkerLastHz = 0;
      }
      return this.pitchWorkerLastHz;
    }

    if (this.pitchWorkerLastConsumed > 0) return this.pitchWorkerLastHz;
    return this._detectPitchSync(precomputedRms);
  }

  update(dt) {
    if (!this.isActive || !this.analyser) return;

    const now = performance.now() / 1000;

    // --- Raw energy first (needed for calibration) ---
    this.analyser.getFloatTimeDomainData(this.timeDomainData);
    let rms = 0;
    for (let i = 0; i < this.timeDomainData.length; i++) {
      rms += this.timeDomainData[i] * this.timeDomainData[i];
    }
    rms = Math.sqrt(rms / this.timeDomainData.length);

    // --- Noise floor calibration ---
    // Collect ambient noise samples for ~1s, then compute thresholds
    if (!this.isCalibrated) {
      this.noiseCalibrationTimer += dt;
      this.noiseCalibrationSamples.push(rms);
      // Also sample HF energy during calibration (for fan/AC baseline)
      this.analyserHF.getByteFrequencyData(this.hfFrequencyData);
      let hfSample = 0;
      for (let i = 0; i < this.hfFrequencyData.length; i++) hfSample += this.hfFrequencyData[i];
      this.hfCalibrationSamples.push(hfSample / (this.hfFrequencyData.length * 255));

      this.analyser.getFloatFrequencyData(this.frequencyData);
      if (!this.noiseSpectralProfile) {
        this.noiseSpectralProfile = new Float32Array(this.frequencyData.length);
      }
      const fftBinHz = this.audioCtx.sampleRate / this.analyser.fftSize;
      const activeF0 = 160; // Use fixed 160Hz for baseline calibration
      const lowStartHz = Math.max(70, activeF0 * 0.5);
      const lowEndHz = Math.min(2200, activeF0 * 3.5);
      const highStartHz = 2500;
      const highEndHz = Math.min(5000, this.audioCtx.sampleRate * 0.5 - fftBinHz);
      const eps = 1e-12;

      let eLowTilt = 0, eHighTilt = 0;
      const aWeights = this._aWeightTableFor(fftBinHz, this.frequencyData.length);

      for (let i = 0; i < this.frequencyData.length; i++) {
        // Convert Decibels to Linear Magnitude for proper calibration scaling
        const linearMag = Math.pow(10, this.frequencyData[i] / 20);
        this.noiseSpectralProfile[i] += linearMag;

        const freqHz = i * fftBinHz;
        const powerA = linearMag * linearMag * aWeights[i];
        if (freqHz >= lowStartHz && freqHz <= lowEndHz) {
          eLowTilt += powerA;
        } else if (freqHz >= highStartHz && freqHz <= highEndHz) {
          eHighTilt += powerA;
        }
      }

      let rawTiltDb = 10 * Math.log10((eHighTilt + eps) / (eLowTilt + eps));
      if (isFinite(rawTiltDb)) this.micCalibrationTiltSamples.push(rawTiltDb);

      if (this.noiseCalibrationTimer >= this.noiseCalibrationDuration) {
        this.finalizeNoiseCalibration();
      }
      // During calibration, don't trigger any metrics
      return;
    }

    // --- Slow ongoing noise floor adaptation (for changing environments) ---
    if (rms < this.noiseFloor * 1.5 && rms > 0.001) {
      this.noiseFloor += (rms * 1.2 - this.noiseFloor) * this.noiseAdaptRate;
      this.noiseFloor = Math.max(0.005, this.noiseFloor);
      this.syllableThreshold = this.noiseFloor * 1.2;
      this.sustainedThreshold = this.noiseFloor * 1.5;
    }

    // --- Gate: subtract noise floor from RMS ---
    const gatedRms = Math.max(0, rms - this.noiseFloor);
    this.smoothEnergy += (gatedRms - this.smoothEnergy) * 0.15;

    this.energyHistory.push(gatedRms);
    if (this.energyHistory.length > this.energyHistoryMax) this.energyHistory.shift();
    this.energyBaselineWindow.push(gatedRms);
    if (this.energyBaselineWindow.length > this.energyBaselineWindowMax) this.energyBaselineWindow.shift();
    if (this.energyBaselineWindow.length >= 12) {
      this.energyPercentiles.p50 = this._percentile(this.energyBaselineWindow, 0.5);
      this.energyPercentiles.p75 = this._percentile(this.energyBaselineWindow, 0.75);
      this.energyPercentiles.p90 = this._percentile(this.energyBaselineWindow, 0.9);
    }

    // --- Pitch (only if above noise floor) ---
    let pitch = 0;
    if (rms > this.noiseFloor * 2) {
      pitch = this.detectPitch(rms);
    }
    if (pitch > 0) {
      this.lastPitch = pitch;
      this.pitchHistory.push(pitch);
      if (this.pitchHistory.length > this.pitchHistoryMax) this.pitchHistory.shift();
      // --- MODAL (median) F0 over a voiced window — habitual pitch, not the momentary note ---
      if (this.pitchConfidence > 0.4) {
        this.modalF0Buf.push(pitch);
        if (this.modalF0Buf.length > this.modalF0BufMax) this.modalF0Buf.shift();
      }
      if (this.modalF0Buf.length >= 8) {
        const p10 = this._percentile(this.modalF0Buf, 0.10);
        const p50 = this._percentile(this.modalF0Buf, 0.50);
        const p90 = this._percentile(this.modalF0Buf, 0.90);
        this.modalF0Hz = p50;
        const fill = Math.min(1, this.modalF0Buf.length / this.modalF0BufMax);
        const relSpread = p50 > 0 ? (p90 - p10) / (2 * p50) : 1;
        this.modalF0Confidence = Math.max(0, Math.min(1, fill * (1 - relSpread)));
      }
      // Only update smooth Hz when confident — prevents flicker during breathy/whispered speech
      if (this.pitchConfidence > 0.4) {
        const lerpRate = 0.08 + this.pitchConfidence * 0.12; // faster lerp when more confident
        this.smoothPitchHz += (pitch - this.smoothPitchHz) * lerpRate;

        // --- ADAPTIVE PITCH RANGE LEARNING ---
        // Gated on the speech decision: this range is fixed once and then used
        // all session, so a fan tone captured here mis-scales the pitch meter
        // permanently. `isSpeechFrame` is one frame stale at this point (the
        // gate needs the subtracted spectrum, computed further down), which is
        // immaterial against the gate's 8-frame hangover.
        if (!this.pitchProfile.isLearned && this.isSpeechFrame) {
          this.pitchProfile.samples.push(pitch);
          this.pitchProfile.voicedTime += dt;
          if (this.pitchProfile.voicedTime >= this.pitchProfile.learningDuration || this.pitchProfile.samples.length > 200) {
            const sorted = [...this.pitchProfile.samples].sort((a, b) => a - b);
            // Ignore lowest and highest 5% to remove potential octave errors
            const p05 = sorted[Math.floor(sorted.length * 0.05)];
            const p95 = sorted[Math.floor(sorted.length * 0.95)];

            this.pitchProfile.min = Math.max(50, p05 * 0.85);
            this.pitchProfile.max = Math.min(800, p95 * 1.25);
            this.pitchProfile.isLearned = true;
            console.log(`[ProsodyBall] Learned User Pitch Range: ${this.pitchProfile.min.toFixed(0)}Hz - ${this.pitchProfile.max.toFixed(0)}Hz`);
          }
        }
      }
    }

    // --- HF energy (articulation) — gated against both main noise floor and HF baseline ---
    this.analyserHF.getByteFrequencyData(this.hfFrequencyData);
    let hfEnergy = 0;
    for (let i = 0; i < this.hfFrequencyData.length; i++) {
      hfEnergy += this.hfFrequencyData[i];
    }
    hfEnergy = hfEnergy / (this.hfFrequencyData.length * 255);
    // Subtract HF baseline (fan/AC noise) — but keep it sensitive to speech consonants
    hfEnergy = Math.max(0, hfEnergy - this.hfNoiseFloor);
    // Only gate if WELL below speech level — consonants can be brief and quiet
    if (rms < this.noiseFloor * 1.3) hfEnergy = 0;

    // Track HF energy percentiles for adaptive articulation normalisation
    if (hfEnergy > 0) {
      this.hfEnergyWindow.push(hfEnergy);
      if (this.hfEnergyWindow.length > this.hfEnergyWindowMax) this.hfEnergyWindow.shift();
      if (this.hfEnergyWindow.length >= 8) {
        this.hfPercentiles.p50 = this._percentile(this.hfEnergyWindow, 0.5);
        this.hfPercentiles.p90 = this._percentile(this.hfEnergyWindow, 0.9);
      }
    }

    this.analyser.getFloatFrequencyData(this.frequencyData);
    // --- Spectral subtraction + per-frame voice-band SNR ---
    // Over-subtraction adapts to the *previous* frame's smoothed SNR (SNR moves slowly
    // relative to the frame rate, so this frame's factor is known before the loop). On
    // detected pause frames we also EMA the per-bin noise profile toward the current
    // spectrum, so a changing room (HVAC cycling, car RPM) re-tracks instead of
    // mis-subtracting a profile frozen at calibration time.
    this.overSubFactor = adaptiveOverSubtraction(this.snrDbSmoothed);
    const snrBinHz = this.audioCtx.sampleRate / this.analyser.fftSize;
    const SNR_LO_HZ = SNR_VOICE_BAND_LO_HZ, SNR_HI_HZ = SNR_VOICE_BAND_HI_HZ; // voice band (from spec); excludes <300 Hz rumble
    const profileRate = rms < this.noiseFloor * 1.5 ? NOISE_PROFILE_UPDATE_RATE : 0; // pause → update
    if (this.isCalibrated && this.noiseSpectralProfile) {
      let snrSigPow = 0, snrNoisePow = 0;
      for (let i = 0; i < this.frequencyData.length; i++) {
        let signalMag = Math.pow(10, this.frequencyData[i] / 20);
        if (profileRate > 0) {
          // A pause frame is a fresh ambient sample: nudge the per-bin profile toward it.
          this.noiseSpectralProfile[i] += (signalMag - this.noiseSpectralProfile[i]) * profileRate;
        }
        let noiseMag = this.noiseSpectralProfile[i] || 0;
        const fHz = i * snrBinHz;
        if (fHz >= SNR_LO_HZ && fHz <= SNR_HI_HZ) {
          snrSigPow += signalMag * signalMag;
          snrNoisePow += noiseMag * noiseMag;
        }
        // SNR-adaptive over-subtraction (floor 0.01) — replaces the old constant 1.5.
        let cleanMag = Math.max(0.01 * signalMag, signalMag - this.overSubFactor * noiseMag);
        // Re-convert to dB scale for native compatibility with downstream dsp engines
        this.frequencyData[i] = cleanMag > 1e-10 ? 20 * Math.log10(cleanMag) : -200;
      }
      this.snrDb = aPosterioriSnrDb(snrSigPow, snrNoisePow);
    } else {
      // Pre-calibration / calibration-skipped fallback. Measure the SAME voice-band
      // a-posteriori SNR the calibrated path does, but against a scalar voice-band noise
      // power learned on pause frames instead of a per-bin profile.
      //
      // This used to be a broadband amplitude ratio (rms / noiseFloor), which compared the
      // whole spectrum — rumble, handling noise, HVAC — against a scalar floor that itself
      // has a hard 0.01 minimum. Ordinary conversational speech scored ~6-14 dB that way and
      // so never cleared the 20 dB green threshold, leaving snrConfidence near zero and the
      // ball grey for the entire session whenever the calibration wizard was skipped.
      let snrSigPow = 0;
      for (let i = 0; i < this.frequencyData.length; i++) {
        const fHz = i * snrBinHz;
        if (fHz < SNR_LO_HZ) continue;
        if (fHz > SNR_HI_HZ) break;
        const signalMag = Math.pow(10, this.frequencyData[i] / 20);
        snrSigPow += signalMag * signalMag;
      }
      if (profileRate > 0 && snrSigPow > 0) {
        // Pause frame: seed on the first one, then track the room like the per-bin profile does.
        this.voiceBandNoisePow = this.voiceBandNoisePow > 0
          ? this.voiceBandNoisePow + (snrSigPow - this.voiceBandNoisePow) * profileRate
          : snrSigPow;
      }
      this.snrDb = this.voiceBandNoisePow > 0
        // Until a pause has been observed there is no voice-band noise estimate yet, so keep
        // the old broadband ratio for those first frames rather than inventing a number.
        ? aPosterioriSnrDb(snrSigPow, this.voiceBandNoisePow)
        : 20 * Math.log10(Math.max(rms, 1e-6) / Math.max(this.noiseFloor, 1e-6));
    }
    this.snrDb = Math.max(SNR_DB_FLOOR, Math.min(SNR_DB_CEIL, this.snrDb));
    this.snrDbSmoothed += (this.snrDb - this.snrDbSmoothed) * 0.2;
    this.snrConfidence = snrToConfidence(this.snrDbSmoothed);
    this.snrTier = snrTier(this.snrDbSmoothed);
    this.metrics.snrDb = this.snrDbSmoothed;
    this.metrics.snrConfidence = this.snrConfidence;

    // --- Optional speech-only gate ---
    // Evaluated here because this is the first point where frequencyData holds
    // the noise-subtracted spectrum. The SNR gate above answers "is this signal
    // clean?"; this one answers the different question "is this a voice at all?"
    // — which is what rejects a loud fan or a fridge hum rather than merely
    // distrusting them.
    if (this.speechGateEnabled) {
      const { isSpeech, likelihood } = this.speechGate.update({
        magnitudesDb: this.frequencyData,
        binHz: snrBinHz,
        pitchHz: pitch,
        harmonicity: this.pitchConfidence,
      });
      this.isSpeechFrame = isSpeech;
      this.speechLikelihood = likelihood;
    } else {
      this.isSpeechFrame = true;
      this.speechLikelihood = 1;
    }
    this.metrics.speechLikelihood = this.speechLikelihood;
    this.metrics.snrTier = this.snrTier;
    const fData = this.frequencyData;

    // ====== SPECTRAL TILT (dynamic pitch-aware band ratio) ======
    // Heavy band tracks lower harmonics around F0, light band samples 2.5k-5k breath/brightness.
    const fftBinHz = this.audioCtx.sampleRate / this.analyser.fftSize;
    const eps = 1e-12;
    const activeF0 = pitch > 0 ? pitch : (this.lastPitch > 0 ? this.lastPitch : this.smoothPitchHz || 160);
    const lowStartHz = Math.max(70, activeF0 * 0.5);
    const lowEndHz = Math.min(2200, activeF0 * 3.5);
    const highStartHz = 2500;
    const highEndHz = Math.min(5000, this.audioCtx.sampleRate * 0.5 - fftBinHz);

    const aWeights = this._aWeightTableFor(fftBinHz, fData.length);
    const sumBandPowerAWeighted = (loHz, hiHz) => {
      if (hiHz <= loHz) return 0;
      const startBin = Math.max(0, Math.floor(loHz / fftBinHz));
      const endBin = Math.min(fData.length - 1, Math.ceil(hiHz / fftBinHz));
      if (endBin < startBin) return 0;
      let sum = 0;
      for (let i = startBin; i <= endBin; i++) {
        const mag = Math.pow(10, fData[i] / 20);
        sum += mag * mag * aWeights[i];
      }
      return sum;
    };

    const eLowTilt = sumBandPowerAWeighted(lowStartHz, lowEndHz);
    const eHighTilt = sumBandPowerAWeighted(highStartHz, highEndHz);
    let rawTiltDb = 10 * Math.log10((eHighTilt + eps) / (eLowTilt + eps));
    // Guard against -Infinity/NaN when both bands are near-zero
    if (!isFinite(rawTiltDb)) rawTiltDb = this.spectralTiltSmoothedDb;
    
    // Subtract microphone color baseline learned during calibration
    rawTiltDb -= this.micTiltBaselineDb;
    this.spectralTiltRawDb = rawTiltDb;

    // EMA smoothing to reduce frame jitter while preserving control latency.
    const tiltAlpha = 0.16;
    this.spectralTiltSmoothedDb += (rawTiltDb - this.spectralTiltSmoothedDb) * tiltAlpha;

    // --- ADAPTIVE TILT RANGE LEARNING ---
    if (pitch > 0 && this.pitchConfidence > 0.4) {
      if (!this.tiltProfile.isLearned) {
        this.tiltProfile.samples.push(this.spectralTiltSmoothedDb);
        this.tiltProfile.voicedTime += dt;
        if (this.tiltProfile.voicedTime >= this.tiltProfile.learningDuration || this.tiltProfile.samples.length > 200) {
          const sorted = [...this.tiltProfile.samples].sort((a, b) => a - b);
          // Remove extreme outliers
          const p10 = sorted[Math.floor(sorted.length * 0.10)];
          const p90 = sorted[Math.floor(sorted.length * 0.90)];

          // Ensure a decent spread so control isn't overly twitchy
          const median = sorted[Math.floor(sorted.length * 0.5)];
          const spread = Math.max(16, p90 - p10); // Minimum 16dB range

          this.tiltProfile.min = median - spread * 0.55;
          this.tiltProfile.max = median + spread * 0.45;
          this.tiltProfile.isLearned = true;
          console.log(`[ProsodyBall] Learned User Tilt Range: ${this.tiltProfile.min.toFixed(1)}dB to ${this.tiltProfile.max.toFixed(1)}dB`);
        }
      }
    }

    // Typical speech tilt spans roughly -34dB (heavy) to -4dB (light) on mobile mics.
    const heavyAnchorDb = this.tiltProfile.isLearned ? this.tiltProfile.min : -34;
    const lightAnchorDb = this.tiltProfile.isLearned ? this.tiltProfile.max : -4;
    const normalized = normalizeAgainstRange(this.spectralTiltSmoothedDb, heavyAnchorDb, lightAnchorDb);
    const tiltConfidenceGate = rms > this.noiseFloor * 1.35 ? 1 : Math.max(0, (rms - this.noiseFloor) / Math.max(1e-6, this.noiseFloor * 0.5 || 1e-6));
    this.spectralWeight += (normalized - this.spectralWeight) * (0.12 + tiltConfidenceGate * 0.2);
    this.spectralTiltConfidence += (tiltConfidenceGate - this.spectralTiltConfidence) * 0.2;

    // ====== H1–H2 (open quotient / breathiness cue for weight) ======
    // Amplitude of the 1st vs 2nd harmonic (dB). High H1-H2 = open/breathy/light; low or
    // negative = pressed/heavy. As a ratio of two nearby harmonics it is largely immune to
    // microphone colouration, complementing the (mic-sensitive) absolute spectral tilt.
    if (pitch > 0 && this.pitchConfidence > 0.4 && activeF0 > 0) {
      const hSearch = Math.max(1, Math.floor((activeF0 / fftBinHz) * 0.25));
      const harmonicPeakDb = (centerHz) => {
        const center = centerHz / fftBinHz;
        const lo = Math.max(1, Math.floor(center) - hSearch);
        const hi = Math.min(fData.length - 1, Math.ceil(center) + hSearch);
        let peak = -Infinity;
        for (let i = lo; i <= hi; i++) if (fData[i] > peak) peak = fData[i];
        return peak;
      };
      const h1 = harmonicPeakDb(activeF0);
      const h2 = harmonicPeakDb(activeF0 * 2);
      if (isFinite(h1) && isFinite(h2)) {
        this.h1h2SmoothedDb += ((h1 - h2) - this.h1h2SmoothedDb) * 0.16;
        this.h1h2Confidence += (clamp01(this.pitchConfidence) - this.h1h2Confidence) * 0.2;
      }
    } else {
      this.h1h2Confidence *= 0.9;
    }

    // ====== FORMANT / RESONANCE ANALYSIS ======
    // Two-stage approach:
    //   Stage 1: Band energy ratios for vowel vs consonant detection (fast, always-on)
    //   Stage 2: Harmonic envelope peak-picking for F1/F2 estimation (only during voiced vowels)
    const binHz = this.audioCtx.sampleRate / this.analyser.fftSize;

    // --- Stage 1: Band energy for vowel detection ---
    const bandEnergy = (lo, hi) => {
      const startBin = Math.floor(lo / binHz);
      const endBin = Math.min(Math.ceil(hi / binHz), fData.length - 1);
      let sum = 0;
      for (let i = startBin; i <= endBin; i++) {
        sum += Math.pow(10, fData[i] / 20);
      }
      return sum / Math.max(1, endBin - startBin + 1);
    };

    const eLow = bandEnergy(250, 900);   // F1 region
    const eMid = bandEnergy(900, 2800);  // F2 region
    const eHigh = bandEnergy(2800, 6000); // Fricative region
    const eTotal = eLow + eMid + eHigh + 0.0001;

    const vowelRatio = (eLow + eMid) / eTotal;
    const fricativeRatio = eHigh / eTotal;
    const hasEnough = gatedRms > this.sustainedThreshold;
    const rawVowelLike = hasEnough ? Math.max(0, vowelRatio - fricativeRatio) : 0;
    this.vowelLikelihood += (rawVowelLike - this.vowelLikelihood) * 0.2;

    // --- Sibilant /s/ spectral centroid (gender cue that works on UNVOICED speech) ---
    // Only sample during clear fricative frames; otherwise let confidence decay so a silent
    // or voiced frame never injects a bogus centroid into the blend.
    if (fricativeRatio > 0.5 && hfEnergy > 0 && rms > this.noiseFloor * 1.3) {
      const hfBinHz = this.audioCtx.sampleRate / this.analyserHF.fftSize;
      // Lower bound raised to 4 kHz to exclude /ʃ/ (~2.5–3.5 kHz) so only /s/ frames
      // are measured. Upper bound 8500 Hz reaches the feminine /s/ ceiling without
      // requiring > 44.1 kHz sample rate (Nyquist must exceed 8.5 kHz).
      const rawCentroid = computeSpectralCentroid(this.hfFrequencyData, hfBinHz, 4000, 8500);
      if (rawCentroid > 0) {
        this.sibilantCentroidHz += (rawCentroid - this.sibilantCentroidHz) * 0.25;
        const target = Math.min(1, fricativeRatio);
        this.sibilantConfidence += (target - this.sibilantConfidence) * 0.25;
      }
    } else {
      this.sibilantConfidence *= 0.9;
    }

    // --- Stage 2: Resonance estimation (method-selectable) ---
    // Only run during confident voiced vowels
    if (pitch > 0 && this.pitchConfidence > 0.4 && this.vowelLikelihood > 0.25) {
      this.analyserFormant.getFloatFrequencyData(this.formantFreqData);
      if (this.isCalibrated && this.noiseSpectralProfile) {
        // Both analysers use fftSize=4096 so bins match exactly. Reuse this frame's
        // SNR-adaptive over-subtraction factor (set in the main spectrum pass above).
        for (let i = 0; i < this.formantFreqData.length; i++) {
          let signalMag = Math.pow(10, this.formantFreqData[i] / 20);
          let noiseMag = this.noiseSpectralProfile[i] || 0;
          let cleanMag = Math.max(0.01 * signalMag, signalMag - this.overSubFactor * noiseMag);
          this.formantFreqData[i] = cleanMag > 1e-10 ? 20 * Math.log10(cleanMag) : -200;
        }
      }

      let f1Candidate = 0, f2Candidate = 0, f3Candidate = 0, f4Candidate = 0, conf = 0;

      // ================= PHASE 3: the canonical estimator (§5, §3.4) =================
      // ONE estimator defines the measurement. Root-solved downsampled LPC runs here, every
      // frame, at this speaker's own analysis ceiling, and everything the v2 stream reports is
      // built from it — whatever `resonanceMethod` says and whatever the room's noise is doing.
      //
      // §3.4's argument, restated as the reason this block exists: the four estimators carry
      // systematic BIAS, not just noise (lpc −0.3, cepstral −1.7, centroid +5.0, harmonic −11.9
      // score points against a vowel whose answer is known), and the `auto` ladder swaps between
      // three of them mid-session. Every swap is a step in the reported resonance that the
      // speaker did not cause. Hysteresis made the steps rarer; only this makes them stop.
      //
      // COST, measured rather than assumed (tools/estimator-budget.mjs): the cache below means
      // an uncalibrated user on `lpc` — which is every current user, every fixture and every
      // golden test — pays NOTHING, because v1's solve and the canonical solve are the same
      // call. A second solve appears only for a user who has calibrated a non-default ceiling,
      // or who has forced a non-LPC estimator for v1. That duplication exists solely because v1
      // must stay byte-identical while it is still the displayed number; Phase 4 retires v1 and
      // the second solve goes with it.
      this._resFrameSeq++;
      const canonical = this._lpcAtCeiling(this.lpcCeilingHz || LPC_DEFAULT_CEILING_HZ);

      // In 'auto', resolve the estimator from the (slow-moving) smoothed SNR so the live
      // number leans on whichever method degrades least in the current noise; otherwise honour
      // the explicit selection. activeResonanceMethod feeds methodTrust + the UI/metrics.
      const effectiveMethod = this.resonanceMethod === 'auto'
        // Pass the incumbent so the ladder has hysteresis: an SNR parked on a tier edge would
        // otherwise swap estimators every frame, and each swap steps the reported resonance.
        ? selectResonanceMethod(this.snrDbSmoothed, { current: this.activeResonanceMethod })
        : this.resonanceMethod;
      this.activeResonanceMethod = effectiveMethod;

      switch (effectiveMethod) {
        case 'harmonic':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } =
            this._resonanceHarmonicEnvelope(pitch));
          break;
        case 'cepstral':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } =
            this._resonanceCepstral(pitch));
          break;
        case 'lpc':
          // f4 defaults to 0 in the destructure: only the LPC path can produce one, and the
          // other three estimators must not be made to look as though they abstained when
          // they were never asked.
          //
          // PHASE 4: the same solve the canonical path just made, at the SAME ceiling.
          //
          // Through Phases 1-3 this line read `this._lpcAtCeiling(LPC_DEFAULT_CEILING_HZ)` —
          // pinned to the published default even for a user whose canonical path had chosen a
          // different one — because v1 was the displayed number and its output had to stay
          // byte-identical. That pin is the whole reason a second LPC solve per frame existed
          // (§5's Phase 3 budget table: 0.994 solves/frame shared, 1.989 when the two ceilings
          // differed). v1 is no longer displayed, so the pin has nothing left to protect and
          // the duplicate solve goes with it. Measured after: tools/resonance-budget.mjs.
          //
          // v1 stays COMPUTABLE, which is what migration needs: `resonanceScoreV1` is untouched,
          // its golden vectors are untouched, and for an uncalibrated user — every fixture and
          // every golden test — the two ceilings are the same number, so this is the same call
          // it always was.
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, f4: f4Candidate = 0, confidence: conf } =
            canonical);
          break;
        case 'centroid':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } =
            this._resonanceCentroid());
          break;
        default:
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } =
            this._resonanceHarmonicEnvelope(pitch));
      }

      // --- Steady-state weighting (vowel-target targeting) ---
      // Reuse existing primitives — recent pitch trajectory + this method's raw F1/F2 — to
      // gauge how "held" this frame is. Onset/offset/glide frames score low; held vowels score
      // high. The weight modulates how hard a frame may move the live estimate (below), so the
      // resonance number leans on clinician-measurable steady frames without any separate mode.
      let pitchDevSt = 0;
      const ph = this.pitchHistory;
      if (ph.length >= 3) {
        const n = Math.min(5, ph.length); // short window → local glide, not long-window prosody
        let sum = 0;
        for (let i = ph.length - n; i < ph.length; i++) sum += ph[i];
        const mean = sum / n;
        if (mean > 0) {
          let sq = 0;
          for (let i = ph.length - n; i < ph.length; i++) {
            const st = 12 * Math.log2(ph[i] / mean);
            sq += st * st;
          }
          pitchDevSt = Math.sqrt(sq / n);
        }
      }
      let formantRelDelta = 0;
      if (this._prevResF1 > 0 && this._prevResF2 > 0 && f1Candidate > 0 && f2Candidate > 0) {
        formantRelDelta = Math.abs(f1Candidate - this._prevResF1) / this._prevResF1
                        + Math.abs(f2Candidate - this._prevResF2) / this._prevResF2;
      }
      if (f1Candidate > 0) this._prevResF1 = f1Candidate;
      if (f2Candidate > 0) this._prevResF2 = f2Candidate;
      const steadiness = steadyStateWeight({ pitchSemitoneDev: pitchDevSt, formantRelDelta });
      this.formantSteadiness += (steadiness - this.formantSteadiness) * 0.3;
      this.metrics.resSteadiness = this.formantSteadiness;
      this.metrics.resMethod = effectiveMethod;

      // --- Kalman-Filtered Formant Continuity ---
      // Replaces simple EMA/jump-penalty with a 1D constant-velocity model.
      // During pitch slides, velocity tracks the true formant trajectory
      // and rejects harmonic-locked outliers.
      
      const methodTrust = RESONANCE_METHOD_TRUST[effectiveMethod] || RESONANCE_METHOD_TRUST.harmonic;

      // Adaptive measurement noise: low confidence = large R (trust prediction more).
      // Steady-state weight folds in here too so jumpy transition frames inflate R (and are
      // pulled toward the prediction) while held-vowel frames are trusted at face value.
      const R_base = 2500; // Hz^2 base measurement noise
      const R_scale = Math.max(0.1, conf * methodTrust * this.formantSteadiness);
      const R = R_base / (R_scale * R_scale);

      // Age every formant this estimator frame, then reset the ones it actually measured. A
      // formant the estimator keeps missing goes stale and stops contributing to ΔF.
      this._f1Age++; this._f2Age++; this._f3Age++; this._f4Age++;
      if (f1Candidate > 0) { this.smoothF1 = this._kalmanUpdate(this._kalmanF1, f1Candidate, R); this._f1Age = 0; }
      if (f2Candidate > 0) { this.smoothF2 = this._kalmanUpdate(this._kalmanF2, f2Candidate, R); this._f2Age = 0; }
      if (f3Candidate > 0) { this.smoothF3 = this._kalmanUpdate(this._kalmanF3, f3Candidate, R); this._f3Age = 0; }
      // F4 gets the same continuity treatment as F1-F3 and nothing more. It is tracked in its
      // own filter so a missed F4 coasts rather than snapping, but it is never defaulted: if
      // no estimator has ever produced one, smoothF4 stays 0 and the scale fit runs on F1-F3.
      if (f4Candidate > 0) { this.smoothF4 = this._kalmanUpdate(this._kalmanF4, f4Candidate, R); this._f4Age = 0; }
      this.formantConfidence += (conf - this.formantConfidence) * 0.15;

      // --- Formant dispersion (ΔF) -> apparent vocal-tract length gender cue ---
      // Computed BEFORE the resonance score, not after: ΔF is the score's largest single term,
      // and updating it afterwards meant every frame's resonance was built on the previous
      // frame's tract-length estimate (and, on the first voiced frame of a session, on 0).
      //
      // Stale formants are withheld rather than passed in frozen — the fit then falls back to
      // the F1/F2 pair, which is a real (if noisier) measurement, instead of a value the mic
      // never produced. fitQuality reports how well the surviving formants actually lie on a
      // uniform-tube series; a frame that fits no tube gets its ΔF down-weighted below.
      const dispFit = fitFormantDispersion([
        this._f1Age <= FORMANT_STALE_FRAMES ? this.smoothF1 : 0,
        this._f2Age <= FORMANT_STALE_FRAMES ? this.smoothF2 : 0,
        this._f3Age <= FORMANT_STALE_FRAMES ? this.smoothF3 : 0,
      ]);
      this.dispersionFitQuality = dispFit.fitQuality;
      this.dispersionFormantsUsed = dispFit.n;
      if (dispFit.deltaF > 0) {
        // Goodness-of-fit joins confidence and steadiness in the EMA step, so a frame whose
        // formants don't describe a plausible tract nudges ΔF instead of moving it.
        const dispRate = (0.05 + conf * 0.08) * this.formantSteadiness * (0.25 + 0.75 * dispFit.fitQuality);
        this.formantDispersionHz = this.formantDispersionHz > 0
          ? this.formantDispersionHz + (dispFit.deltaF - this.formantDispersionHz) * dispRate
          // Seed on the first usable fit rather than crawling up from 0. Starting at zero meant
          // ΔF spent the opening seconds of a session far below any real vocal tract, which
          // clamped vtlScore — the 55% term — to a constant 0 for that whole stretch.
          : dispFit.deltaF;
      }

      // --- Resonance score: aVTL-primary, with F1 and gated F2 ---
      // Primary: apparent vocal-tract length from formant dispersion (ΔF), fitted across F1–F3,
      // which is steadier across vowels than raw F2 alone.
      //
      // NOT vowel-robust, and this comment used to claim it was. Measured against Peterson &
      // Barney adult-male means fed as ground truth (no estimator, no noise, no smoothing), one
      // nominal tract's apparent length ranges 13.8 cm (/i/) to 21.7 cm (/u/) and this score
      // swings 73 points across the vowel set — while the male→female norm shift moves it 23.
      // Vowel identity moves the reading about three times more than speaker sex does. Praat's
      // own documentation says the same independently. Decomposing scale from shape is
      // docs/RESONANCE_REDESIGN.md Phase 1; nothing here changes it yet.
      //
      // Anchors: aVTL 17 cm → score 0 (longer tract, darker), 14 cm → score 1 (shorter tract,
      // brighter). These are tract-length anchors, not male/female anchors: F0 and formants
      // overlap substantially between gender groups, and ASHA is explicit that there is no
      // single acoustic definition of a feminine or masculine voice.
      const aVTL_cm = this.formantDispersionHz > 0 ? 35000 / (2 * this.formantDispersionHz) : 0;
      const rp = this.resonanceProfile;
      let vtlScore, f1Score, f2Score;
      if (rp.isLearned) {
        // Personal calibration: each sub-score is normalized against THIS speaker's own
        // learned span (brighter = wider dispersion, higher F1, higher F2), so 0%/100% mean
        // their darkest/brightest instead of population anchors. This is what lets a voice
        // that reads a flat ~65% on the fixed anchors actually travel the full 0–100 range.
        vtlScore = this.formantDispersionHz > 0
          ? normalizeAgainstRange(this.formantDispersionHz, rp.dispMin, rp.dispMax)
          : 0;
        f1Score = normalizeAgainstRange(this.smoothF1, rp.f1Min, rp.f1Max);
        f2Score = this.vowelLikelihood > 0.4
          ? normalizeAgainstRange(this.smoothF2, rp.f2Min, rp.f2Max)
          : vtlScore;
      } else {
        // Fixed-anchor fallback — the pre-calibration behaviour the golden eval asserts on.
        // Anchors: 17 cm (longer/darker, score 0) → 14 cm (shorter/brighter, score 1). The
        // arithmetic now lives in resonanceScoreV1() so the d′ benchmark scores Peterson &
        // Barney means through the function users actually see, not a copy of it; the terms,
        // the clamp order and the 55/25/20 weights are unchanged.
        //
        // F1 (25%): higher F1 reads brighter/more open. It is also one of the two formants
        // that *define the vowel*, so much of this term's movement is vowel identity rather
        // than tract configuration — and it has already been counted once inside vtlScore's
        // ΔF fit. That double count is what §1.4 measures and what v2 below removes.
        // F2 (20%): only when a vowel-like frame is detected; otherwise it folds into
        // vtlScore to avoid penalising back vowels (/u/ F2 ≈ 1000 Hz).
        ({ vtlScore, f1Score, f2Score } = resonanceScoreV1({
          deltaFHz: this.formantDispersionHz,
          f1: this.smoothF1,
          f2: this.smoothF2,
          vowelLike: this.vowelLikelihood > 0.4,
        }));
      }
      const rawResonance = vtlScore * 0.55 + f1Score * 0.25 + f2Score * 0.20;
      // Steady-state weight scales the EMA step: held vowels move the score quickly toward
      // their reading; transition frames only nudge it (floor), so the live number settles on
      // vowel targets rather than chasing onsets/glides.
      this.smoothResonance += (rawResonance - this.smoothResonance) * (0.05 + conf * 0.08) * this.formantSteadiness;

      // ================= resonanceAbsolute v2 — instrumented only ==================
      // docs/RESONANCE_REDESIGN.md §5. Computed every frame beside v1 and displayed
      // nowhere: `smoothResonance` above is still the number the ball, HUD, haptics,
      // gender score, necklace and bulb read. Nothing below writes to it.
      //
      // Phase 3 moved this out of line and off the active estimator. It now runs on the
      // canonical LPC solve and its own Kalman filters, so nothing in it can be moved by
      // which estimator the room's noise selected — see _updateResonanceV2.
      this._updateResonanceV2(canonical, pitch, pitchDevSt, dt);
      // ============================ end v2 ========================================

      // --- ADAPTIVE RESONANCE RANGE LEARNING ---
      // Collect F1 / F2 / dispersion from clean, steady, vowel-like frames over the first few
      // seconds of voicing, then fix the personal 0–100% span from robust percentiles. Mirrors
      // the pitch/tilt learners; kept off the golden path because a short clip reaches neither
      // the time nor the sample threshold (so the fixed-anchor branch above still runs there).
      if (!rp.isLearned && conf > 0.4 && this.formantSteadiness > 0.5 &&
          this.vowelLikelihood > 0.4 && this.smoothF1 > 0 && this.smoothF2 > 0 && this.formantDispersionHz > 0) {
        rp.samples.push({ f1: this.smoothF1, f2: this.smoothF2, disp: this.formantDispersionHz });
        rp.voicedTime += dt;
        if (rp.voicedTime >= rp.learningDuration || rp.samples.length > 200) {
          this._learnResonanceRange();
        }
      }

      // --- Cepstral Peak Prominence (breathiness) — every Nth frame for cost control ---
      this._cppFrameCounter = (this._cppFrameCounter + 1) % 6;
      if (this._cppFrameCounter === 0 && pitch > 0) {
        // Decimate the log spectrum by 2 to halve the DCT cost. The quefrency of F0
        // (q0 = sampleRate/F0) is invariant to spectral resolution, so this is safe down
        // to ~55 Hz as long as the cepstrum is long enough to hold q0.
        const src = this.frequencyData;
        const half = src.length >> 1;
        if (!this._cppSpectrum || this._cppSpectrum.length !== half) {
          this._cppSpectrum = new Float64Array(half);
        }
        const dec = this._cppSpectrum;
        for (let i = 0; i < half; i++) dec[i] = (src[2 * i] + src[2 * i + 1]) * 0.5;
        const q0 = this.audioCtx.sampleRate / pitch; // quefrency (lag in samples) of F0
        const maxQ = Math.min(half - 1, Math.ceil(this.audioCtx.sampleRate / 55));
        const cepstrum = computeCepstrum(dec, maxQ);
        const rawCpp = computeCPP(cepstrum, q0);
        if (rawCpp > 0) {
          this.cppDb += (rawCpp - this.cppDb) * 0.2;
          this.cppConfidence += (Math.min(1, this.pitchConfidence) - this.cppConfidence) * 0.2;
        }
      }
    } else {
      this.cppConfidence *= 0.9;
      // During silence/unvoiced: decay confidence, coast Kalman filters on prediction
      this.formantConfidence *= 0.95;
      if (this._kalmanF1 && this._kalmanF1.initialized) {
        this.smoothF1 = this._kalmanUpdate(this._kalmanF1, this.smoothF1, 1e6); // large R = ignore measurement
      }
      if (this._kalmanF2 && this._kalmanF2.initialized) {
        this.smoothF2 = this._kalmanUpdate(this._kalmanF2, this.smoothF2, 1e6);
      }
      if (this._kalmanF3 && this._kalmanF3.initialized) {
        this.smoothF3 = this._kalmanUpdate(this._kalmanF3, this.smoothF3, 1e6);
      }
      // PHASE 3: past a real pause, the canonical stream stops reading rather than holding its
      // last value. v1 coasts because a coasting displayed number is what it has always done and
      // its output may not move; v2 has no such obligation, and §5 is explicit that below the
      // floor the app shows NO resonance rather than a substitute — a value from before a pause
      // presented as a live one is exactly the substitute that forbids.
      //
      // BUT ONLY PAST A REAL PAUSE. Connected speech is full of unvoiced frames inside words —
      // stop closures, fricatives, the gap between two syllables — and clearing on every one of
      // them is not honesty, it is a stutter: measured on the Rainbow Passage it cut the vowel
      // yield from 87.0% to 57.6% by making the pooling window restart at every consonant. The
      // formants age on exactly the bound the scale fit already uses, and the reading is cleared
      // when they have all gone stale, which is ~0.2 s of continuous non-phonation.
      this._canF1Age++; this._canF2Age++; this._canF3Age++; this._canF4Age++;
      this.canonicalConfidence *= 0.95;
      if (this._canF1Age > FORMANT_STALE_FRAMES && this._canF2Age > FORMANT_STALE_FRAMES
        && this._canF3Age > FORMANT_STALE_FRAMES && this._canF4Age > FORMANT_STALE_FRAMES) {
        this._decayCanonicalStream();
      }
    }

    // ====== METRICS ======

    // 1. BOUNCE — pitch variation in semitones relative to modal F0.
    // Using semitones instead of Hz means the score is invariant to the user's absolute pitch:
    // the same expressive range sounds the same whether produced by a bass or a soprano.
    if (this.pitchHistory.length > 3 && this.modalF0Hz > 0) {
      const fRef = this.modalF0Hz;
      const len = this.pitchHistory.length;
      let stSum = 0;
      for (let i = 0; i < len; i++) stSum += 12 * Math.log2(this.pitchHistory[i] / fRef);
      const stMean = stSum / len;
      let stSqSum = 0;
      for (let i = 0; i < len; i++) {
        const d = 12 * Math.log2(this.pitchHistory[i] / fRef) - stMean;
        stSqSum += d * d;
      }
      this.metrics.bounce = clamp01(Math.sqrt(stSqSum / len) / INTONATION_ST_DIVISOR);
    } else {
      this.metrics.bounce *= 0.95;
    }

    // Pre-calculate robust baseline for dynamic thresholding across metrics
    const baseEnergyRange = Math.max(0.001, this.energyPercentiles.p90 - this.energyPercentiles.p50);



    // 3. VOWEL ELONGATION — sustained voicing WITH vowel-like formants
    //    Uses vowelLikelihood to distinguish real vowels from "sss" or "mmm".
    //    Mode detection: track recent voiced-segment lengths. If the median is long (>0.5 s)
    //    we're in diagnostic/sustain mode; short segments → connected speech mode with
    //    faster onset/saturation so natural conversational pacing can reach 1.0.
    const dynamicSustainThreshold = this.energyPercentiles.p50 + baseEnergyRange * VOWEL_SUSTAIN_MULT;
    const isVoiced = pitch > 0 && gatedRms > dynamicSustainThreshold;
    // Update phonation duration ring buffer when a voiced segment ends.
    if (isVoiced && this._currentPhonationStart < 0) {
      this._currentPhonationStart = now;
    } else if (!isVoiced && this._currentPhonationStart >= 0) {
      const segDur = now - this._currentPhonationStart;
      this._phonationDurations.push(segDur);
      if (this._phonationDurations.length > this._phonationDurMax) this._phonationDurations.shift();
      this._currentPhonationStart = -1;
    }
    // Choose timing constants based on typical phonation length.
    let vowelOnset = VOWEL_ONSET_SECS;
    let vowelSat = VOWEL_SATURATION_SECS;
    let vowelDecay = VOWEL_DECAY_RATE;
    if (this._phonationDurations.length >= 4) {
      const sorted = [...this._phonationDurations].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median < 0.5) {
        vowelOnset = VOWEL_CONNECTED_ONSET_SECS;
        vowelSat = VOWEL_CONNECTED_SATURATION_SECS;
        vowelDecay = VOWEL_CONNECTED_DECAY_RATE;
      }
    }
    const isVowelSound = isVoiced && this.vowelLikelihood > 0.3;
    if (isVowelSound) {
      this.sustainedDuration += dt * (0.5 + this.vowelLikelihood * 0.5); // stronger vowels accumulate faster
    } else {
      this.sustainedDuration *= vowelDecay;
    }
    this.metrics.vowel = Math.min(1, Math.max(0, this.sustainedDuration - vowelOnset) / vowelSat);

    // 4. ARTICULATION — HF bursts (adaptive ceiling from running HF percentiles)
    const hfCeiling = this.hfEnergyWindow.length >= 8
      ? Math.max(this.hfPercentiles.p90, this.hfNoiseFloor + 0.02)
      : Math.max(this.hfNoiseFloor + 0.02, this.hfNoiseFloor * 3.5);
    // Smoothed toward a *gated* target further down, once this frame's reliability gates
    // are known — see the articulation update below computeFrameReliability().
    const articTarget = normalizeAgainstPercentiles(hfEnergy, this.hfNoiseFloor, hfCeiling, ARTIC_SENSITIVITY_GAIN);

    // Energy rise rate (per second) — feeds the Vocal Attack onset-hardness metric.
    const riseRate = Math.max(0, gatedRms - this.prevGatedRms) / Math.max(1e-3, dt);
    this.prevGatedRms = gatedRms;

    // 5. SYLLABLE SEPARATION — energy onset detection (uses gated energy)
    const dynamicSyllableOn = this.energyPercentiles.p50 + baseEnergyRange * SYLLABLE_ON_MULT;
    const dynamicSyllableOff = this.energyPercentiles.p50 + baseEnergyRange * SYLLABLE_OFF_MULT;
    const syllableOnThreshold = Math.max(0.005, dynamicSyllableOn);
    const syllableOffThreshold = Math.max(0.002, dynamicSyllableOff);
    if (gatedRms > syllableOnThreshold && this.syllableState === 'silent') {
      if (now - this.lastSyllableTime > SYLLABLE_DEBOUNCE_SECS) {
        this.lastSyllableTime = now;
        this.syllableImpulse = 1.0;
        // Open the vocal-attack capture window at this phonation onset.
        this.attackWindowTimer = 0;
        this.attackRisePeak = riseRate;
        this.attackPeakTime = 0;
      }
      this.syllableState = 'voiced';
    } else if (gatedRms < syllableOffThreshold) {
      this.syllableState = 'silent';
    }
    this.syllableImpulse *= SYLLABLE_IMPULSE_DECAY;

    // 6. VOCAL ATTACK — onset hardness from the peak energy-rise rate at phonation
    //    onset. Steep rise = hard/glottal (→1); gradual rise = soft/breathy (→0).
    if (this.attackWindowTimer >= 0) {
      this.attackWindowTimer += dt;
      if (riseRate > this.attackRisePeak) {
        this.attackRisePeak = riseRate;
        this.attackPeakTime = this.attackWindowTimer;
      }
      if (this.attackWindowTimer >= ATTACK_RISE_WINDOW_SECS) {
        // Train the ceiling only on reliably-voiced onsets, so coughs, mic bumps, or
        // unvoiced bursts can't ratchet it up and de-sensitize real phonation onsets.
        if (this.pitchConfidence > 0.35 || this.formantConfidence > 0.35) {
          const k = this.attackRisePeak > this.attackRiseCeiling ? 0.30 : ATTACK_RISE_LEARN_RATE;
          this.attackRiseCeiling += (this.attackRisePeak - this.attackRiseCeiling) * k;
        }
        // Breathiness refinement: breathy onsets (poor pitch lock, HF-noisy) read softer.
        const cleanliness = clamp01(this.pitchConfidence) *
                            (1 - 0.5 * clamp01(this.metrics.articulation));
        // Onset abruptness: impulsive onsets peak at the very start of the capture window
        // (→1), gradual/breathy onsets peak later within it (→0).
        const onsetAbruptness = 1 - clamp01(this.attackPeakTime / ATTACK_RISE_WINDOW_SECS);
        const hardness = computeAttackHardness({
          risePeak: this.attackRisePeak,
          riseCeiling: this.attackRiseCeiling,
          cleanliness,
          onsetAbruptness,
          abruptWeight: ATTACK_ABRUPT_BLEND
        });
        this.attackImpulse = Math.max(this.attackImpulse, hardness);
        // Latch the two sub-cues for the Attack-mode display (does NOT affect metrics.attack):
        // rise-rate hardness (steepness of the energy onset) vs onset abruptness (timing).
        this.attackRiseHardness = clamp01(this.attackRisePeak / Math.max(1e-6, this.attackRiseCeiling));
        this.attackAbruptness = onsetAbruptness;
        this.attackWindowTimer = -1; // close window
      }
    }
    this.attackImpulse *= ATTACK_IMPULSE_DECAY;
    this.metrics.attack = this.attackImpulse;

    const voicedStrength = normalizeAgainstPercentiles(gatedRms, this.energyPercentiles.p50, this.energyPercentiles.p90, 1);
    const pitchGate = pitch > 0 ? 1 : 0.35;
    const reliability = computeFrameReliability({
      pitchConfidence: this.pitchConfidence,
      formantConfidence: this.formantConfidence,
      voicedStrength,
      spectralTiltConfidence: this.spectralTiltConfidence,
      snrConfidence: this.snrConfidence,
      wasLastFrameReliable: this.wasLastFrameReliable
    });
    const { voicedGate } = reliability;
    // A frame the speech gate rejected is not merely low-confidence, it is the
    // wrong kind of sound — so it is forced unreliable outright rather than
    // being blended in at reduced weight.
    const reliableFrame = reliability.reliableFrame && this.isSpeechFrame;
    const confidenceGate = this.isSpeechFrame ? reliability.confidenceGate : 0;
    this.wasLastFrameReliable = reliableFrame;

    // Stricter confidence gating
    if (!reliableFrame && gatedRms < this.energyPercentiles.p75) {
      // Freeze/slow-decay updates when signal is muddy or user is breathing
      this.metrics.bounce *= 0.95;
    } else {
      this.metrics.bounce *= confidenceGate * pitchGate;
    }

    // Articulation eases toward the gated target. The gate is applied to the TARGET, not to
    // the smoothed value: multiplying the EMA state itself each frame compounded, settling at
    // 0.3·T·g/(1−0.7g) instead of g·T — roughly 40-70% of the intended level even on clean
    // frames, which quietly drained the prosody score (and with it the ball's saturation).
    const articGate = Math.max(0.25, voicedGate * 0.8 + confidenceGate * 0.2);
    this.metrics.articulation += (articTarget * articGate - this.metrics.articulation) * 0.3;
    this.metrics.attack *= Math.max(0.2, voicedGate);

    const pitchRange = Math.max(50, this.pitchProfile.max - this.pitchProfile.min);
    // pitchEffort: position within the user's own adaptive range — hygiene/practice feedback only.
    this.metrics.pitchEffort = pitch > 0 ? Math.max(0, Math.min(1, (pitch - this.pitchProfile.min) / pitchRange)) : this.metrics.pitchEffort * 0.95;
    // Legacy alias so existing UI reads of metrics.pitch still work.
    this.metrics.pitch = this.metrics.pitchEffort;
    // pitchZone: absolute position across the F0 range where perceived gender shifts
    // (110 Hz → 230 Hz), independent of the user's own range. 0 = the low end of that range,
    // 1 = the high end. F0 is the strongest single predictor of perceived gender, but the
    // distributions overlap substantially, so a position on this axis is a tendency, not a
    // verdict about a speaker.
    if (this.modalF0Hz > 0) {
      this.metrics.pitchZone = clamp01((this.modalF0Hz - 110) / 120);
      const hz = this.modalF0Hz;
      this.pitchZoneLabel = hz < 145 ? 'Masculine'
        : hz < 175 ? 'Ambiguous'
        : hz < 180 ? 'Transitional'
        : 'Feminine';
    }
    this.metrics.energy = normalizeAgainstPercentiles(gatedRms, this.energyPercentiles.p50, this.energyPercentiles.p90, 1.1);
    // §4: the ball, HUD and haptics read CONTROL. `metrics.resonance` is the shared bus every
    // presentation surface hangs off, so this one assignment is where v1 stops being displayed.
    // It is `null` on a frame with no reading — every consumer tests for it (there is no 0 that
    // means "nothing", because 0 is a real position on this axis).
    this.metrics.resonance = this.resonanceControl;

    // 7. WEIGHT — perceived heaviness (1=heavy/thick, 0=light/breathy). Source-only cues only;
    //    F2 (a filter/resonance property) has been removed to avoid cross-contamination.
    //    Tilt 45% + CPP 30% + H1-H2 25%.
    const heavinessTilt = 1 - this.spectralWeight;
    // CPP: higher CPP = more periodic/pressed (heavier); lower = breathier (lighter).
    // Anchors: 6 dB (breathy/light) → 14 dB (modal-pressed/heavy).
    const cppHeaviness = clamp01((this.cppDb - 6) / 8);
    const cppW = WEIGHT_CPP_BLEND * this.cppConfidence;
    // H1-H2 breathiness cue → lightness; only blended in when a clean F0 gives a trustworthy estimate.
    const h1h2Light = normalizeAgainstRange(this.h1h2SmoothedDb, H1H2_HEAVY_DB, H1H2_LIGHT_DB);
    const weightTarget = computeWeightTarget({
      tiltHeaviness: heavinessTilt,
      tiltWeight: WEIGHT_TILT_BASE,
      h1h2Heaviness: 1 - h1h2Light,
      h1h2Weight: WEIGHT_H1H2_BLEND * this.h1h2Confidence,
      cppHeaviness,
      cppWeight: cppW,
    });
    // Only move while tilt is trustworthy, so the metric holds its last value rather
    // than drifting toward "light" during silence or noisy low-confidence frames.
    if (this.spectralTiltConfidence > 0.2) {
      this.weightSmoothed += (weightTarget - this.weightSmoothed) * (WEIGHT_SMOOTH_BASE + this.spectralTiltConfidence * 0.18);
    }
    this.metrics.weight = this.weightSmoothed;

    // Expose overall frame confidence so the game loop can gate the prosody score.
    // The 0.15 floor keeps the ball responsive through ordinary unreliable frames;
    // a gate-rejected frame gets 0 instead, because that floor is what would let a
    // running fan keep nudging the meters all session.
    this.frameConfidence = reliableFrame ? confidenceGate : (this.isSpeechFrame ? 0.15 : 0);
  }

  // The Phase-2 session summary (docs/RESONANCE_REDESIGN.md §5), in both aggregation modes.
  //
  // Still instrumented only, and still deliberately not rendered — §6's second risk is that the
  // decomposition leaks into the UI, and one ring means one number on the summary card too.
  // Phase 4 switched that card from v1 to the plain mean of `resonanceControl`, which is the
  // scale the ring showed while the user was speaking. What the two aggregation modes are FOR is
  // a cross-session comparison this app does not yet persist; when it does, this is the call
  // that provides it, on the absolute axis, in speech mode.
  //
  // §5 says session statistics use SPEECH mode and the ball keeps EXERCISE mode, so both are
  // returned from one call over one frame stream: reading them from two places is how they
  // would end up computed over two different sets of frames and then compared as though they
  // were not.
  resonanceV2Summary() {
    return {
      absolute: {
        exercise: this.v2Aggregator.exercise(),
        speech: this.v2Aggregator.speech(),
      },
      f2Position: {
        exercise: this.f2PositionAggregator.exercise(),
        speech: this.f2PositionAggregator.speech(),
      },
    };
  }

  // Fix the personal resonance span from the collected held-vowel samples. Each axis uses a
  // robust p05–p95 range (drops octave-jump/outlier frames) with a minimum-spread floor so a
  // monotone setup can't collapse the scale, then pads ±25% of the spread outward. The padding
  // maps the user's natural setup voice to roughly the middle 17–83% of the meter, leaving
  // headroom at both ends so deliberately darkening or brightening still travels toward 0/100
  // — which is exactly what "it won't go below 60%" was missing.
  _learnResonanceRange() {
    const rp = this.resonanceProfile;
    const col = (key) => rp.samples.map((s) => s[key]);
    const f1 = fitPersonalRange(col('f1'), { floorSpread: 150, absMin: 150, absMax: 1400 });
    const f2 = fitPersonalRange(col('f2'), { floorSpread: 300, absMin: 700, absMax: 3200 });
    const disp = fitPersonalRange(col('disp'), { floorSpread: 150, absMin: 600, absMax: 1800 });
    if (!f1 || !f2 || !disp) return; // no usable samples — stay on the fixed-anchor fallback
    rp.f1Min = f1.min; rp.f1Max = f1.max;
    rp.f2Min = f2.min; rp.f2Max = f2.max;
    rp.dispMin = disp.min; rp.dispMax = disp.max;
    rp.isLearned = true;
    console.log(`[ProsodyBall] Learned User Resonance Range — F1 ${rp.f1Min.toFixed(0)}–${rp.f1Max.toFixed(0)} Hz, F2 ${rp.f2Min.toFixed(0)}–${rp.f2Max.toFixed(0)} Hz, ΔF ${rp.dispMin.toFixed(0)}–${rp.dispMax.toFixed(0)} Hz`);
  }

  // ============================================
  // RESONANCE METHOD A: Harmonic Envelope (Refined)
  // Samples FFT at harmonics of F0 to extract the vocal tract transfer function.
  // Improvements over v1:
  //  - 5-point Gaussian-weighted envelope smoothing (better noise rejection)
  //  - Parabolic interpolation of FREQUENCY at envelope peaks (sub-harmonic resolution)
  //  - Spectral tilt compensation (removes ~6 dB/octave glottal source rolloff)
  //  - F3 estimation for additional resonance information
  // ============================================
  _resonanceHarmonicEnvelope(pitch) {
    const fmtData = this.formantFreqData;
    const f0 = pitch;
    const binHz = this.audioCtx.sampleRate / this.analyserFormant.fftSize;
    const maxHarmonicHz = 5500;
    const numHarmonics = Math.min(40, Math.floor(maxHarmonicHz / f0));

    if (numHarmonics < 4) return { f1: 0, f2: 0, f3: 0, confidence: 0 };

    // Sample FFT at each harmonic with peak-search and parabolic amplitude interpolation
    const harmonicAmps = this._getBuffer('harmonicAmps', Float32Array, numHarmonics);
    for (let h = 0; h < numHarmonics; h++) {
      const hFreq = f0 * (h + 1);
      const bin = hFreq / binHz;
      const binInt = Math.floor(bin);
      if (binInt < 1 || binInt + 1 >= fmtData.length) continue;

      // Search ±30% of harmonic spacing for actual peak
      let peakBin = binInt, peakVal = fmtData[binInt];
      const searchRange = Math.max(1, Math.floor(f0 / binHz * 0.3));
      for (let s = -searchRange; s <= searchRange; s++) {
        const idx = binInt + s;
        if (idx >= 0 && idx < fmtData.length && fmtData[idx] > peakVal) {
          peakVal = fmtData[idx]; peakBin = idx;
        }
      }
      // Parabolic interpolation for sub-bin amplitude
      if (peakBin > 0 && peakBin < fmtData.length - 1) {
        const a = fmtData[peakBin - 1], b = fmtData[peakBin], c = fmtData[peakBin + 1];
        const denom = a - 2 * b + c;
        harmonicAmps[h] = Math.abs(denom) > 0.001 ? b - (a - c) * (a - c) / (8 * denom) : b;
      } else {
        harmonicAmps[h] = peakVal;
      }
    }

    // Spectral tilt compensation: +6 dB/octave to counteract glottal source rolloff
    // This prevents F1 from always dominating F2 in the envelope
    for (let h = 0; h < numHarmonics; h++) {
      const hFreq = f0 * (h + 1);
      harmonicAmps[h] += 6 * Math.log2(hFreq / f0); // +6 dB per octave
    }

    // 5-point Gaussian-weighted smoothing (σ ≈ 1.0 harmonics)
    const gWeights = [0.06, 0.24, 0.40, 0.24, 0.06];
    const env = this._getBuffer('env', Float32Array, numHarmonics);
    for (let i = 0; i < numHarmonics; i++) {
      let sum = 0, wSum = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j >= 0 && j < numHarmonics) {
          sum += harmonicAmps[j] * gWeights[k + 2];
          wSum += gWeights[k + 2];
        }
      }
      env[i] = sum / wSum;
    }

    return this._peakPickFormants(env, f0, numHarmonics);
  }

  // ============================================
  // RESONANCE METHOD B: Cepstral Smoothing (Refined)
  // True cepstral-style spectral envelope extraction.
  // Improvements over v1:
  //  - Window width = 1.5× harmonic spacing (fully suppresses harmonic ripple)
  //  - Spectral tilt pre-compensation (+6 dB/oct before smoothing)
  //  - Parabolic interpolation at spectral peaks for sub-bin accuracy
  //  - Proper triangular weighting kernel (better sidelobe rejection vs box filter)
  // ============================================
  _resonanceCepstral(pitch) {
    const fmtData = this.formantFreqData;
    const binHz = this.audioCtx.sampleRate / this.analyserFormant.fftSize;
    const numBins = fmtData.length;

    // 1.5× harmonic spacing fully fills gaps between harmonics
    const smoothWidth = Math.max(5, Math.round(1.5 * pitch / binHz));
    const halfW = Math.floor(smoothWidth / 2);

    // Pre-pass: spectral tilt compensation (+6 dB/octave relative to F0)
    // Applied BEFORE smoothing so it isn't diluted by the averaging kernel.
    // This counteracts the natural glottal source rolloff that makes F2/F3
    // peaks appear 6-12 dB weaker than F1 in the raw spectrum.
    const tiltComp = this._getBuffer('tiltComp', Float32Array, numBins);
    for (let i = 0; i < numBins; i++) {
      const freq = i * binHz;
      tiltComp[i] = fmtData[i] + (freq > pitch ? 6 * Math.log2(freq / pitch) : 0);
    }

    // Triangular kernel smoothing on tilt-compensated spectrum
    // Triangular shape: center-weighted, zero at edges — better sidelobe
    // rejection than a box filter, cleaner envelope extraction
    const smoothed = this._getBuffer('smoothed', Float32Array, numBins);
    for (let i = 0; i < numBins; i++) {
      let sum = 0, wSum = 0;
      for (let j = i - halfW; j <= i + halfW; j++) {
        if (j >= 0 && j < numBins) {
          const dist = Math.abs(j - i);
          const triWeight = 1 - dist / (halfW + 1);
          sum += tiltComp[j] * triWeight;
          wSum += triWeight;
        }
      }
      smoothed[i] = sum / wSum;
    }

    // Peak-pick with parabolic interpolation
    const minF1Hz = 200, maxF1Hz = 1100;
    const minF2Hz = 600, maxF2Hz = 3500;
    const minF3Hz = 2200, maxF3Hz = 4200;
    const minSepHz = 300;

    let f1 = 0, f1Amp = -Infinity;
    let f2 = 0, f2Amp = -Infinity;
    let f3 = 0, f3Amp = -Infinity;

    // Collect all peaks with parabolic refinement
    const peaks = [];
    const f1Start = Math.max(2, Math.floor(minF1Hz / binHz));
    const f3End = Math.min(Math.ceil(maxF3Hz / binHz), numBins - 2);
    for (let i = f1Start; i <= f3End; i++) {
      if (smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1]) {
        // Parabolic interpolation for sub-bin frequency
        const a = smoothed[i - 1], b = smoothed[i], c = smoothed[i + 1];
        const denom = a - 2 * b + c;
        let refinedBin = i;
        let refinedAmp = b;
        if (Math.abs(denom) > 0.001) {
          const delta = 0.5 * (a - c) / denom;
          refinedBin = i + Math.max(-0.5, Math.min(0.5, delta));
          refinedAmp = b - (a - c) * (a - c) / (8 * denom);
        }
        peaks.push({ freq: refinedBin * binHz, amp: refinedAmp });
      }
    }

    // Assign peaks to F1, F2, F3
    for (const p of peaks) {
      if (p.freq >= minF1Hz && p.freq <= maxF1Hz && p.amp > f1Amp) {
        f1Amp = p.amp; f1 = p.freq;
      }
    }
    const f2Floor = Math.max(minF2Hz, f1 + minSepHz);
    for (const p of peaks) {
      if (p.freq >= f2Floor && p.freq <= maxF2Hz && p.amp > f2Amp) {
        f2Amp = p.amp; f2 = p.freq;
      }
    }
    const f3Floor = Math.max(minF3Hz, f2 + minSepHz);
    for (const p of peaks) {
      if (p.freq >= f3Floor && p.freq <= maxF3Hz && p.amp > f3Amp) {
        f3Amp = p.amp; f3 = p.freq;
      }
    }

    // Confidence
    const specSlice = smoothed.subarray(f1Start, f3End + 1);
    let specMin = 0, specRange = 0;
    if (specSlice.length > 0) {
      specMin = specSlice[0]; let specMax = specSlice[0];
      for (let i = 1; i < specSlice.length; i++) {
        if (specSlice[i] < specMin) specMin = specSlice[i];
        if (specSlice[i] > specMax) specMax = specSlice[i];
      }
      specRange = specMax - specMin;
    }
    let conf = 0;
    if (specRange > 1) {
      const f1P = f1 > 0 ? Math.min(1, (f1Amp - specMin) / specRange) : 0.1;
      const f2P = f2 > 0 ? Math.min(1, (f2Amp - specMin) / specRange) : 0.1;
      conf = formantEstimateConfidence({
        structure: (f1P + f2P) / 2,
        gain: FORMANT_CONF_GAIN.cepstral,
        pitchConfidence: this.pitchConfidence,
        vowelLikelihood: this.vowelLikelihood,
      });
    }
    // `measured` is the pre-default vector, added for Phase 3's cross-check. A defaulted
    // 500/1500 Hz is not a measurement, and a cross-check that compared against one would be
    // scoring the canonical estimator against a constant.
    const measured = [f1, f2, f3, 0];
    if (f1 === 0) f1 = 500;
    if (f2 === 0) f2 = 1500;

    return { f1, f2, f3, confidence: conf, measured };
  }

  // ==========================================================================
  // PHASE 3 — THE CANONICAL RESONANCE PATH (docs/RESONANCE_REDESIGN.md §5)
  // ==========================================================================
  //
  // Everything the v2 stream reports is computed here, from one estimator, with its own
  // continuity filters and its own confidence. `resonanceMethod` does not reach this method at
  // all. That is the whole of §5's first bullet — "LPC becomes the single scale-defining
  // estimator; selectResonanceMethod no longer swaps the measurement" — and it is why the
  // between-method spread on the v2 stream is not small but exactly zero: there is no branch
  // for the estimator identity to take.
  //
  // Still instrumented only. v1's smoothResonance remains the sole displayed number, and §6's
  // "the user should still see one ring" is not relaxed by any of this.

  // Memoised LPC solve, keyed on (frame, ceiling). The canonical path and v1's `lpc` case share
  // one solve whenever they want the same ceiling, which is the uncalibrated default — so the
  // common case costs exactly what it cost before Phase 3.
  _lpcAtCeiling(ceilingHz) {
    if (this._lpcCacheFrame === this._resFrameSeq && this._lpcCacheCeiling === ceilingHz) {
      return this._lpcCache;
    }
    const r = this._resonanceLPC({ ceilingHz });
    this._lpcCacheFrame = this._resFrameSeq;
    this._lpcCacheCeiling = ceilingHz;
    this._lpcCache = r;
    this._lpcSolveCount++;      // read by tools/estimator-budget.mjs; §5 requires the cost measured
    return r;
  }

  // Which of the solve's two assignments the canonical measurement reads. Both come from the
  // SAME pole list and the same LPC solve, so this is a choice between two readings of one
  // measurement, never a second solve.
  //
  // A THIRD VARIANT WAS CONSIDERED AND ABANDONED, recorded because the reason is a real limit
  // rather than a preference. Restricting the widened slot to poles corroborated by F4 is a
  // physical claim, not a threshold — a rhotic constriction lowers F3 toward F2 and leaves F4
  // where it was, so a genuine rhotic shows an unusually wide F3-F4 gap. It cannot be evaluated
  // here: the synthesized corpus places every vowel's F4 at 3.5·ΔF of THAT VOWEL'S OWN fit, so
  // the synthetic /ɝ/'s F4 has already been dragged down with its F3 and shows a gap of 1.09·ΔF
  // against the uniform tube's 1.00 — no separation at all. Fixing the fixture (F4 from the
  // SPEAKER's scale, which is what one tract length means) is defensible on its own, but doing
  // it in order to make a candidate pass is the thing this plan forbids. It is a Phase 5
  // question, on material where F4 is where a mouth put it.
  _selectCanonicalAssignment(canonical) {
    const standard = (canonical && canonical.measured) || [0, 0, 0, 0];
    if (this.canonicalAssignment !== 'rhotic') return standard;
    const rhotic = (canonical && canonical.measuredRhotic) || [0, 0, 0, 0];
    // The two assignments only differ when the widened slot found a pole below the standard
    // floor. Otherwise they are the same vector and there is nothing to choose between.
    const widened = rhotic[2] > 0 && rhotic[2] < F3_FLOOR_HZ && rhotic[0] > 0 && rhotic[1] > 0;
    return widened ? rhotic : standard;
  }

  _updateResonanceV2(canonical, pitchHz, pitchDevSt, frameSec) {
    // The MEASUREMENT runs on the standard assignment. The rhotic-capable one (same solve, same
    // poles, an F3 floor low enough for a rhotic to occupy the slot) is used further down as a
    // DETECTOR only, and only where ρ corroborates it — see the rhotic block. Using it as the
    // measurement is what the first attempt did and it does not survive measurement: it names
    // /ɝ/ where /ɝ/ is, but at F0 180 it also reads /ɔ/ as /ɝ/ on 47 frames in 67 and /ɪ/ on 35,
    // because at high F0 the pole set is sparse enough that something lands in the widened slot.
    // A confidently wrong vowel is the failure §6 names by name.
    const measured = this._selectCanonicalAssignment(canonical);
    const bandwidths = (canonical && canonical.bandwidths) || [];

    // ---- 1. FRAME VALIDITY (§5) ------------------------------------------------------
    // Five gates, each answering a different question, evaluated against the last VALID
    // observation of each formant rather than against the last frame — one rejected frame must
    // not become the reference a whole run of frames is then judged against.
    const validity = frameValidity(measured, {
      bandwidths,
      previous: this._lastValidRef,
      previousAgeFrames: this._lastValidRefAge,
      residual: canonical.modelResidual,
      // The caller's OWN frame interval, not an assumed one. The continuity bound is a velocity
      // in Hz/s, so it needs the elapsed time to become a step in Hz — and the app's harnesses
      // do not all run at 60 fps: fixtures/audio-eval/rainbow_passage.wav is 22.05 kHz, so the
      // 735-sample hop the reporting tools call "the live rate" is 33 ms there, half the rate
      // the rAF loop runs at on a 44.1 kHz context. Assuming 1/60 made the gate twice as strict
      // as intended on every fixture measurement.
      frameSec: frameSec > 0 ? frameSec : undefined,
    });
    // Fewer than two formants is ABSENCE, not invalidity, and is kept as its own category: a
    // gate that counted "nothing to check" as "checked and failed" would report a precision it
    // had not earned.
    this.frameValid = validity.valid;
    this.frameInvalidReasons = validity.nFormants < 2
      ? ['too-few-formants']
      : validity.failed.concat(validity.perFormant.flatMap((r, i) => r.map((x) => `F${i + 1}:${x}`)));
    // The formants this frame is allowed to contribute, with the poles that failed their own
    // gate withheld. A frame whose F3 jumped 900 Hz still has an F1 and an F2 worth having.
    const accepted = validity.accepted;
    // Instrumented for tools/frame-validity.mjs: the raw solve and what survived the gates.
    // Reporting a gate's precision and recall is impossible without both.
    this.canonicalRaw = measured;
    this.canonicalAccepted = accepted;
    this._validityHistory.push(this.frameValid ? 1 : 0);
    if (this._validityHistory.length > VALIDITY_HISTORY_FRAMES) this._validityHistory.shift();
    let vSum = 0;
    for (const v of this._validityHistory) vSum += v;
    this.validityRate = this._validityHistory.length ? vSum / this._validityHistory.length : 0;

    // Update the per-formant continuity reference AFTER judging this frame against it, and age
    // it out on the same bound the scale fit uses: a formant unseen for a fifth of a second is
    // not evidence about this one.
    if (validity.failed.length === 0) {
      for (let i = 0; i < 4; i++) {
        if (validity.accepted[i] > 0) { this._lastValidRef[i] = validity.accepted[i]; this._lastValidRefAge[i] = 0; }
      }
    }
    for (let i = 0; i < 4; i++) {
      if (++this._lastValidRefAge[i] > FORMANT_STALE_FRAMES) this._lastValidRef[i] = 0;
    }

    // ---- 2. Canonical steadiness ------------------------------------------------------
    // The same steadyStateWeight v1 uses, but computed from the CANONICAL formants. Reusing
    // v1's would make the canonical pool weights depend on the active estimator through the
    // back door, which is exactly the dependency this phase exists to cut.
    let canRelDelta = 0;
    if (this._prevCanF1 > 0 && this._prevCanF2 > 0 && measured[0] > 0 && measured[1] > 0) {
      canRelDelta = Math.abs(measured[0] - this._prevCanF1) / this._prevCanF1
                  + Math.abs(measured[1] - this._prevCanF2) / this._prevCanF2;
    }
    if (measured[0] > 0) this._prevCanF1 = measured[0];
    if (measured[1] > 0) this._prevCanF2 = measured[1];
    const canSteady = steadyStateWeight({ pitchSemitoneDev: pitchDevSt, formantRelDelta: canRelDelta });
    this.canonicalSteadiness += (canSteady - this.canonicalSteadiness) * 0.3;
    this.canonicalConfidence += ((canonical.confidence || 0) - this.canonicalConfidence) * 0.15;

    // ---- 3. Kalman continuity, with F0 IN THE MEASUREMENT NOISE (§5) -------------------
    // The physical fact this encodes: LPC places a formant from the harmonics that fall near
    // it, and as F0 rises the harmonics thin out and the pole is pulled toward whichever single
    // harmonic is nearest. The error grows with the spacing, and the spacing is F0. So the
    // variance rises as (F0/100 Hz)² — 4× the measurement variance at 200 Hz, which is the band
    // transfeminine users are training into and precisely where the app has been trusting its
    // formants as though nothing had changed.
    //
    // This is the ONLY place F0 enters the resonance measurement. It does not enter the SCORE:
    // a score that moved with pitch would be reporting pitch twice. It enters how far the
    // filter is willing to be moved by one frame, and how much the result is trusted.
    //
    // INVALID FRAMES DO NOT UPDATE THE FILTERS. That is what a validity gate is for; the
    // formant coasts on the prediction and ages toward being dropped from the fit. The yield
    // this costs is measured and reported (tools/frame-validity.mjs), not assumed away.
    const R = formantMeasurementNoise({
      confidence: canonical.confidence || 0,
      steadiness: this.canonicalSteadiness,
      methodTrust: RESONANCE_METHOD_TRUST.lpc,
      f0Hz: pitchHz,
    });
    this._canF1Age++; this._canF2Age++; this._canF3Age++; this._canF4Age++;
    if (validity.failed.length === 0) {
      // Frame-level failures (order, model residual, swap) reject the whole frame — there is no
      // single formant to blame. Formant-level failures reject only their own pole, which is
      // already reflected in `accepted`.
      if (accepted[0] > 0) { this.canonicalF1 = this._kalmanUpdate(this._kalmanCanF1, accepted[0], R); this._canF1Age = 0; }
      if (accepted[1] > 0) { this.canonicalF2 = this._kalmanUpdate(this._kalmanCanF2, accepted[1], R); this._canF2Age = 0; }
      if (accepted[2] > 0) { this.canonicalF3 = this._kalmanUpdate(this._kalmanCanF3, accepted[2], R); this._canF3Age = 0; }
      if (accepted[3] > 0) { this.canonicalF4 = this._kalmanUpdate(this._kalmanCanF4, accepted[3], R); this._canF4Age = 0; }
    }

    // ---- 4. Scale, pooled over the rolling window -------------------------------------
    const scaleInputs = [
      this._canF1Age <= FORMANT_STALE_FRAMES ? this.canonicalF1 : 0,
      this._canF2Age <= FORMANT_STALE_FRAMES ? this.canonicalF2 : 0,
      this._canF3Age <= FORMANT_STALE_FRAMES ? this.canonicalF3 : 0,
      this._canF4Age <= FORMANT_STALE_FRAMES ? this.canonicalF4 : 0,
    ];
    const scaleFit = fitFormantScale(scaleInputs);
    this.formantScaleFrameHz = scaleFit.deltaF;
    this.formantScaleFitQuality = scaleFit.fitQuality;
    this.formantScaleFormantsUsed = scaleFit.n;

    if (scaleFit.deltaF > 0 && this.frameValid) {
      this._scalePool.push({
        deltaF: scaleFit.deltaF,
        weight: Math.max(1e-3, this.canonicalConfidence * this.canonicalSteadiness * scaleFit.fitQuality),
      });
      if (this._scalePool.length > FORMANT_SCALE_POOL_FRAMES) this._scalePool.shift();
    }

    // ---- 5. Cross-estimator check, at reduced rate (§3.4) -----------------------------
    // The secondaries do not vote and never touch the value. They answer one question — is the
    // primary describing the same spectrum the other methods see — and the answer lowers
    // confidence when it is no. Run on alternating frames so the per-frame cost is one cheap
    // FFT-domain check, never two, and never a second root solve.
    //
    // THE COMPARISON IS MASKED TO THE FORMANTS BOTH ESTIMATORS ACTUALLY PRODUCED, and it is
    // made on this frame's RAW formants on both sides. Neither is fussiness. Comparing a
    // Kalman-smoothed multi-frame canonical ΔF against a raw single-frame check ΔF measures the
    // smoothing, not the estimators; and comparing a 3-formant fit against a 2-formant one
    // compares different constraint surfaces, which is the same error that cost Phase 2 47
    // points of yield when F4 reached the classifier. Measured on the Rainbow Passage,
    // unmasked and unsmoothed the "disagreement" between LPC and cepstral is a median 28% —
    // almost all of it the comparison's own construction rather than the estimators'.
    // The two secondaries alternate on successive cross-check slots, so the per-slot cost is one
    // cheap FFT-domain check and never two, and never a second root solve.
    this._crossCheckClock += frameSec > 0 ? frameSec : 1 / 60;
    if (this._crossCheckClock >= CROSS_CHECK_PERIOD_SEC) {
      this._crossCheckClock = 0;
      this._crossCheckTurn = (this._crossCheckTurn + 1) % 2;
      const which = this._crossCheckTurn === 0 ? 'cepstral' : 'harmonic';
      const r = which === 'cepstral'
        ? this._resonanceCepstral(pitchHz)
        : this._resonanceHarmonicEnvelope(pitchHz);
      const check = (r && r.measured) || [0, 0, 0, 0];
      const shared = [0, 1, 2, 3].map((i) => (measured[i] > 0 && check[i] > 0));
      const nShared = shared.filter(Boolean).length;
      const checkFit = nShared >= 2
        ? fitFormantScale(check.map((f, i) => (shared[i] ? f : 0))) : { deltaF: 0 };
      const primaryFit = nShared >= 2
        ? fitFormantScale(measured.map((f, i) => (shared[i] ? f : 0))) : { deltaF: 0 };
      this.crossCheckDeltaFHz[which] = checkFit.deltaF;
      // AGREEMENT IS POOLED, NOT PER FRAME, and that is a correction to how this was first
      // built rather than a convenience. The canonical value the app reports is pooled over the
      // ~1.7 s window; the question a cross-check answers is "do the other methods put ΔF in
      // the same place over that window", not "do a root solve and a harmonic envelope agree on
      // one 16.7 ms hop". Measured per frame on the Rainbow Passage, median agreement is 0.38 —
      // a residual 7.4% of ΔF that is genuine single-frame scatter between two very different
      // algorithms, not evidence that the measurement is wrong, and reading it as such
      // suppressed 62% of a clean recording of read speech.
      //
      // The pooled statistic is the MEDIAN RATIO of check to primary over the window. A median
      // so one frame where a secondary lost F3 cannot swing it; a ratio so it is scale-free and
      // the two secondaries' pools can be compared with each other.
      if (primaryFit.deltaF > 0 && checkFit.deltaF > 0) {
        const pool = this._crossPool[which];
        pool.push(checkFit.deltaF / primaryFit.deltaF);
        // Each secondary is checked on every other slot, so its own readings arrive at half the
        // slot rate; the pool holds CROSS_CHECK_POOL_SEC of them either way.
        const maxPool = Math.max(CROSS_CHECK_MIN_POOL,
          Math.round(CROSS_CHECK_POOL_SEC / (2 * CROSS_CHECK_PERIOD_SEC)));
        while (pool.length > maxPool) pool.shift();
      }
      const ratios = [];
      for (const k of ['cepstral', 'harmonic']) {
        const pool = this._crossPool[k];
        if (pool.length < CROSS_CHECK_MIN_POOL) continue;
        const sorted = pool.slice().sort((x, y) => x - y);
        ratios.push([k, sorted[Math.floor(sorted.length / 2)]]);
      }
      if (ratios.length) {
        // Both secondaries must agree with the primary; the WORSE of the two is the answer,
        // because a check that fails is evidence and a check that passes is only the absence of
        // that evidence. Averaging them would let a passing cepstral cover a failing harmonic.
        let worst = 1;
        for (const [k, ratio] of ratios) {
          const a = crossEstimatorAgreement(1, ratio, { checkMethod: k, primaryMethod: 'lpc' });
          if (a != null && a < worst) worst = a;
        }
        this.crossEstimatorAgreement = worst;
      }
    }

    // ---- 6. spectralBrightness: the demoted centroid (§5, D1) -------------------------
    // Never a resonance substitute. It is computed from the spectrum this frame already has,
    // it resolves no F3, and nothing downstream of resonance reads it.
    this.spectralBrightness = spectralBrightness(computeSpectralCentroid(
      this.frequencyData, this.audioCtx.sampleRate / this.analyser.fftSize, 200, 4000));

    // ---- 7. THE CONFIDENCE MODEL, AND THE SUPPRESSION GATE (§4, §5, D1) ---------------
    // §4's diagram: F0 · SNR · path quality · fit residual · cross-estimator agreement. A
    // product, not a weighted sum — these are independent necessary conditions, and a frame
    // with perfect cross-estimator agreement and no SNR is not half-good, it is three
    // estimators agreeing on noise.
    const terms = {
      snrConfidence: this.snrConfidence,
      formantConfidence: this.canonicalConfidence,
      validityRate: this.validityRate,
      fitQuality: this.formantScaleFitQuality,
      f0Hz: pitchHz,
    };
    // TWO NUMBERS, AND THE DIFFERENCE BETWEEN THEM IS THE CROSS-CHECK.
    //
    // `resonanceConfidenceV2` is the reported confidence — what a vividness or a progress bar
    // would read — and the cross-estimator agreement is in it, as §3.4 and §5 require.
    // `resonanceSuppressionConfidence` is what the floor tests, and it is NOT, because a
    // cross-check cannot establish that the PRIMARY measurement failed.
    //
    // That is measured, not asserted. On the Rainbow Passage the cepstral estimator's F3
    // differs from the canonical LPC's by a median 25.6% (F1 and F2 by ~8%), and the weighted
    // scale fit puts leverage 1.00 on F3 against 0.06 and 0.04 on F1 and F2 — so essentially
    // ALL of the ΔF disagreement between the two estimators is the secondary's own F3
    // imprecision. The cepstral envelope is a smoothed spectral peak; F3 is where it is worst.
    // Letting that suppress the primary is backwards, and it costs: with agreement in the
    // suppression decision the app declined 26% of a clean recording of read speech and vowel
    // yield fell from 87.0% to 71.2%. §5 is explicit — "if a gate costs more than it buys,
    // report the number and leave it off". Seventeen points of yield for a term that is mostly
    // reporting a known property of the CHECKER is more than it buys.
    //
    // It is not discarded. It stays in the reported confidence, where a coarse second opinion
    // legitimately makes a reading less trustworthy without making it absent, and
    // tools/frame-validity.mjs measures what it is worth there: on clean synthetic frames its
    // lowest agreement quartile is 23.2% bad against 0.2% for its highest.
    this.resonanceConfidenceV2 = resonanceConfidence({ ...terms, agreement: this.crossEstimatorAgreement });
    this.resonanceSuppressionConfidence = resonanceConfidence(terms);

    const pooled = poolFormantScale(this._scalePool);
    const belowFloor = this.resonanceSuppressionConfidence < RESONANCE_CONFIDENCE_FLOOR;
    if (belowFloor || !(pooled.deltaF > 0)) {
      // §5: "below the SNR floor the app shows NO resonance rather than a substitute." Every
      // v2 output is cleared, not frozen and not defaulted — a stale reading presented as a
      // live one is the same lie as a fabricated one, and D1 is explicit that the low-SNR case
      // is handled by suppressing feedback rather than by silently switching to a brightness
      // number that is computable from noise but wrong.
      this.resonanceSuppressed = true;
      this.resonanceSuppressReason = !(pooled.deltaF > 0) ? 'no-pooled-scale' : this._weakestConfidenceTerm(pitchHz);
      this.resonanceAbsolute = null;
      this.resonanceControl = null;
      this.resonancePresent = false;
      // The SCALE is cleared too, not just the score. "No reading" has to mean no reading:
      // leaving formantScaleHz standing at its last value would let anything downstream — a
      // report, a future display, the next phase — read a stale tract length as a live one,
      // which is the same failure as showing a substitute.
      this.formantScaleHz = 0;
      this.apparentVtlV2Cm = 0;
      this.formantPattern = [];
      this.formantPatternNormalized = [];
      this.formantPatternScaleFactor = 0;
      this.vowelId = null;
      this.vowelPosterior = 0;
      this.vowelDistance = 0;
      this.vowelAbstainReason = this.resonanceSuppressReason;
      this.f2PositionRatio = 0;
      this.rhoticDetected = false;
      this.rhoRelative = 0;
      this.rhoReason = 'suppressed';
      // A suppressed frame closes any open nucleus rather than extending it: it is not a frame
      // of a vowel, it is a frame the app declined to read.
      this.v2Aggregator.push({ value: 0, weight: 0, vowel: null, index: this._v2FrameIndex });
      this.f2PositionAggregator.push({ value: 0, weight: 0, vowel: null, index: this._v2FrameIndex });
      this._v2FrameIndex++;
      return;
    }

    this.resonanceSuppressed = false;
    this.resonanceSuppressReason = 'ok';
    this.formantScaleHz = pooled.deltaF;
    this.apparentVtlV2Cm = 35000 / (2 * pooled.deltaF);
    this.formantPattern = formantPatternResiduals(scaleInputs, pooled.deltaF);
    // ---- THE TWO SCALES, computed once, here (§4) ----------------------------------
    // `resonanceAbsolute` is what the perception model and every cross-speaker or cross-device
    // comparison read. `resonanceControl` is that same reading expressed inside a span, and it
    // is what the ball, the HUD and the haptics read. They are one measurement viewed twice —
    // there is no second estimator, no second smoother and no second suppression decision.
    this.resonanceAbsolute = resonanceAbsoluteV2(pooled.deltaF);
    this.resonanceControl = resonanceControl(this.resonanceAbsolute, this.resonanceSpan);
    this.resonancePresent = this.resonanceControl != null;

    // ---- 8. Vowel, and ρ (Phase 2's hand-off, answered) --------------------------------
    const pattern = normalizeResidualScale(
      this.formantPattern.slice(0, VOWEL_TEMPLATE_FORMANTS), undefined, VOWEL_TEMPLATE_FORMANTS);
    this.formantPatternNormalized = pattern.residuals;
    this.formantPatternScaleFactor = pattern.scaleFactor;
    const vc = classifyVowel(pattern.residuals, { preNormalized: true });

    // ρ. Phase 2 measured that /ɝ/ is the most isolated vowel in the set along this dimension
    // and refused to read it, because ρ is also what a pooling-window mismatch moves and Phase 2
    // could not tell the two apart. Phase 3 can: the window's own homogeneity says whether ρ
    // carries vowel information at all (in a sustained hold it does not — the window has
    // collapsed onto one vowel and ρ → 1 by construction), the validity gates say whether this
    // frame's F3 is a measurement or a tracking failure, and dividing by the window's running
    // median ρ removes the composition effect, which scales every vowel's ρ by a common factor.
    //
    // Measured (tools/rho-rhotic.mjs): held out across P&B's two populations, this takes the
    // classifier from 95% to 100% correct at 0% abstention and removes the /ɝ/→/æ/ confusion
    // without introducing another. It holds down to three distinct vowels in the window and is
    // gated off below that, where the median stops meaning anything.
    const hom = windowHomogeneity(this._scalePool);
    this.windowHomogeneityCv = hom.cv;
    this.windowIsHomogeneous = hom.homogeneous;
    if (vc.vowel && pattern.scaleFactor > 0) {
      this._rhoWindow.push({ rho: pattern.scaleFactor, vowel: vc.vowel });
      if (this._rhoWindow.length > FORMANT_SCALE_POOL_FRAMES) this._rhoWindow.shift();
    }
    const rhos = this._rhoWindow.map((e) => e.rho).sort((a, b) => a - b);
    const medianRho = rhos.length ? rhos[Math.floor(rhos.length / 2)] : 1;
    const distinctVowels = new Set(this._rhoWindow.map((e) => e.vowel)).size;
    // TWO INDEPENDENT ROUTES TO A RHOTIC, and both have to be checked, because they fail in
    // opposite directions:
    //
    //   ρ ON THE STANDARD ASSIGNMENT catches a rhotic whose F3 the extractor still resolved
    //   above 2000 Hz — a weak or coarticulated one.
    //
    //   ρ ON THE RHOTIC-CAPABLE ASSIGNMENT catches the strong ones, where F3 has dropped below
    //   the standard floor and the standard pass simply cannot see it. This is the case
    //   Peterson & Barney's /ɝ/ actually is: their adult-male F3 is 1690 Hz, and before this
    //   the live path named /ɝ/ correctly on 0.0% of frames of a synthesized /ɝ/ — it read as
    //   /ʊ/ on 64 of 67 — because the extractor had no slot for the pole.
    //
    // The second route is admitted ONLY when ρ corroborates it. That is exactly the job Phase 2
    // handed ρ: the low floor makes a rhotic F3 visible, and ρ decides whether to believe it.
    // Without the corroboration the widened slot manufactures rhotics at high F0 (measured:
    // /ɔ/ read as /ɝ/ on 47 frames in 67 at F0 180); with it, the widened slot only ever
    // produces a rhotic when the frame's own apparent scale has collapsed the way a rhotic
    // collapses it.
    const rhoOpts = {
      windowMedianRho: medianRho,
      heterogeneous: !hom.homogeneous,
      frameValid: this.frameValid,
      windowFrames: this._rhoWindow.length,
      windowVowels: distinctVowels,
    };
    let rh = rhoticFromRho(pattern.scaleFactor, rhoOpts);
    if (!rh.rhotic) {
      const rhoticRaw = (canonical && canonical.measuredRhotic) || [0, 0, 0, 0];
      // Only when the widened slot actually found something the standard pass did not: a pole
      // below the standard F3 floor. Otherwise the two assignments are the same vector and
      // re-testing it is just the same test again.
      if (rhoticRaw[2] > 0 && rhoticRaw[2] < F3_FLOOR_HZ && rhoticRaw[0] > 0 && rhoticRaw[1] > 0) {
        const rhoticPattern = formantPatternResiduals(
          [rhoticRaw[0], rhoticRaw[1], rhoticRaw[2]], pooled.deltaF);
        const rhoRhotic = residualScaleFactor(rhoticPattern);
        const alt = rhoticFromRho(rhoRhotic, rhoOpts);
        if (alt.rhotic) rh = alt;
      }
    }
    this.rhoticDetected = rh.rhotic;
    this.rhoRelative = rh.rhoRelative;
    this.rhoReason = rh.reason;

    // THE RHOTIC READING IS INSTRUMENTED AND NOT ACTED ON. That is the measured answer to
    // Phase 2's hand-off, and it is a "no" with three numbers behind it — see the block above
    // this method and tools/rho-rhotic.mjs.
    //
    // ρ does what Phase 2 said it would ON THE NORMS: held out across P&B's two populations it
    // takes the classifier from 95% to 100% correct at 0% abstention, removes the /ɝ/→/æ/
    // confusion without introducing another, improves at every noise level tested, and survives
    // window composition down to three distinct vowels.
    //
    // It does NOT survive the live path, and the failure is not marginal. Driven over
    // synthesized vowels whose identity is known by construction, admitting ρ reads /ɪ/ as /ɝ/
    // on 26 of 67 frames and, at F0 180, /ɔ/ as /ɝ/ on 47 of 67 — while recovering /ɝ/ itself on
    // 0–12%. Two things cause it, and neither is a threshold that could be moved:
    //
    //   1. The live pooling window is ~1.7 s and rarely holds enough DISTINCT vowels for its
    //      running median ρ to mean anything. ρ is defined relative to what the window held,
    //      and a window holding two vowels has a median that is simply one of them.
    //   2. The extractor cannot see the excursion ρ is supposed to read. The LPC assignment
    //      admits a pole as F3 only above 2000 Hz and P&B's adult-male /ɝ/ has F3 = 1690 Hz, so
    //      before Phase 3 the live path named a synthesized /ɝ/ correctly on 0.0% of frames — it
    //      read as /ʊ/ on 64 of 67. Widening the slot (measuredRhotic, computed and exposed
    //      here) makes /ɝ/ reachable — 92.5% at F0 110 — but at F0 180 the sparse pole set puts
    //      something in the widened slot on most frames and manufactures rhotics.
    //
    // So the honest answer to "is ρ now usable for /ɝ/" is NO, and the blocker is not ρ. It is
    // that the formant assignment has one policy, shared with v1, that cannot admit a rhotic F3
    // without admitting spurious ones. Fixing it means a rhotic-aware assignment that v1 no
    // longer constrains — which is Phase 4, when v1 retires — validated against real rhotic
    // recordings rather than a Klatt cascade, which is Phase 5's ladder. Everything needed to do
    // that is measured and exposed here; none of it is switched on.
    this.vowelId = vc.vowel;
    this.vowelPosterior = vc.posterior;
    this.vowelDistance = Number.isFinite(vc.distance) ? vc.distance : 0;
    this.vowelAbstainReason = this.vowelId ? 'ok' : vc.reason;

    this.f2PositionRatio = this.vowelId
      ? f2PositionFromResidual(pattern.residuals, this.vowelId)
      : 0;

    const aggWeight = Math.max(0, this.canonicalConfidence * this.canonicalSteadiness);
    const aggSample = { weight: aggWeight, vowel: this.vowelId, index: this._v2FrameIndex };
    // The aggregator carries ABSOLUTE, always. Session statistics that survive a recalibration
    // have to be on the axis that does not move when the span does (§4).
    this.v2Aggregator.push({ ...aggSample, value: this.resonanceAbsolute });
    this.f2PositionAggregator.push({ ...aggSample, value: this.f2PositionRatio });
    this._v2FrameIndex++;

    // ---- 9. Background ceiling re-check (§5) -------------------------------------------
    this._backgroundCeilingRecheck(canonical);
  }

  // Unvoiced or silent: no measurement was made, so there is nothing to report. Called from the
  // resonance stage's else branch. It does NOT clear the pooling window — a pause between two
  // phrases does not make the speaker's tract a different length, and the pool's own weights
  // and the formant ages already handle a long enough silence — but it does clear everything
  // that describes THIS frame, and it closes any open vowel nucleus.
  _decayCanonicalStream() {
    // The POOLING WINDOW IS NOT CLEARED. A pause between two phrases does not make the
    // speaker's tract a different length, and the window is a rolling one — it ages out on its
    // own. Clearing it forces an eight-frame refill at every pause and buys nothing, because the
    // reading is already suppressed for as long as there is nothing to read.
    this.frameValid = false;
    this.frameInvalidReasons = ['not-voiced'];
    this.resonanceSuppressed = true;
    this.resonanceSuppressReason = 'not-voiced';
    this.resonanceConfidenceV2 = 0;
    this.resonanceSuppressionConfidence = 0;
    this.resonanceAbsolute = null;
    this.resonanceControl = null;
    this.resonancePresent = false;
    this.formantScaleHz = 0;
    this.formantScaleFrameHz = 0;
    this.apparentVtlV2Cm = 0;
    this.formantPattern = [];
    this.formantPatternNormalized = [];
    this.formantPatternScaleFactor = 0;
    this.vowelId = null;
    this.vowelPosterior = 0;
    this.vowelDistance = 0;
    this.vowelAbstainReason = 'not-voiced';
    this.f2PositionRatio = 0;
    this.rhoticDetected = false;
    this.rhoRelative = 0;
    this.rhoReason = 'not-voiced';
    this.v2Aggregator.push({ value: 0, weight: 0, vowel: null, index: this._v2FrameIndex });
    this.f2PositionAggregator.push({ value: 0, weight: 0, vowel: null, index: this._v2FrameIndex });
    this._v2FrameIndex++;
  }

  // Which term of the confidence product collapsed. Reported rather than inferred, because
  // "the app is showing you nothing" is a claim it should be able to justify to the user, and
  // because "SNR too low" and "your pitch is above where this measurement is reliable" call for
  // completely different advice.
  _weakestConfidenceTerm(pitchHz) {
    // The cross-estimator term is deliberately absent: it does not participate in the
    // suppression decision (see the two-numbers note above), so it can never be the reason the
    // app declined to show one.
    const terms = {
      'low-snr': this.snrConfidence,
      'no-formant-structure': this.canonicalConfidence,
      'frames-failing-validity': this.validityRate,
      'formants-fit-no-tract': this.formantScaleFitQuality,
      'f0-too-high-to-resolve-formants': pitchHz > FORMANT_NOISE_F0_REF_HZ ? FORMANT_NOISE_F0_REF_HZ / pitchHz : 1,
    };
    let worst = 'low-snr', worstVal = Infinity;
    for (const [k, v] of Object.entries(terms)) {
      if (v < worstVal) { worstVal = v; worst = k; }
    }
    return worst;
  }

  // ---- Per-user LPC analysis ceiling (§5) ---------------------------------------------
  //
  // CALIBRATION ENTRY POINT. Phase 3 owns the SEARCH; Phase 4 owns the guided vowel-set
  // calibration UI that would run it, so this is deliberately a plain method with no UI
  // attached — hand it audio and it returns a ceiling. Nothing in the app calls it yet. That is
  // the stub the scope note asks to be declared: the search is real and measured
  // (tools/lpc-ceiling.mjs), the thing missing is the screen that collects the audio.
  //
  // `segments` is an array of SEGMENTS, each an array of Float32Array analysis windows at
  // this.audioCtx.sampleRate. A flat array of windows is accepted as a single segment. The
  // distinction is load-bearing: Phase 4's calibration records a VOWEL SET, which is several
  // separate productions, and running the continuity tracker straight across the boundary
  // between two of them is a measurement of the boundary rather than of the ceiling. It also
  // silently rigged the comparison — the tracker got stuck on the previous vowel's formants,
  // every subsequent frame failed continuity, and the ceiling that had found FEWER formants
  // (so had fewer to fail) scored best. Measured: it selected 4500 Hz with a per-formant yield
  // of 0.775 against 0.306 for the ceiling that was actually three times more accurate.
  //
  // Each candidate ceiling is run over ALL the audio — the multi-solve §3.4 forbids per frame
  // and permits here, because calibration is not real time.
  calibrateLpcCeiling(segments, { candidates = LPC_CEILING_CANDIDATES_HZ } = {}) {
    const segs = Array.isArray(segments) && segments.length && Array.isArray(segments[0])
      ? segments : [segments];
    if (!segs.length || !segs.some((seg) => Array.isArray(seg) && seg.length)) {
      return { ceilingHz: LPC_DEFAULT_CEILING_HZ, selected: false, reason: 'no-audio', scored: [] };
    }
    const saved = this.timeDomainData;
    const tracks = [];
    for (const ceilingHz of candidates) {
      const collected = [];
      for (const seg of segs) {
        if (!Array.isArray(seg)) continue;
        // Fresh continuity state per segment, and the same ageing the live path uses, so a
        // reference the tracker has lost cannot hold every later frame hostage.
        const ref = [0, 0, 0, 0];
        const refAge = [Infinity, Infinity, Infinity, Infinity];
        for (const frame of seg) {
          this.timeDomainData = frame;
          const r = this._resonanceLPC({ ceilingHz });
          const m = (r && r.measured) || [0, 0, 0, 0];
          const v = frameValidity(m, {
            bandwidths: r.bandwidths, previous: ref, previousAgeFrames: refAge,
            residual: r.modelResidual,
          });
          if (v.failed.length === 0) {
            for (let i = 0; i < 4; i++) {
              if (v.accepted[i] > 0) { ref[i] = v.accepted[i]; refAge[i] = 0; }
            }
          }
          for (let i = 0; i < 4; i++) {
            if (++refAge[i] > FORMANT_STALE_FRAMES) ref[i] = 0;
          }
          collected.push({ formants: v.accepted, bandwidths: r.bandwidths, valid: v.valid });
        }
      }
      tracks.push({ ceilingHz, frames: collected });
    }
    this.timeDomainData = saved;
    const chosen = selectLpcCeiling(tracks);
    if (chosen.selected) {
      this.lpcCeilingHz = chosen.ceilingHz;
      this.lpcCeilingSource = 'calibrated';
    }
    return chosen;
  }

  // The low-rate background re-check §5 asks for. One alternate ceiling, visited round-robin,
  // once every CEILING_RECHECK_PERIOD_FRAMES — 1/900th of an LPC solve per frame amortised,
  // against the per-frame multi-solve §3.4 rules out. It accumulates evidence over many
  // re-checks and only moves the ceiling when an alternative wins on a full candidate set, so a
  // single noisy stretch cannot swing the measurement the user is watching.
  _backgroundCeilingRecheck(canonical) {
    if (!this.frameValid) return;
    if (++this._ceilingRecheckFrames < CEILING_RECHECK_PERIOD_FRAMES) return;
    this._ceilingRecheckFrames = 0;
    const current = this.lpcCeilingHz || LPC_DEFAULT_CEILING_HZ;
    if (!this._ceilingTracks) {
      this._ceilingTracks = LPC_CEILING_CANDIDATES_HZ.map((ceilingHz) => ({ ceilingHz, frames: [] }));
    }
    const track = this._ceilingTracks[this._ceilingRecheckIdx % this._ceilingTracks.length];
    this._ceilingRecheckIdx++;
    const r = track.ceilingHz === current ? canonical : this._lpcAtCeiling(track.ceilingHz);
    const m = (r && r.measured) || [0, 0, 0, 0];
    const v = frameValidity(m, { bandwidths: r.bandwidths, residual: r.modelResidual });
    track.frames.push({ formants: v.accepted, bandwidths: r.bandwidths, valid: v.valid });
    // Not enough evidence on every candidate yet: keep collecting rather than deciding from a
    // partial sweep, which would systematically favour whichever candidate was sampled first.
    if (this._ceilingTracks.some((t) => t.frames.length < LPC_CEILING_MIN_FRAMES)) return;
    const chosen = selectLpcCeiling(this._ceilingTracks);
    if (chosen.selected && chosen.ceilingHz !== current) {
      this.lpcCeilingHz = chosen.ceilingHz;
      this.lpcCeilingSource = 'background';
    }
    this._ceilingTracks = null;
  }

  // ============================================
  // RESONANCE METHOD C: LPC with Root-Solving (Refined)
  // The Praat-style gold standard approach.
  // Improvements over v1:
  //  - Downsamples to ~11 kHz before LPC (proper Praat approach — concentrates
  //    modeling capacity on the formant region instead of wasting poles on > 5kHz)
  //  - Adaptive order = 2 + downsampledRate/1000 (≈ 13 for 11kHz → 6 pole pairs)
  //  - Root-solving on the LPC polynomial for direct formant extraction
  //    (gives exact frequency + bandwidth, not just spectral peak approx)
  //  - Formant bandwidth rejection (bandwidth > 500 Hz → likely not a real formant)
  // ============================================
  //
  // PHASE 3: the ANALYSIS CEILING is a parameter, and it is a property of the SPEAKER.
  // Praat calls it "maximum formant" and publishes two values for it — 5000 Hz "for men",
  // 5500 Hz "for women" — which is a two-point lookup on a continuous property. A short tract
  // puts its formants higher, so a ceiling chosen for a long one spends pole pairs on empty
  // band and starves the region the formants are actually in. Choosing it per user is the
  // FormantPath-style multi-ceiling search in calibrateLpcCeiling(); LIVE FRAMES USE THE ONE
  // SELECTED CEILING, because §3.4 measured that a per-frame multi-solve is not affordable.
  //
  // AT THE DEFAULT CEILING THIS IS ARITHMETICALLY IDENTICAL TO WHAT IT WAS. 5512.5 Hz is
  // 44100/4/2, so dsFactor is exactly 4, the resampler's targets land exactly on the samples
  // the decimation loop used to take (including its offset of dsFactor−1), the anti-alias
  // cutoff 0.9·ceiling is the old 0.45·dsRate, and the order rule is unchanged. That identity
  // is what lets v1 stay byte-identical while the canonical path moves to a chosen ceiling,
  // and it is asserted rather than argued: see resonance-estimator-discipline.test.mjs.
  _resonanceLPC({ ceilingHz = LPC_DEFAULT_CEILING_HZ } = {}) {
    const td = this.timeDomainData;
    const N = td.length;
    const sampleRate = this.audioCtx.sampleRate;

    // --- Resample to 2·ceiling for proper formant resolution ---
    // The model is asked to describe exactly the band up to the ceiling and nothing above it.
    const dsRate = 2 * ceilingHz;
    const dsFactor = sampleRate / dsRate;
    // A ceiling above the input's own Nyquist cannot be analysed — there is no band there.
    if (!(dsFactor >= 1)) return { f1: 0, f2: 0, f3: 0, confidence: 0, ceilingHz };
    const dsN = Math.floor(N / dsFactor);
    if (dsN < 50) return { f1: 0, f2: 0, f3: 0, confidence: 0, ceilingHz };

    // Anti-aliasing filter before decimation: 2nd-order Butterworth low-pass
    // Cutoff below the Nyquist of the target rate (which is the ceiling itself) to prevent
    // spectral aliasing. This is critical — without it, energy above the ceiling folds back
    // into the formant region and corrupts F1/F2/F3 estimates.
    const cutoffHz = ceilingHz * 0.9; // slightly below Nyquist to avoid ringing
    const wc = Math.tan(Math.PI * cutoffHz / sampleRate);
    const wc2 = wc * wc;
    const sqrt2 = Math.SQRT2;
    const k = 1 / (1 + sqrt2 * wc + wc2);
    const b0 = wc2 * k, b1 = 2 * b0, b2 = b0;
    const a1 = 2 * (wc2 - 1) * k;
    const a2 = (1 - sqrt2 * wc + wc2) * k;

    // Apply filter + resample in one pass. Output sample j is taken at input position
    // (j+1)·dsFactor − 1, linearly interpolated when that position is not an integer. The
    // offset is the decimation loop's own (it emitted on the dsFactor-th sample, i.e. index
    // dsFactor−1), kept so that an integer dsFactor reproduces the old output exactly rather
    // than shifting the window by three samples. Linear interpolation is adequate here
    // precisely because the anti-alias filter above has already removed everything near the
    // new Nyquist — there is nothing left for it to distort.
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const filtered = this._getBuffer('filtered', Float32Array, dsN);
    let dsIdx = 0;
    let target = dsFactor - 1;
    let yPrev = 0;
    for (let i = 0; i < N && dsIdx < dsN; i++) {
      const x0 = td[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      while (dsIdx < dsN && target <= i) {
        const frac = i - target;                 // 0 at an exact hit, (0,1) between samples
        filtered[dsIdx++] = frac > 0 ? y0 + (yPrev - y0) * frac : y0;
        target = (dsIdx + 1) * dsFactor - 1;
      }
      yPrev = y0;
    }

    // Pre-emphasis on filtered/downsampled signal
    const preEmph = this._getBuffer('preEmph', Float32Array, dsN);
    preEmph[0] = filtered[0];
    for (let i = 1; i < dsN; i++) {
      preEmph[i] = filtered[i] - 0.97 * filtered[i - 1];
    }

    // Hamming window
    const windowed = this._getBuffer('windowed', Float32Array, dsN);
    for (let i = 0; i < dsN; i++) {
      windowed[i] = preEmph[i] * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (dsN - 1)));
    }

    // Adaptive LPC order: 2 + dsRate/1000 ≈ 13 for 11kHz
    const order = Math.min(20, Math.max(8, Math.round(2 + dsRate / 1000)));

    // Autocorrelation
    const R = this._getBuffer('R', Float64Array, order + 1);
    for (let k = 0; k <= order; k++) {
      let sum = 0;
      for (let i = 0; i < dsN - k; i++) sum += windowed[i] * windowed[i + k];
      R[k] = sum;
    }
    if (R[0] < 1e-10) return { f1: 0, f2: 0, f3: 0, confidence: 0 };

    // Levinson-Durbin
    const a = this._getBuffer('a', Float64Array, order + 1);
    const aTemp = this._getBuffer('aTemp', Float64Array, order + 1);
    let E = R[0];
    for (let i = 1; i <= order; i++) {
      let lambda = 0;
      for (let j = 1; j < i; j++) lambda += a[j] * R[i - j];
      lambda = (R[i] - lambda) / E;
      for (let j = 1; j < i; j++) aTemp[j] = a[j] - lambda * a[i - j];
      aTemp[i] = lambda;
      for (let j = 1; j <= i; j++) a[j] = aTemp[j];
      E *= (1 - lambda * lambda);
      if (E < 1e-20) break;
    }
    // Normalised LPC residual: the fraction of the frame's energy the all-pole model failed to
    // predict. Phase 3's model-fit validity gate reads it. Near 0 on a clean voiced vowel at
    // this order; toward 1 on a fricative, a click or noise, where an all-pole source-filter
    // model is not describing the signal at all and its "formants" are an artefact of asking.
    const modelResidual = R[0] > 0 ? Math.max(0, E) / R[0] : 1;

    // --- Root-solving via companion matrix eigenvalues ---
    // Find roots of A(z) = 1 - a[1]z^-1 - a[2]z^-2 - ...
    // Equivalent polynomial: z^order - a[1]z^(order-1) - ... - a[order] = 0
    const { rootsRe, rootsIm, converged } = this._findLPCRoots(a, order);

    // Extract formants from roots: each complex conjugate pair with positive
    // imaginary part gives a formant frequency and bandwidth
    const formants = [];
    for (let i = 0; i < order; i++) {
      const re = rootsRe[i];
      const im = rootsIm[i];
      if (im <= 0) continue;
      const freq = Math.atan2(im, re) * dsRate / (2 * Math.PI);
      const mag = Math.sqrt(re * re + im * im);
      const bw = -dsRate * Math.log(Math.max(mag, 1e-12)) / Math.PI;
      if (freq >= 90 && freq <= 5000 && bw > 30 && bw < 600) {
        formants.push({ freq, bw });
      }
    }

    formants.sort((lhs, rhs) => lhs.freq - rhs.freq);

    // Slot assignment over the admitted poles. Factored into a function only so it can be run
    // TWICE over the SAME pole list — see `assignRhotic` below. The expensive work (the LPC
    // solve and the root find) has already happened; a second pass over at most a dozen poles
    // costs nothing measurable, which is why this is not a second solve.
    const assign = (f3FloorHz) => {
      let f1 = 0, f2 = 0, f3 = 0, f4 = 0;
      let f1Bw = 999, f2Bw = 999, f3Bw = 0, f4Bw = 0;
      // The admission bands stay in Hz and are NOT scaled with the ceiling. They are physical
      // bounds on where an adult formant can be, and the ceiling already truncates from above by
      // construction — a root cannot sit past the resampled Nyquist, which is the ceiling itself.
      // Scaling them would make the same voice admissible at one ceiling and not at another,
      // which would corrupt the multi-ceiling comparison the search depends on.
      const minSep = 200;
      for (const fm of formants) {
        if (f1 === 0 && fm.freq >= 150 && fm.freq <= 1200) {
          f1 = fm.freq; f1Bw = fm.bw;
        } else if (f2 === 0 && fm.freq >= 600 && fm.freq <= 3500 && fm.freq > f1 + minSep) {
          f2 = fm.freq; f2Bw = fm.bw;
        } else if (f3 === 0 && fm.freq >= f3FloorHz && fm.freq <= 4500 && fm.freq > f2 + minSep) {
          f3 = fm.freq; f3Bw = fm.bw;
        } else if (f3 > 0 && f4 === 0 && fm.freq >= 3000 && fm.freq <= F4_CEILING_HZ
                 && fm.freq > f3 + minSep && fm.bw < F4_MAX_BW_HZ) {
        // --- F4 (docs/RESONANCE_REDESIGN.md §1.6, §5) ---
        // F4 sits inside the band this path already analyses -- after 4x decimation the
        // anti-alias cutoff is 0.45*11025 ~= 4961 Hz and the order-13 model carries 6 pole
        // pairs -- but nothing was reading it out. This branch is purely additive: it runs
        // only after F3 has been assigned, over poles the loop above had already discarded,
        // so F1/F2/F3 and the confidence built from them are what they were.
        //
        // Two conditions beyond the F1-F3 pattern, because a wrong F4 is worse than no F4:
        // F3 and F4 carry the scale regression between them. The ceiling stays
        // below the anti-alias corner so a pole parked on the filter skirt cannot be read as
        // a formant, and the bandwidth bound is tighter than the generic 600 Hz admission
        // limit because broad spurious poles collect in exactly this band.
          f4 = fm.freq; f4Bw = fm.bw;
        }
      }
      return { f1, f2, f3, f4, f1Bw, f2Bw, f3Bw, f4Bw };
    };

    // v1's assignment, with the F3 floor it has always had.
    const slots = assign(F3_FLOOR_HZ);
    let { f1, f2, f3, f4 } = slots;
    const { f1Bw, f2Bw, f3Bw, f4Bw } = slots;

    // --- RHOTIC-CAPABLE ASSIGNMENT, for the canonical path only ---------------------------
    // A 2000 Hz floor on F3 cannot see a rhotic. Peterson & Barney's adult-male /ɝ/ has
    // F3 = 1690 Hz — a rhotic constriction lowers F3 by ~800 Hz, which is the entire reason
    // /ɝ/ is the most isolated vowel in the residual space (§5's Phase 2 entry) — so the one
    // vowel Phase 3 inherited the job of reaching is the one the extractor structurally cannot
    // resolve an F3 for. Measured on the Rainbow Passage before this existed: the lowest F3 the
    // canonical path ever reported was 2091 Hz, and ρ never came within 6% of the rhotic
    // threshold, so the rhotic rule fired on 0 frames of connected speech while working
    // perfectly on the P&B norms it was derived from.
    //
    // The lower floor is NOT applied to v1: v1's displayed output may not move, and this would
    // move it. It is a second assignment over the pole list the solve already produced, so the
    // real-time cost is a loop over a dozen numbers rather than another LPC.
    const rhoticSlots = assign(F3_RHOTIC_FLOOR_HZ);

    const nFound = (f1 > 0 ? 1 : 0) + (f2 > 0 ? 1 : 0) + (f3 > 0 ? 1 : 0);
    let bwScore = 0;
    if (f1 > 0) bwScore += Math.max(0, 1 - f1Bw / 400);
    if (f2 > 0) bwScore += Math.max(0, 1 - f2Bw / 400);
    bwScore = nFound > 0 ? bwScore / Math.min(2, nFound) : 0;
    const conf = formantEstimateConfidence({
      // A non-converged root solve still produces numbers; it does not produce the LPC model's
      // poles. Halve the structure term rather than discard the frame outright, so a hard frame
      // degrades toward the Kalman prediction instead of dropping out of the estimate entirely.
      structure: (nFound / 3) * bwScore * (converged ? 1 : 0.5),
      gain: FORMANT_CONF_GAIN.lpc,
      pitchConfidence: this.pitchConfidence,
      vowelLikelihood: this.vowelLikelihood,
    });

    // The F1/F2 defaults below are v1's behaviour and stay exactly as they were. The canonical
    // path must not see them: a defaulted 500/1500 Hz is not a measurement, and feeding it to a
    // validity gate would have the gate certify a number the mic never produced. `measured`
    // carries the pre-default values, so the two callers can want different things from the
    // same solve without either being lied to.
    const measured = [f1, f2, f3, f4];
    const measuredRhotic = [rhoticSlots.f1, rhoticSlots.f2, rhoticSlots.f3, rhoticSlots.f4];
    if (f1 === 0) f1 = 500;
    if (f2 === 0) f2 = 1500;

    // f4 is 0 when this frame did not yield one; it is never defaulted. Every other
    // estimator omits it entirely, which is the same statement.
    //
    // `bandwidths`, `modelResidual`, `measured` and `ceilingHz` are Phase 3 additions read by
    // the canonical path's validity gates and by the ceiling search. v1's call site destructures
    // f1/f2/f3/f4/confidence and is unaffected by their presence.
    return {
      f1, f2, f3, f4, confidence: conf,
      measured,
      bandwidths: [f1Bw < 999 ? f1Bw : 0, f2Bw < 999 ? f2Bw : 0, f3Bw, f4Bw],
      // The rhotic-capable assignment and its bandwidths, for the canonical path.
      measuredRhotic,
      bandwidthsRhotic: [rhoticSlots.f1Bw < 999 ? rhoticSlots.f1Bw : 0,
        rhoticSlots.f2Bw < 999 ? rhoticSlots.f2Bw : 0, rhoticSlots.f3Bw, rhoticSlots.f4Bw],
      modelResidual,
      converged,
      ceilingHz,
    };
  }

  // Durand-Kerner root finding for LPC polynomial
  // Finds all roots of z^n - a[1]z^(n-1) - a[2]z^(n-2) - ... - a[n] = 0
  _findLPCRoots(a, order) {
    const rootsRe = this._getBuffer('lpcRootsRe', Float64Array, order);
    const rootsIm = this._getBuffer('lpcRootsIm', Float64Array, order);

    // Deterministic seeding. This used to jitter the start radius with Math.random(), which
    // made the app's most precise formant estimator non-reproducible: the same audio frame
    // could yield different F1/F2/F3 from one run to the next, and neither the golden harness
    // nor a user comparing two takes could tell a real change from re-seeding noise. Durand-
    // Kerner only needs the initial points to be distinct and off the real axis, so a fixed
    // irrational-angle spiral serves the same purpose reproducibly.
    const PHI = 0.6180339887498949; // golden ratio conjugate — spreads radii without repeating
    for (let k = 0; k < order; k++) {
      const angle = 2 * Math.PI * (k + 0.5) / order;
      const radius = 0.9 + 0.05 * (((k + 1) * PHI) % 1);
      rootsRe[k] = radius * Math.cos(angle);
      rootsIm[k] = radius * Math.sin(angle);
    }

    let converged = false;
    for (let iter = 0; iter < 50; iter++) {
      let maxDelta = 0;
      for (let k = 0; k < order; k++) {
        const zRe = rootsRe[k];
        const zIm = rootsIm[k];

        let pRe = 1;
        let pIm = 0;
        for (let j = 1; j <= order; j++) {
          const nextRe = pRe * zRe - pIm * zIm;
          const nextIm = pRe * zIm + pIm * zRe;
          pRe = nextRe - a[j];
          pIm = nextIm;
        }

        let prodRe = 1;
        let prodIm = 0;
        for (let j = 0; j < order; j++) {
          if (j === k) continue;
          const dRe = zRe - rootsRe[j];
          const dIm = zIm - rootsIm[j];
          const nextProdRe = prodRe * dRe - prodIm * dIm;
          const nextProdIm = prodRe * dIm + prodIm * dRe;
          prodRe = nextProdRe;
          prodIm = nextProdIm;
        }

        const denom = prodRe * prodRe + prodIm * prodIm + 1e-30;
        const deltaRe = (pRe * prodRe + pIm * prodIm) / denom;
        const deltaIm = (pIm * prodRe - pRe * prodIm) / denom;
        rootsRe[k] = zRe - deltaRe;
        rootsIm[k] = zIm - deltaIm;
        maxDelta = Math.max(maxDelta, Math.hypot(deltaRe, deltaIm));
      }
      if (maxDelta < 1e-8) { converged = true; break; }
    }

    // Report convergence instead of silently returning half-solved roots. A polynomial the
    // solver did not finish gives formant frequencies and bandwidths that are not the LPC
    // model's — treating them as equal to a converged solve is how a confident-looking
    // number gets built on nothing.
    return { rootsRe, rootsIm, converged };
  }

  // ============================================
  // RESONANCE METHOD D: Spectral Centroid (Refined Baseline)
  // Improved control/baseline for comparison.
  // Improvements:
  //  - Amplitude clamping prevents extreme dB values from dominating centroid
  //  - Spectral concentration (kurtosis) as proper confidence measure
  //  - Third-band centroid for F3 region
  //  - Noise floor subtraction from linear amplitudes
  // ============================================
  _resonanceCentroid() {
    const fmtData = this.formantFreqData;
    const binHz = this.audioCtx.sampleRate / this.analyserFormant.fftSize;
    const numBins = fmtData.length;

    // Convert dB to linear with floor clamping (prevents extreme values)
    const noiseFloorDb = -80;
    const linearAmp = (bin) => {
      const db = Math.max(noiseFloorDb, fmtData[bin]);
      return Math.pow(10, (db - noiseFloorDb) / 20); // normalized: 0 at noise floor
    };

    // Helper: weighted centroid + concentration for a band
    const bandAnalysis = (loHz, hiHz) => {
      const startBin = Math.max(0, Math.floor(loHz / binHz));
      const endBin = Math.min(numBins - 1, Math.ceil(hiHz / binHz));
      let wFreq = 0, wSum = 0, wFreqSq = 0;
      for (let i = startBin; i <= endBin; i++) {
        const amp = linearAmp(i);
        const freq = i * binHz;
        wFreq += freq * amp;
        wFreqSq += freq * freq * amp;
        wSum += amp;
      }
      if (wSum < 0.001) return { centroid: (loHz + hiHz) / 2, concentration: 0 };
      const centroid = wFreq / wSum;
      const variance = wFreqSq / wSum - centroid * centroid;
      const bandWidth = hiHz - loHz;
      // Concentration: 1 when perfectly focused, 0 when spread across band
      const concentration = Math.max(0, 1 - Math.sqrt(Math.max(0, variance)) / (bandWidth * 0.35));
      return { centroid, concentration };
    };

    const b1 = bandAnalysis(200, 1100);
    const b2 = bandAnalysis(900, 3500);

    // Confidence from concentration × voicing quality, on the shared scale. Spectral
    // concentration is the lowest-reading of the four structure measures, so without the
    // calibration gain this estimator's confidence could not clear even the 0.2 gate that
    // admits a frame to the resonance readout — the method the SNR ladder falls back to in
    // noise reported a frozen number that nothing downstream would display.
    const avgConcentration = (b1.concentration + b2.concentration) / 2;
    const conf = formantEstimateConfidence({
      structure: avgConcentration,
      gain: FORMANT_CONF_GAIN.centroid,
      pitchConfidence: this.pitchConfidence,
      vowelLikelihood: this.vowelLikelihood,
    });

    // No F3. A band centroid is a weighted average, so it is pulled toward the centre of its
    // own band whenever the spectrum inside it is not sharply peaked — and the F3 band is the
    // widest and least peaked of the three, overlapping F2's upper skirt below and fricative
    // energy above. Measured against a synthesized vowel with F3 at 2850 Hz, the 2200-4200 Hz
    // centroid read 3149 Hz: +11%, which the ΔF fit turns into +8% on apparent tract length and
    // +21 points on the resonance score, because F3 carries the most leverage in that fit.
    //
    // Returning 0 declares F3 unmeasured rather than guessing it. The ΔF fit then works from
    // F1/F2 alone — both within 2% here — which is what its slot-aware form is for. This is the
    // method's honest resolution: it is the noise-tolerant fallback, not a formant tracker.
    return { f1: b1.centroid, f2: b2.centroid, f3: 0, confidence: conf };
  }

  // Shared formant peak-picking for harmonic envelope methods (A)
  // Finds F1, F2, F3 with constraints, fallbacks, and confidence scoring
  _peakPickFormants(env, f0, numHarmonics) {
    const minF1Hz = 200, maxF1Hz = 1100;
    const minF2Hz = 600, maxF2Hz = 3500;
    const minF3Hz = 2200, maxF3Hz = 4200;
    const minSepHz = 300;

    // Collect all local maxima with parabolic frequency interpolation
    const peaks = [];
    for (let i = 1; i < numHarmonics - 1; i++) {
      if (env[i] > env[i - 1] && env[i] > env[i + 1]) {
        const a = env[i - 1], b = env[i], c = env[i + 1];
        const denom = a - 2 * b + c;
        let refinedIdx = i;
        let refinedAmp = b;
        if (Math.abs(denom) > 0.001) {
          const delta = 0.5 * (a - c) / denom;
          refinedIdx = i + Math.max(-0.5, Math.min(0.5, delta));
          refinedAmp = b - (a - c) * (a - c) / (8 * denom);
        }
        // Map harmonic index to frequency: H(i+1) = f0 * (i+1)
        // With fractional index: f0 * (refinedIdx + 1)
        peaks.push({ freq: f0 * (refinedIdx + 1), amp: refinedAmp });
      }
    }

    let f1 = 0, f1Amp = -Infinity;
    let f2 = 0, f2Amp = -Infinity;
    let f3 = 0, f3Amp = -Infinity;
    let usedF1Fallback = false, usedF2Fallback = false;

    // Assign F1
    for (const p of peaks) {
      if (p.freq >= minF1Hz && p.freq <= maxF1Hz && p.amp > f1Amp) {
        f1Amp = p.amp; f1 = p.freq;
      }
    }

    // Assign F2
    const f2FloorHz = Math.max(minF2Hz, f1 + minSepHz);
    for (const p of peaks) {
      if (p.freq >= f2FloorHz && p.freq <= maxF2Hz && p.amp > f2Amp) {
        f2Amp = p.amp; f2 = p.freq;
      }
    }

    // Assign F3
    const f3FloorHz = Math.max(minF3Hz, f2 + minSepHz);
    for (const p of peaks) {
      if (p.freq >= f3FloorHz && p.freq <= maxF3Hz && p.amp > f3Amp) {
        f3Amp = p.amp; f3 = p.freq;
      }
    }

    // Fallbacks: band-energy centroid (mark as lower confidence)
    if (f1 === 0) {
      usedF1Fallback = true;
      let w = 0, wS = 0;
      for (let i = 0; i < numHarmonics; i++) {
        const hFreq = f0 * (i + 1);
        if (hFreq >= minF1Hz && hFreq <= maxF1Hz) {
          const amp = Math.pow(10, env[i] / 20);
          w += hFreq * amp; wS += amp;
        }
      }
      f1 = wS > 0 ? w / wS : 500;
    }
    if (f2 === 0) {
      usedF2Fallback = true;
      let w = 0, wS = 0;
      for (let i = 0; i < numHarmonics; i++) {
        const hFreq = f0 * (i + 1);
        if (hFreq >= f2FloorHz && hFreq <= maxF2Hz) {
          const amp = Math.pow(10, env[i] / 20);
          w += hFreq * amp; wS += amp;
        }
      }
      f2 = wS > 0 ? w / wS : 1500;
    }

    let envMin = 0, envRange = 0;
    if (env.length > 0) {
      envMin = env[0]; let envMax = env[0];
      for (let i = 1; i < env.length; i++) {
        if (env[i] < envMin) envMin = env[i];
        if (env[i] > envMax) envMax = env[i];
      }
      envRange = envMax - envMin;
    }
    let prominence = 0;
    if (envRange > 0) {
      const f1P = usedF1Fallback ? 0.2 : Math.min(1, (f1Amp - envMin) / envRange);
      const f2P = usedF2Fallback ? 0.2 : Math.min(1, (f2Amp - envMin) / envRange);
      prominence = (f1P + f2P) / 2;
    }
    const confidence = formantEstimateConfidence({
      structure: prominence,
      gain: FORMANT_CONF_GAIN.harmonic,
      pitchConfidence: this.pitchConfidence,
      vowelLikelihood: this.vowelLikelihood,
    });

    // `measured` is the pre-fallback vector, added for Phase 3's cross-check: the fallback F1/F2
    // this path substitutes are inferences, not measurements, and a cross-check that scored the
    // canonical estimator against them would be scoring it against its own assumptions.
    const measured = [usedF1Fallback ? 0 : f1, usedF2Fallback ? 0 : f2, f3, 0];
    return { f1, f2, f3, confidence, measured };
  }
}

// ============================================================
// PARTICLE — uses RGB for proper alpha rendering
// ============================================================
class Particle {
  constructor(x, y, r, g, b, vx, vy, life, size) {
    this.x = x; this.y = y;
    this.r = r; this.g = g; this.b = b;
    this.vx = vx; this.vy = vy;
    this.life = life; this.maxLife = life;
    this.size = size;
  }
  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vy += 120 * dt;
    this.life -= dt;
  }
  draw(ctx) {
    const alpha = Math.max(0, this.life / this.maxLife) * 0.8;
    ctx.fillStyle = `rgba(${this.r},${this.g},${this.b},${alpha})`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * (this.life / this.maxLife), 0, Math.PI * 2);
    ctx.fill();
  }
}

// ============================================================
// MAIN GAME
// ============================================================
export class VoxBallGame {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.analyzer = new VoiceAnalyzer();
    this.isRunning = false;
    this._isStarting = false; // guard for startGame/stopGame race
    this.lastTime = 0;
    this.idleAnimId = null;
    this._disposables = []; // cleanup callbacks for listeners/observers
    this._pendingTimeouts = []; // track setTimeout IDs for cleanup
    this.dialogManager = new ModalFocusManager({ root: document.getElementById('app') });
    this.wakeLock = new SessionWakeLock();
    this._disposables.push(() => this.wakeLock.destroy());

    // FIX: Store ball color as HSL components for proper HSLA compositing
    this.ballHue = 275;
    this.ballSat = 70;
    this.ballLit = 55;

    this.ball = {
      x: 0, y: 0, vy: 0,
      radius: 22, baseRadius: 22, targetRadius: 22,
      rotation: 0, squash: 1, onGround: true
    };

    this.groundY = 0;
    this.scrollX = 0;
    this.scrollSpeed = 120;
    this.targetScrollSpeed = 120;
    this.cameraY = 0;       // current camera vertical offset (negative = looking up)
    this.targetCameraY = 0; // smooth target
    this.cameraZoom = 1.4;  // current zoom level
    this.targetZoom = 1.4;  // target zoom (computed from ball height)
    this.userZoomMultiplier = 1; // manual zoom in/out, applied on top of the dynamic zoom
    this.prosodyScore = 0;  // smoothed composite prosody signal (0=monotone, 1=expressive)
    this.particles = [];
    this.trailPoints = [];
    this.sparkles = [];
    this.themeMode = 'highcontrast';
    this.colorblindMode = false;
    // Orb color mode: 'pitch' (hue from F0) or 'gender' (hue from perceived vocal gender).
    this.colorMode = localStorage.getItem('vox:colorMode') || 'pitch';
    this.dafEnabled = localStorage.getItem('vox:daf:enabled') === 'true';
    this.dafDelayMs = parseInt(localStorage.getItem('vox:daf:delayMs') || '75');
    // Default OFF so DAF plays back the full raw voice band instead of cutting bass.
    this.dafBassFilter = localStorage.getItem('vox:daf:bassFilter') === 'true';
    // Optional voice-only measurement gate; see speech-gate.js. Default off.
    this.speechGateEnabled = localStorage.getItem('vox:speechGate') === 'true';
    // '' means system default. Only honoured where setSinkId exists.
    this.dafOutputDeviceId = localStorage.getItem('vox:daf:outputDeviceId') || '';
    // Native Web Audio delay line; see daf-engine.js for why it is not a JS buffer loop.
    this.daf = new DafEngine({ delayMs: this.dafDelayMs, bassFilter: this.dafBassFilter });
    this.smoothGenderScore = 0.5; // EMA of the 0..1 perceived-gender score (0.5 = androgynous)
    this.genderUncertainty = 1;   // 0..1 spread/disagreement of the gender cues
    // Per-cue toggles for the perceived-gender model. pitch + resonance are always on (the
    // original baseline); these are user-toggleable. Intonation is a sociolinguistic stereotype
    // (not anatomy) so it defaults OFF.
    const cueOn = (key, dflt) => {
      const v = localStorage.getItem(key);
      return v == null ? dflt : v === 'true';
    };
    this.genderCues = {
      // pitchZone, resonance always on; weight defaults on (source-only, reliable).
      weight: cueOn('vox:genderCue:weight', true),
      sibilant: cueOn('vox:genderCue:sibilant', true),
      intonation: cueOn('vox:genderCue:intonation', false),
      // Legacy keys preserved so stored user prefs are not silently lost.
      modalF0: cueOn('vox:genderCue:modalF0', true),
      dispersion: cueOn('vox:genderCue:dispersion', true),
      cpp: cueOn('vox:genderCue:cpp', true),
    };
    // Goal direction: 'feminization' | 'masculinization'. Determines cue weights and
    // incongruence-guard direction. Defaults to feminization.
    const storedGoal = localStorage.getItem('vox:goalMode');
    this.goalMode = storedGoal === 'masculinization' ? 'masculinization' : 'feminization';
    this.gameMode = 'ball';

    // Recording
    this.isRecording = false;
    this._recInterval = null;
    this._recSampleRate = 48000;
    this._mediaRecorder = null;
    this._recUseMediaRecorder = false;
    this._recMimeType = null;
    this._recordingGeneration = 0;
    this._recordingAttempt = null;
    this._recordingFinalizePromise = null;
    this._recStopTimer = null;
    this._recDurationTimer = null;
    this._recordingLimitStopRequested = false;
    this._recordingUrls = new RecordingObjectUrlPool();
    this._playbackGeneration = 0;
    this._recordingListenerCount = 0;
    this.recordings = []; // bounded, memory-only { id, blob, duration, timestamp, name, ... }
    this.recordingStartTime = 0;
    this.currentPlayback = null;
    this.currentSpeech = null; // in-flight SpeechSynthesisUtterance for the practice results "Hear feedback" button
    this._pendingClipLabel = null; // label attached to the next saved clip (set by practice flow)
    this._pendingPhrase = null;    // known phrase text for the next saved clip → word-by-word analysis
    this._pendingPhraseDef = null; // PRACTICE_PHRASES entry for the next saved clip → coaching scores
    this._recTickSec = 1 / RECORDING_LIMITS.metricSamplesPerSecond;

    // Guided phrase practice flow state; stage: 'prompt' (read & record) | 'results' (review take)
    // takeIndex points at the recording shown in the results stage.
    this.practice = { active: false, index: 0, stage: 'prompt', takeIndex: -1 };

    // Procedural infinite terrain — layered sine waves, no finite array
    this.terrainLayers = [];
    for (let i = 0; i < 5; i++) {
      this.terrainLayers.push({
        amplitude: 10 + Math.random() * 25,
        frequency: 0.002 + Math.random() * 0.005,
        phase: Math.random() * Math.PI * 2
      });
    }

    this.stars = [];

    // ====== VIBRATION ALERT STATE ======
    this.vibration = {
      enabled: false,
      rules: [],
      nextId: 1,
      shakeTimer: 0,
      hasHaptic: typeof navigator !== 'undefined' && 'vibrate' in navigator,
      globalCooldown: 0,
      flashAlpha: 0,       // on-canvas alert flash opacity
      flashMetric: '',     // which metric tripped (for display)
    };
    try {
      const savedVibration = parseVibrationPreferences(localStorage.getItem(VIBRATION_STORAGE_KEY));
      this.vibration.enabled = savedVibration.enabled;
      // §3.5's migration, run on the way in rather than at the fire path, so a rule is never in
      // memory in a state where a later code path might read it as current. Every resonance
      // rule that predates the metric split comes back SUSPENDED with its threshold intact;
      // `resonanceRulesNeedingReprompt` is what the settings panel shows the user.
      // Checked against the span the analyzer is actually on, which at this point is either a
      // profile restored a few lines below or the population span. Both cases are handled the
      // same way: a rule that cannot be shown to belong to the live span does not fire until
      // the user says it should.
      const migration = migrateResonanceRules(savedVibration.rules, { spanId: this.analyzer.resonanceSpanId });
      this.vibration.rules = migration.rules;
      this.vibration.nextId = savedVibration.nextId;
      this.resonanceRulesNeedingReprompt = migration.needsReprompt;
      // Persist the migration immediately. Leaving it in memory only would re-run it on every
      // load, which is harmless, but it would also mean the exported settings bundle still
      // carried unversioned rules — and that bundle is how a rule reaches a second device.
      if (migration.migrated > 0) {
        localStorage.setItem(VIBRATION_STORAGE_KEY, serializeVibrationPreferences(this.vibration));
      }
    } catch {
      // Storage can be unavailable in private/embedded contexts; defaults remain usable.
    }

    // ====== THE PERSONAL SPAN (§3.5) ======
    // The persistence that did not exist before this phase. Grepped on main: no localStorage key
    // held a resonance profile or a session history, so the "learned personal range" §3.5 lists
    // as existing user state died with the tab. This is versioned from its first write — a
    // profile from another metric version is refused by parseResonanceProfile, and the app falls
    // back to the published population span rather than to a number it cannot interpret.
    this.resonanceProfileStatus = 'absent';
    try {
      const parsed = parseResonanceProfile(localStorage.getItem(RESONANCE_PROFILE_KEY));
      this.resonanceProfileStatus = parsed.reason;
      if (parsed.profile) this.analyzer.applyResonanceProfile(parsed.profile);
    } catch {
      // Same as above: an unreadable store is not a reason to fail to start.
    }

    // ====== SESSION STATS ======
    this.session = {
      startTime: 0,
      duration: 0,
      pitchSum: 0,
      pitchCount: 0,
      pitchMin: Infinity,
      pitchMax: 0,
      // `resonanceSum` is CONTROL — the scale the ring showed, and the one the summary card
      // displays. `absoluteSum` is the same frames on the absolute axis: the statistic that
      // would survive a recalibration, tagged with the metric version that produced it, kept
      // for the cross-session comparison this app does not yet persist.
      resonanceSum: 0,
      resonanceCount: 0,
      absoluteSum: 0,
      absoluteCount: 0,
      resonanceMetricVersion: RESONANCE_METRIC_VERSION,
      resonanceScale: RESONANCE_SCALE_CONTROL,
      resonanceSpanId: null,
      resonanceSuppressedCount: 0,
      prosodyHistory: [],  // sampled every ~0.5s for sparkline
      prosodySampleTimer: 0,
      scrollAtStart: 0,
    };

    // ====== ACCESSIBILITY ======
    this.userMotionPreference = localStorage.getItem('vox:motionPreference') || 'auto';
    this.micInputPreferences = {
      deviceId: localStorage.getItem('vox:micDeviceId') || 'default',
      // Default OFF: phones route echo cancellation / noise suppression / AGC through a
      // telephony-style voice processing pipeline that band-limits the signal (cutting
      // both low and high frequencies), which is what makes captured/played-back voice
      // sound duller and "deeper" than the raw mic input.
      echoCancellation: localStorage.getItem('vox:echoCancellation') === 'true',
      noiseSuppression: localStorage.getItem('vox:noiseSuppression') === 'true',
      autoGainControl: localStorage.getItem('vox:autoGainControl') === 'true',
    };
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.baseParticleScale = 1;
    this.particleScale = 1;
    this.dynamicQualityScale = 1;
    this._applyMotionPreferences();
    const motionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionChange = (e) => {
      this.reducedMotion = e.matches;
      this._applyMotionPreferences();
    };
    motionMql.addEventListener('change', onMotionChange);
    this._disposables.push(() => motionMql.removeEventListener('change', onMotionChange));

    // ====== RUNTIME TOOLS ======
    this.perfMonitor = new PerformanceMonitor({ panelId: 'perfPanel' });
    this.calibrationWizard = new CalibrationWizard({ focusManager: this.dialogManager });
    this.bulbController = new BulbController({ swatchId: 'bulbSimSwatch', statusId: 'bulbStatus' });
    this.necklaceController = new NecklaceController({ onStatus: (s) => this._onNecklaceStatus(s) });
    this.hasCompletedCalibration = false;
    this.guidedStartTs = 0;
    this.guidedDurationSec = 5;
    this.guidedDismissed = false;
    this.guidedCloseHitbox = null;
    this.guidedPitchStable = 0;
    this.guidedChecklist = {
      roomReady: false,
      voiceDetected: false,
      pitchLocked: false,
    };
    // Reliability presentation (Layer B; see docs/DSP_CONTRACT.md): a render-side EMA of
    // the analyzer's snrConfidence drives ball vividness so the user can tell whether
    // they're changing their voice or just their room. Starts trusted so nothing flashes.
    this.trustVividness = 1;
    this._lowTrustSecs = 0; // sustained red-tier time; gates the calm text nudge
    this.pitchGridStrength = 'strong';
    this.teleprompterMode = 'off';
    this.voiceProfilePreset = 'auto';
    this.teleprompterCustomText = '';
    this.teleprompterRainbowText = (`When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. ` +
      `The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, ` +
      `with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end.`);

    this.teleprompterIndex = 0;
    this.teleprompterSentenceIndex = 0; // current sentence for manual (Space/Tap) advance
    this.metricHighlightTimers = { bounce: 0, tempo: 0, vowel: 0, articulation: 0, syllable: 0 };
    this.metricExtremeLatch = { bounce: false, tempo: false, vowel: false, articulation: false, syllable: false };

    // ====== EXPANDED METRICS STATE ======
    this.metersExpanded = false;
    this.metricPopupOpen = null; // null or metric key string
    this._metricHistoryMax = 120; // ~2 seconds at 60fps (default)
    this._metricHistoryMaxLong = 600; // ~10 seconds at 60fps (pitch, bounce)
    this._metricHistory = {
      pitch: [],       // raw Hz values
      resonance: [],   // 0-1 resonance score
      bounce: [],      // 0-1
      vowels: [],      // 0-1
      attack: [],      // 0-1 onset hardness
      weight: [],      // 0-1 perceived heaviness
    };
    this._vowelPlotPoints = []; // {x, y} for F1/F2 scatter
    this._vowelPlotMax = 80;

    // ====== VOICE MAP (pitch × resonance constellation) ======
    // Session-long cloud of confidence-weighted {t, hz, res, score, w} samples on the
    // pitch(log-Hz) × resonance plane. Sampled ~10×/s inside _pushAvgSamples — which runs
    // unconditionally every frame — so the cloud accumulates even while the panel is closed;
    // it is only *rendered* when the Voice Map card or popup is visible.
    this._voiceMapPoints = [];
    this._voiceMapMax = 900;      // ≈90 s of confident voicing at 10 samples/s
    this._voiceMapLastPush = 0;
    this._voiceMapStats = null;   // throttled summarizeVoiceCloud output
    this._voiceMapStatsAt = 0;
    // Background hue-field canvases keyed by size+palette. A Map (not a single slot) because
    // the card and the focus popup render at different sizes in the same frame — a single
    // cache would rebuild the field twice per frame while the popup is open.
    this._voiceMapBgCache = new Map();
    // Vocal-attack orb animation: condenses gas→solid on each onset at a speed set by the
    // measured onset hardness, then evaporates. (Weight orb reads m.weight directly.)
    this._attackOrb = { solidity: 0, prevAttack: 0, hardness: 0, lastT: 0 };

    // ====== WHAT THE USER SEES WHEN THERE IS NO READING (§5 Phase 4, §6) ======
    //
    // v1 always had a number, because it was an EMA that could not be absent. v2 can be, and
    // 11.4% of clean read speech is suppressed at the app's live rate. The brief in front of
    // this phase called that "a ring that blinks out for one frame in nine". MEASURED, IT IS
    // NOT: on the Rainbow Passage those 21 frames are THREE runs, of 3, 4 and 14 frames
    // (100 ms, 133 ms, 467 ms), and not one is a singleton. At 60 fps it is two runs, of 1 and
    // 13 frames. The app does not flicker — it declines in contiguous stretches, which is what
    // pool warm-up and the pauses between phrases actually are.
    //
    // That measurement is what sets the design. A stretch of 100 ms or more is long enough to
    // be read as a state, so the ring gets a state: it relaxes into a NEUTRAL LISTENING RING
    // that encodes nothing — fixed radius, no hue travel, no width travel — and comes back when
    // there is something to show.
    //
    // Two rules make this honest rather than a cover-up:
    //   - The NUMBER blanks immediately. `_pushAvgSamples` stops feeding the windowed average
    //     on the first suppressed frame, so the HUD readout goes to "—" with no ramp at all.
    //     Nothing numeric is ever shown stale.
    //   - The RING cross-fades, over a ramp SHORTER THAN THE SHORTEST MEASURED DECLINE, so
    //     every real one completes the transition. For at most RESONANCE_FADE_OUT_SEC the ring
    //     is still partly where the last reading put it. That is stated rather than hidden: it
    //     is the difference between a ring that relaxes and a ring that cuts out, and a cut
    //     reads as a fault in the app rather than as an absence of signal.
    //
    // The ramps are in SECONDS and integrated against the real frame interval, not per-frame
    // coefficients — the frame-rate fidelity defect DSP_CONTRACT documents and Phase 3
    // reproduced once already.
    this._resPresence = 0;        // 0 = neutral listening ring, 1 = a reading
    this._resDisplayValue = null; // last CONTROL value; null until the first ever reading
    this._lastBulbResonance = null;

    // ====== WINDOWED-AVERAGE READOUTS ======
    // Numeric readouts for pitch/resonance/attack/weight show a rolling time-window average
    // (calmer + more useful for voice training) instead of a jittery per-frame value. The live
    // bars/orbs/graphs stay instantaneous. Buffers are TIME-stamped and fed every frame.
    this._avgWindowSecs = 3.0;        // selectable window length; 0 ⇒ "Live" (instantaneous)
    this._avgWindowMaxSecs = 10;      // retain up to this much history so window switches are instant
    this._avgRefreshSecs = 0.6;       // throttle: only recompute the displayed number this often
    this._avgBuffers = { pitch: [], resonance: [], attack: [], weight: [] };
    this._avgCache = {};              // last computed summary per metric (or null)
    this._avgLastRefresh = 0;         // performance.now()/1000 of last cache recompute
    this._avgLastFrameId = -1;        // frame id of last Live-mode recompute (de-dupes per frame)
    // Per-metric display modes (mirrors the Resonance method selector the user likes)
    this.pitchDisplayMode = 'hz';     // 'hz' | 'note' | 'range'
    this.weightMode = 'combined';     // 'combined' | 'tilt' | 'h1h2'
    this.attackMode = 'combined';     // 'combined' | 'rise' | 'abrupt'

    this.resize();
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this._disposables.push(() => window.removeEventListener('resize', onResize));
    this.setupUI();
    const onPageHide = () => {
      this.cancelRecording('pagehide');
      this.stopPlayback();
      this._recordingUrls.releaseAll();
    };
    window.addEventListener('pagehide', onPageHide);
    this._disposables.push(() => window.removeEventListener('pagehide', onPageHide));
    this._updateHelpContent();
    this._setupMobile();
    this._setupInfoPopups();
    this.drawIdleScene();
  }



  /** Show/hide info-popup tooltips via JS (CSS-only approach was unreliable) */
  _setupInfoPopups() {
    document.querySelectorAll('.info-wrapper').forEach(wrapper => {
      const popup = wrapper.querySelector('.info-popup');
      const trigger = wrapper.querySelector('.info-trigger');
      if (!popup || !trigger) return;

      const show = () => {
        popup.removeAttribute('hidden');
        popup.style.display = '';
        popup.style.opacity = '1';
        popup.style.visibility = 'visible';
        popup.style.pointerEvents = 'auto';
      };
      const hide = () => {
        popup.style.display = 'none';
        popup.style.opacity = '0';
        popup.style.visibility = 'hidden';
        popup.style.pointerEvents = 'none';
        popup.setAttribute('hidden', '');
      };

      wrapper.addEventListener('mouseenter', show);
      wrapper.addEventListener('mouseleave', hide);
      trigger.addEventListener('focus', show);
      trigger.addEventListener('blur', hide);
    });
  }

  /** Mobile-only UX enhancements (no-op on desktop/tablet) */
  _setupMobile() {
    const mobileQuery = window.matchMedia('(max-width: 600px) and (pointer: coarse)');
    if (!mobileQuery.matches) return;

    // 1. Close drawers/panels when tapping outside on mobile
    const onMobilePointerDown = (e) => {
      if (!mobileQuery.matches) return;
      const vibPanel = document.getElementById('vibPanel');
      const vibToggle = document.getElementById('vibToggle');
      if (vibPanel?.classList.contains('show') && !vibPanel.contains(e.target) && e.target !== vibToggle) {
        vibPanel.classList.remove('show');
        vibToggle?.setAttribute('aria-expanded', 'false');
        vibToggle?.classList.remove('active');
        if (vibToggle) vibToggle.setAttribute('aria-expanded', 'false');
        vibToggle?.setAttribute('aria-expanded', 'false');
      }
      const recDrawer = document.getElementById('recordingsDrawer');
      const recBtn = document.getElementById('recordingsBtn');
      if (recDrawer?.classList.contains('show') && !recDrawer.contains(e.target) && e.target !== recBtn && !recBtn?.contains(e.target)) {
        recDrawer.classList.remove('show');
        if (recBtn) recBtn.setAttribute('aria-expanded', 'false');
        recBtn?.setAttribute('aria-expanded', 'false');
      }
      const helpTooltip = document.getElementById('helpTooltip');
      const helpBtn = document.getElementById('helpBtn');
      if (helpTooltip?.classList.contains('show') && !helpTooltip.contains(e.target) && e.target !== helpBtn) {
        helpTooltip.classList.remove('show');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
        helpBtn?.setAttribute('aria-expanded', 'false');
      }
    };
    document.addEventListener('pointerdown', onMobilePointerDown);
    this._disposables.push(() => document.removeEventListener('pointerdown', onMobilePointerDown));

    // 2. Prevent rubber-band bounce on iOS when scrolling at boundaries
    const appEl = document.getElementById('app');
    if (appEl) {
      appEl.style.overscrollBehavior = 'contain';
    }

    // 3. Add active state feedback for mobile tap via event delegation
    const mobileActiveSelector = '.btn, .btn-big, .rec-btn, .help-tab';
    const onTouchStart = (e) => {
      const el = e.target.closest(mobileActiveSelector);
      if (el) el.classList.add('mobile-active');
    };
    const onTouchEnd = (e) => {
      const el = e.target.closest(mobileActiveSelector);
      if (el) el.classList.remove('mobile-active');
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });
    this._disposables.push(
      () => document.removeEventListener('touchstart', onTouchStart),
      () => document.removeEventListener('touchend', onTouchEnd),
      () => document.removeEventListener('touchcancel', onTouchEnd)
    );

    // 4. Inject mobile active state CSS (visual feedback on tap)
    const mobileStyle = document.createElement('style');
    mobileStyle.textContent = `
      @media (max-width: 600px) and (pointer: coarse) {
        .mobile-active {
          opacity: 0.85;
          transform: scale(0.97) !important;
        }
      }
    `;
    document.head.appendChild(mobileStyle);

    // 5. Scroll fade indicators on horizontally-scrollable areas
    this._initScrollFades();
  }

  /** Attach scroll-fade edge indicators to horizontal scroll containers */
  _initScrollFades() {
    const scrollables = [
      document.querySelector('.hud-secondary'),
    ].filter(Boolean);

    const updateFade = (el) => {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      const threshold = 4;
      const canScrollLeft = scrollLeft > threshold;
      const canScrollRight = scrollLeft + clientWidth < scrollWidth - threshold;
      el.classList.toggle('fade-left', canScrollLeft && !canScrollRight);
      el.classList.toggle('fade-right', canScrollRight && !canScrollLeft);
      el.classList.toggle('fade-both', canScrollLeft && canScrollRight);
      if (!canScrollLeft && !canScrollRight) {
        el.classList.remove('fade-left', 'fade-right', 'fade-both');
      }
    };

    scrollables.forEach(el => {
      el.classList.add('mobile-scroll-fade');
      // Initial check (deferred to ensure layout is computed)
      requestAnimationFrame(() => updateFade(el));
      el.addEventListener('scroll', () => updateFade(el), { passive: true });
      // Re-check when children change (e.g. mode cards appearing)
      const resizeObs = new ResizeObserver(() => updateFade(el));
      resizeObs.observe(el);
      this._disposables.push(() => resizeObs.disconnect());
    });
  }


  _applyMotionPreferences() {
    const lowMotion = this.userMotionPreference === 'low' || (this.userMotionPreference === 'auto' && this.reducedMotion);
    this.baseParticleScale = lowMotion ? 0.15 : 1;
    this.particleScale = this.baseParticleScale * this.dynamicQualityScale;
    document.body.classList.toggle('low-motion', lowMotion);
  }

  _updateHelpContent() {
    const el = document.getElementById('helpHowTo');
    if (!el) return;
    const c = (color, label, desc) => ({ color, label, desc });
    const helpData = {
      ball: {
        title: 'Voice → Ball Mapping',
        items: [
          c('bounce', 'Bounciness', 'Pitch variation controls bounce height. Speak with intonation!'),
          c('vowel', 'Vowel Elongation', 'Sustained sounds grow the ball and leave trails.'),
          c('artic', 'Articulation', 'Sharp consonants create sparkle bursts. Be crisp!'),
        ],
      },
    };
    const data = helpData.ball;
    el.textContent = '';
    const h3 = document.createElement('h3');
    h3.textContent = data.title;
    const p = document.createElement('p');
    const fragment = document.createDocumentFragment();
    data.items.forEach((item, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement('br'));
        fragment.appendChild(document.createElement('br'));
      }
      const b = document.createElement('b');
      b.style.color = `var(--accent-${item.color})`;
      b.textContent = `${item.label}:`;
      fragment.append(b, ' ', item.desc);
    });
    p.appendChild(fragment);
    el.append(h3, p);
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    // FIX: Reset transform before scaling — prevents compound scaling on multiple resizes
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.groundY = this.height * 0.75;
    this.ball.y = this.groundY - this.ball.radius;

    // FIX: Generate stars sized to actual canvas dimensions
    this.stars = [];
    for (let i = 0; i < 80; i++) {
      this.stars.push({
        x: Math.random() * 3000,
        y: Math.random() * this.height * 0.55,
        size: Math.random() * 1.5 + 0.5,
        twinkle: Math.random() * Math.PI * 2
      });
    }

    // Generate mountain layers (procedural, infinite via sine sums)
    if (!this.mountainLayers) {
      this.mountainLayers = [
        // Far mountains — slow parallax, taller, lighter
        {
          parallax: 0.08, baseY: 0.52, layers: [
            { amp: 60, freq: 0.0008, phase: 0.0 },
            { amp: 30, freq: 0.002, phase: 1.2 },
            { amp: 15, freq: 0.005, phase: 3.7 },
          ]
        },
        // Mid mountains — medium parallax
        {
          parallax: 0.18, baseY: 0.58, layers: [
            { amp: 55, freq: 0.0012, phase: 2.1 },
            { amp: 25, freq: 0.003, phase: 0.5 },
            { amp: 12, freq: 0.007, phase: 4.2 },
          ]
        },
        // Near hills — faster parallax, smaller, darker
        {
          parallax: 0.35, baseY: 0.65, layers: [
            { amp: 35, freq: 0.002, phase: 4.5 },
            { amp: 18, freq: 0.005, phase: 1.8 },
            { amp: 8, freq: 0.012, phase: 0.3 },
          ]
        },
      ];
    }
    // Theme-aware mountain + ground colors
    const mtnColors = {
      highcontrast: ['#12122a', '#0e0e22', '#0a0a1a'],
    };
    const groundColors = {
      highcontrast: ['#14142a', '#101024', '#0c0c1e'],
    };
    const mc = mtnColors[this.themeMode] || mtnColors.highcontrast;
    this.mountainLayers[0].color = mc[0];
    this.mountainLayers[1].color = mc[1];
    this.mountainLayers[2].color = mc[2];
    this._groundColors = groundColors[this.themeMode] || groundColors.highcontrast;

    if (!this.isRunning) this.drawIdleScene();
  }

  // FIX: Infinite procedural terrain
  getGroundHeight(worldX) {
    let h = 0;
    for (const layer of this.terrainLayers) {
      h += layer.amplitude * Math.sin(worldX * layer.frequency + layer.phase);
    }
    return this.groundY + h * 0.4;
  }

  // FIX: Helper for proper HSLA color strings
  getBallColor(alpha) {
    if (alpha !== undefined) {
      return `hsla(${this.ballHue}, ${this.ballSat}%, ${this.ballLit}%, ${alpha})`;
    }
    return `hsl(${this.ballHue}, ${this.ballSat}%, ${this.ballLit}%)`;
  }

  // ============================================
  // RECORDING
  // Raw audio capture uses MediaRecorder against the live mic/input MediaStream
  // whenever one is available — it's encoded natively by the browser, off the
  // main thread, so it stays gapless regardless of how busy the UI/DSP work on
  // this thread gets. (An earlier AnalyserNode-polling capture — reading a 512-
  // sample/~11.6ms window on a setInterval tick — depended on that timer firing
  // exactly on time; any jitter from the per-frame pitch/formant analysis or
  // rendering caused polls to miss or double up windows, which is what produced
  // the choppy, broken-up played-back audio. That approach is kept only as a
  // fallback for inputs with no MediaStream, e.g. analyzing an uploaded file.)
  // A dedicated small-FFT analyser is still polled at matched intervals purely
  // to snapshot pitch/resonance/prosody metrics for phrase review — that data
  // path is independent of the audio encoding.
  // ============================================
  startRecording() {
    const a = this.analyzer;
    if (!a.audioCtx || !a.analyserRec || this.isRecording || this._recordingFinalizePromise) return false;
    const capacity = recordingCapacity(this.recordings);
    if (!capacity.ok) {
      const message = capacity.reason === 'clip-count'
        ? `Recording limit reached (${RECORDING_LIMITS.maxSavedRecordings} clips). Download and delete a clip before recording again.`
        : `Recording memory limit reached (${Math.round(RECORDING_LIMITS.maxRetainedAudioBytes / 1024 / 1024)} MB). Download and delete a clip before recording again.`;
      this._notifyRecording(message);
      return false;
    }

    const token = ++this._recordingGeneration;
    const startedAtMs = performance.now();
    const attempt = new RecordingAttempt({
      id: token,
      startedAtMs,
      retainedBytes: capacity.bytes,
    });
    this._recordingAttempt = attempt;
    this._recordingLimitStopRequested = false;
    try {
      this._recSampleRate = a.audioCtx.sampleRate;
      const fftSize = a.analyserRec.fftSize; // 512

      // Poll interval = window duration in ms (e.g. 512/44100*1000 ≈ 11.6ms)
      const intervalMs = Math.round(1000 * fftSize / this._recSampleRate);
      // Metrics are intentionally sampled at 25 Hz. Phrase timing remains frame-indexed,
      // while a ten-minute take retains at most 15,001 small snapshots.
      this._recTickSec = 1 / RECORDING_LIMITS.metricSamplesPerSecond;

      this._recUseMediaRecorder = !!(a.stream && typeof MediaRecorder !== 'undefined');
      this.recordingStartTime = startedAtMs;
      this.isRecording = true;

      this._recInterval = setInterval(() => {
        if (!this.isRecording || !attempt.accepts(token) || !a.analyserRec) return;
        const nowMs = performance.now();
        a.analyserRec.getFloatTimeDomainData(a.recTimeDomainData);

        // Speech gate: compute local RMS and check against analyzer's noise floor
        // plus pitch confidence. Non-speech frames become silence (preserves timing).
        const data = a.recTimeDomainData;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const localRms = Math.sqrt(sum / data.length);
        const threshold = a.isCalibrated ? a.noiseFloor * 2.5 : 0.02;
        const isSpeech = localRms > threshold || a.pitchConfidence > 0.3;

        if (!this._recUseMediaRecorder) {
          // The no-MediaRecorder fallback keeps Int16 windows (half the old Float32
          // footprint). Silence stays explicit so clip timing is never compressed.
          const frame = isSpeech ? data : new Float32Array(data.length);
          if (attempt.addPcmFrame(token, frame)) this._requestRecordingLimitStop('memory', token);
        }

        // Snapshot live analysis so the clip can carry review metrics. The attempt owns
        // and rate-limits this array; the recorder timer itself may run faster for PCM.
        attempt.addMetric(token, nowMs, {
          hz: a.smoothPitchHz,
          conf: a.pitchConfidence,
          voiced: isSpeech && a.lastPitch > 0,
          // Clip review is a presentation surface: it reads CONTROL, the same number the ball
          // showed while the clip was being recorded. A suppressed frame has no reading and is
          // excluded from the clip average by `voiced`, so it is never averaged in as 0.
          res: a.resonanceControl,
          resMetricVersion: RESONANCE_METRIC_VERSION,
          prosody: this.prosodyScore,
          energy: localRms,       // raw window RMS (pre-gate) → phrase segmentation contour
          syl: a.syllableImpulse, // decaying onset impulse → word-split boundary hints
        });
        if (attempt.durationLimitReached(nowMs)) this._requestRecordingLimitStop('duration', token);
      }, intervalMs);
      this._recDurationTimer = setTimeout(
        () => this._requestRecordingLimitStop('duration', token),
        RECORDING_LIMITS.maxDurationMs,
      );

      if (this._recUseMediaRecorder) {
        const mimeType = this._pickRecordingMimeType();
        const options = { audioBitsPerSecond: 128000 };
        if (mimeType) options.mimeType = mimeType;
        this._mediaRecorder = new MediaRecorder(a.stream, options);
        this._recMimeType = this._mediaRecorder.mimeType || mimeType || 'audio/webm';
        this._mediaRecorder.ondataavailable = (e) => {
          if (!attempt.accepts(token)) return;
          if (attempt.addEncodedChunk(token, e.data)) this._requestRecordingLimitStop('memory', token);
        };
        this._mediaRecorder.onerror = (e) => {
          if (!attempt.accepts(token)) return;
          console.error('MediaRecorder error:', e && e.error ? e.error : e);
          this.cancelRecording('recorder-error');
          this._notifyRecording('Recording stopped because the browser recorder failed. No clip was saved.');
        };
        // One-second chunks make active encoded memory countable and let the byte cap
        // stop a take promptly instead of receiving one unbounded Blob at the end.
        this._mediaRecorder.start(RECORDING_LIMITS.mediaRecorderTimesliceMs);
      }
      return true;
    } catch (e) {
      console.error('Recording failed:', e);
      this.cancelRecording('start-failure');
      this._notifyRecording('Recording could not start. No clip was saved.');
      return false;
    }
  }

  _notifyRecording(message, tone = 'error') {
    if (this._showRecordingStatus) {
      this._showRecordingStatus(message, { tone, autoHideMs: tone === 'info' ? 7000 : 0 });
    } else {
      console.warn(message);
    }
  }

  _requestRecordingLimitStop(reason, token) {
    if (this._recordingLimitStopRequested || !this._recordingAttempt?.accepts(token)) return;
    this._recordingLimitStopRequested = true;
    queueMicrotask(async () => {
      if (!this._recordingAttempt?.accepts(token)) return;
      await this.stopRecording();
      const message = reason === 'duration'
        ? 'Recording reached the 10-minute limit and was saved.'
        : 'Recording reached its memory limit and was saved.';
      this._notifyRecording(message, 'info');
    });
  }

  _pickRecordingMimeType() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/mp4;codecs=mp4a.40.2', // Safari
      'audio/mp4',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return null;
  }

  stopRecording() {
    if (!this.isRecording) return this._recordingFinalizePromise || Promise.resolve();
    const attempt = this._recordingAttempt;
    if (!attempt) return Promise.resolve();
    const token = attempt.id;
    this.isRecording = false;

    if (this._recInterval) {
      clearInterval(this._recInterval);
      this._recInterval = null;
    }
    if (this._recDurationTimer) clearTimeout(this._recDurationTimer);
    this._recDurationTimer = null;

    const finalizePromise = new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (this._recStopTimer) clearTimeout(this._recStopTimer);
        this._recStopTimer = null;
        const recorder = this._mediaRecorder;
        if (recorder) {
          recorder.ondataavailable = null;
          recorder.onstop = null;
          recorder.onerror = null;
        }
        this._mediaRecorder = null;
        if (this._recordingAttempt === attempt) this._recordingAttempt = null;
        this._recordingLimitStopRequested = false;
        this._updateVoiceRecBtn();
        resolve();
      };

      const abort = () => {
        attempt.clear();
        this._clearPendingRecordingMetadata();
        settle();
      };

      const finalize = (audioBlob, mimeType, resources) => {
        try {
          if (token !== this._recordingGeneration || !resources || !(audioBlob?.size > 0)) {
            abort();
            return;
          }
          const metricSamples = resources.metricSamples;
          // Summarize the metric snapshots into per-clip review stats (null = no usable voice)
          const metrics = summarizeClipMetrics(metricSamples);
          // Practice takes carry the known phrase → segment + align + per-word analysis,
          // then the coaching layer (phrase-coach.js) turns it into scores + a sparkline.
          const phrase = this._pendingPhrase;
          const phraseDef = this._pendingPhraseDef;
          this._pendingPhrase = null;
          this._pendingPhraseDef = null;
          const phraseAnalysis = phrase
            ? summarizePhraseTake(metricSamples, phrase, {
                tickSec: this._recTickSec,
                noiseFloor: this.analyzer.isCalibrated ? this.analyzer.noiseFloor : 0,
              })
            : null;
          const phraseScore = phraseDef && phraseAnalysis
            ? scorePhraseTake(phraseAnalysis, phraseDef, { goalMode: this.goalMode })
            : null;
          const contourSeries = phraseAnalysis && phraseAnalysis.overall
            ? buildContourSeries(metricSamples, { tickSec: this._recTickSec })
            : null;
          resources.metricSamples = [];
          const label = this._pendingClipLabel;
          this._pendingClipLabel = null;

          const duration = (performance.now() - this.recordingStartTime) / 1000;
          const now = new Date();
          const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const fileTs = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

          // The Blob is the sole retained audio copy. Playback/export create short-lived
          // object URLs and release them when that consumer finishes.
          this.recordings.push({
            id: `clip-${token}`,
            blob: audioBlob,
            duration,
            timestamp: ts,
            name: `vox-ball-${fileTs}`,
            mimeType,
            metrics,
            label,
            phrase,
            phraseAnalysis,
            phraseScore,
            contourSeries,
          });
          this.updateRecordingsUI();
          settle();
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          console.error(`Recording save error (${e && e.name || 'Error'}): ${msg}`, e);
          abort();
        }
      };

      try {
        if (this._recUseMediaRecorder && this._mediaRecorder) {
          const mr = this._mediaRecorder;
          const mimeType = this._recMimeType || 'audio/webm';
          mr.onstop = () => {
            const resources = attempt.detach(token);
            if (!resources || resources.encodedChunks.length === 0) { abort(); return; }
            finalize(new Blob(resources.encodedChunks, { type: mimeType }), mimeType, resources);
          };
          mr.onerror = (e) => {
            console.error('MediaRecorder error:', e && e.error ? e.error : e);
            abort();
            this._notifyRecording('Recording stopped because the browser recorder failed. No clip was saved.');
          };
          if (mr.state !== 'inactive') {
            mr.stop();
            // Broken implementations have failed to deliver `stop`; never retain the
            // attempt arrays or leave session shutdown waiting forever.
            this._recStopTimer = setTimeout(abort, RECORDING_LIMITS.recorderStopTimeoutMs);
          }
          else abort();
        } else {
          const resources = attempt.detach(token);
          if (!resources || resources.pcmChunks.length === 0) { abort(); return; }
          finalize(this._encodeWAV(resources.pcmChunks, this._recSampleRate), 'audio/wav', resources);
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error(`Recording save error (${e && e.name || 'Error'}): ${msg}`, e);
        abort();
      }
    });
    this._recordingFinalizePromise = finalizePromise;
    return finalizePromise.finally(() => {
      if (this._recordingFinalizePromise === finalizePromise) this._recordingFinalizePromise = null;
    });
  }

  cancelRecording(reason = 'cancelled') {
    const attempt = this._recordingAttempt;
    ++this._recordingGeneration;
    this.isRecording = false;
    if (this._recInterval) clearInterval(this._recInterval);
    this._recInterval = null;
    if (this._recStopTimer) clearTimeout(this._recStopTimer);
    this._recStopTimer = null;
    if (this._recDurationTimer) clearTimeout(this._recDurationTimer);
    this._recDurationTimer = null;
    const recorder = this._mediaRecorder;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) { /* already failed */ }
    }
    this._mediaRecorder = null;
    attempt?.clear();
    this._recordingAttempt = null;
    this._recordingFinalizePromise = null;
    this._recordingLimitStopRequested = false;
    this._clearPendingRecordingMetadata();
    this._updateVoiceRecBtn();
    return reason;
  }

  _clearPendingRecordingMetadata() {
    this._pendingClipLabel = null;
    this._pendingPhrase = null;
    this._pendingPhraseDef = null;
  }

  // DAF (Delayed Auditory Feedback) is a native Web Audio delay line living in
  // daf-engine.js — see that file for why it is a DelayNode and not a JS
  // buffer loop. These wrappers just bind it to the analyzer's live graph.
  startDAF() {
    const a = this.analyzer;
    const started = this.daf.start(a?.audioCtx, a?.source);
    // Reapply the saved sink: a fresh context always comes up on the system
    // default, so without this the choice silently reverts every session.
    if (started && this.dafOutputDeviceId) {
      this.daf.setOutputDevice(this.dafOutputDeviceId).catch(() => {});
    }
  }

  stopDAF() {
    this.daf.stop();
  }

  /** True while the DAF delay line is live in the audio graph. */
  get dafActive() {
    return this.daf.active;
  }

  /**
   * Refresh the "what you actually hear" line under the delay slider.
   *
   * The slider sets the DelayNode, but a Bluetooth sink buffers 150-250ms on
   * top of it, which is what makes DAF feel broken on wireless headphones —
   * the delay is real, it is just far past the window where it does anything.
   * `outputLatency` is the only part of that we can measure, so show it rather
   * than let the slider imply a number it does not deliver.
   */
  _updateDafLatencyReadout() {
    const el = document.getElementById('dafLatencyReadout');
    if (!el) return;

    if (!this.dafEnabled) {
      el.textContent = '';
      el.className = 'daf-latency';
      return;
    }

    // Only meaningful against a live context — a closed/absent one reports
    // nothing useful, and guessing there would be worse than saying nothing.
    const ctx = this.analyzer?.audioCtx;
    if (!ctx || ctx.state === 'closed') {
      el.textContent = 'Start a session to see the delay you actually hear.';
      el.className = 'daf-latency';
      return;
    }

    const { status, text } = describeEffectiveDelay(this.dafDelayMs, outputLatencyMs(ctx));
    el.textContent = text;
    el.className = `daf-latency is-${status}`;
  }

  /**
   * Fill the DAF output picker and explain what to do when nothing is audible.
   *
   * Output selection is far less available than input selection: Android Chrome
   * enumerates no audiooutput devices at all, and Safari exposes none either.
   * An empty list is the normal case on a phone, not an error, so the hint has
   * to carry the explanation instead of the dropdown.
   */
  async _refreshDafOutputs() {
    const select = document.getElementById('dafOutputSelect');
    const hint = document.getElementById('dafOutputHint');
    if (!select || !hint) return;

    // Fall back to the prototype probe: the panel opens before any session, and
    // asking a null context would wrongly report the browser as incapable.
    const ctx = this.analyzer?.audioCtx;
    const canSelectSink = ctx ? supportsOutputSelection(ctx) : browserSupportsOutputSelection();

    let outputs = [];
    if (canSelectSink && navigator.mediaDevices?.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        outputs = devices.filter((d) => d.kind === 'audiooutput');
      } catch (e) {
        outputs = [];
      }
    }

    select.textContent = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'System Default';
    select.appendChild(defaultOption);
    outputs.forEach((out, idx) => {
      const option = document.createElement('option');
      option.value = out.deviceId;
      option.textContent = out.label || `Output ${idx + 1}`;
      select.appendChild(option);
    });
    select.value = this.dafOutputDeviceId || '';
    select.disabled = !canSelectSink || outputs.length === 0;

    hint.textContent = diagnoseSilentOutput({
      canSelectSink,
      outputDeviceCount: outputs.length,
      echoCancellation: this.micInputPreferences?.echoCancellation,
    }).text;
  }

  /**
   * Poll the readout while the DAF panel is open — headphones can connect or
   * drop mid-session, which changes the sink latency under us.
   *
   * Self-terminates when the panel closes so the many places that hide the
   * panel (outside click, Escape, opening another panel, session stop) don't
   * each need to remember to stop the timer.
   */
  _startDafLatencyWatch() {
    this._stopDafLatencyWatch();
    this._updateDafLatencyReadout();
    this._dafLatencyTimer = setInterval(() => {
      if (!document.getElementById('dafPanel')?.classList.contains('show')) {
        this._stopDafLatencyWatch();
        return;
      }
      this._updateDafLatencyReadout();
    }, 1500);
  }

  _stopDafLatencyWatch() {
    if (this._dafLatencyTimer) {
      clearInterval(this._dafLatencyTimer);
      this._dafLatencyTimer = null;
    }
  }

  _encodeWAV(chunks, sampleRate) {
    // PCM 16-bit mono WAV
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    let sampleCount = 0;
    for (const chunk of chunks) sampleCount += chunk.length;
    const dataLength = sampleCount * blockAlign;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // RIFF header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    this._writeString(view, 8, 'WAVE');

    // fmt chunk
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // chunk size
    view.setUint16(20, 1, true);            // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Copy the already-quantized frames directly. Keeping Int16 during capture halves
    // fallback retention and avoids a full merged Float32 allocation at stop.
    let p = 44;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        view.setInt16(p, chunk[i], true);
        p += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  _writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  playRecording(index) {
    const rec = this.recordings[index];
    if (!rec) return;
    this.stopPlayback();

    const audio = new Audio();
    audio.volume = 1.0;
    const url = this._recordingUrls.create(rec.blob, `playback:${rec.id}`);
    const playback = {
      token: ++this._playbackGeneration,
      audio,
      url,
      recordingId: rec.id,
      indexAtStart: index,
      listeners: [],
    };
    this.currentPlayback = playback;
    this.updateRecItemState(index, true);
    this._updateVoiceRecBtn();

    const on = (type, listener, options) => {
      audio.addEventListener(type, listener, options);
      playback.listeners.push([type, listener, options]);
      this._recordingListenerCount++;
    };
    on('timeupdate', () => {
      if (this.currentPlayback !== playback) return;
      const progress = audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0;
      const currentIndex = this.recordings.findIndex((item) => item.id === playback.recordingId);
      const el = document.getElementById(`rec-progress-${currentIndex}`);
      if (el) el.style.width = progress + '%';
    });

    on('ended', () => {
      if (this.currentPlayback === playback) this._cleanupPlayback(playback);
    });

    on('error', (e) => {
      if (this.currentPlayback !== playback) return;
      const detail = audio.error ? `${audio.error.code}: ${audio.error.message}` : String(e);
      console.error(`Audio playback error: ${detail}`);
      this._cleanupPlayback(playback);
    });

    // Wait for audio to be loadable before playing
    on('canplay', () => {
      if (this.currentPlayback !== playback) return;
      audio.play().catch(e => {
        if (this.currentPlayback !== playback) return;
        console.error('Playback failed:', e);
        this._cleanupPlayback(playback);
      });
    }, { once: true });

    audio.src = url;
    audio.load();
  }

  stopPlayback() {
    this.stopSpeech(); // only one audio source (recorded clip or spoken feedback) plays at a time
    if (this.currentPlayback) this._cleanupPlayback(this.currentPlayback);
  }

  _cleanupPlayback(playback) {
    if (!playback) return;
    const { audio } = playback;
    for (const [type, listener, options] of playback.listeners.splice(0)) {
      audio.removeEventListener(type, listener, options);
      this._recordingListenerCount--;
    }
    audio.pause();
    audio.removeAttribute('src');
    audio.load(); // releases the browser's decoded/media pipeline before URL revocation
    this._recordingUrls.release(playback.url);
    const currentIndex = this.recordings.findIndex((item) => item.id === playback.recordingId);
    if (currentIndex >= 0) this.updateRecItemState(currentIndex, false);
    const oldProgress = document.getElementById(`rec-progress-${playback.indexAtStart}`);
    if (oldProgress) oldProgress.style.width = '0%';
    if (this.currentPlayback === playback) this.currentPlayback = null;
    this._updateVoiceRecBtn();
  }

  // Speak a short summary of the practice results via the browser's built-in TTS.
  // Returns false (and does nothing) when speechSynthesis isn't available.
  speakPhraseSummary(text) {
    if (!('speechSynthesis' in window)) return false;
    this.stopPlayback(); // mutual exclusion with recorded-clip playback (also cancels prior speech)
    const utter = new SpeechSynthesisUtterance(text);
    utter.onend = () => { this.currentSpeech = null; this._updatePracticeSpeakBtn(); };
    utter.onerror = () => { this.currentSpeech = null; this._updatePracticeSpeakBtn(); };
    this.currentSpeech = utter;
    window.speechSynthesis.speak(utter);
    this._updatePracticeSpeakBtn();
    return true;
  }

  stopSpeech() {
    if (this.currentSpeech) {
      window.speechSynthesis.cancel();
      this.currentSpeech = null;
      this._updatePracticeSpeakBtn();
    }
  }

  // Keep the "Hear feedback" button label in sync with in-flight speech.
  _updatePracticeSpeakBtn() {
    const btn = document.getElementById('practiceSpeakBtn');
    if (!btn) return;
    btn.textContent = this.currentSpeech ? '⏹ Stop speaking' : '🔊 Hear feedback';
  }

  updateRecItemState(index, isPlaying) {
    const btn = document.getElementById(`rec-play-${index}`);
    if (btn) {
      btn.textContent = isPlaying ? '⏸' : '▶';
      btn.classList.toggle('playing', isPlaying);
    }
  }

  // Keep the always-visible top-bar Record/Play buttons in sync with recording + playback state.
  _updateVoiceRecBtn() {
    const legacyRecBtn = document.getElementById('recBtn');
    if (legacyRecBtn) {
      legacyRecBtn.classList.toggle('recording', !!this.isRecording);
      legacyRecBtn.setAttribute('aria-pressed', String(!!this.isRecording));
      const legacyLabel = legacyRecBtn.querySelector('.rec-label');
      if (legacyLabel) legacyLabel.textContent = this.isRecording ? 'Stop' : 'Rec';
    }
    const recBtn = document.getElementById('voiceRecBtn');
    if (recBtn) {
      recBtn.classList.toggle('recording', !!this.isRecording);
      recBtn.setAttribute('aria-pressed', String(!!this.isRecording));
      const label = recBtn.querySelector('.voice-rec-label');
      if (label) label.textContent = this.isRecording ? 'Stop' : 'Record';
    }
    const playBtn = document.getElementById('voicePlayBtn');
    if (playBtn) {
      const lastIdx = this.recordings.length - 1;
      const lastId = this.recordings[lastIdx]?.id;
      const playingLast = !!(this.currentPlayback && this.currentPlayback.recordingId === lastId);
      playBtn.disabled = lastIdx < 0 || this.isRecording;
      playBtn.classList.toggle('playing', playingLast);
      // Keep the practice panel's Record/Done button in sync however recording was toggled.
      if (this.practice?.active) this._renderPractice();
      const plabel = playBtn.querySelector('.voice-play-label');
      if (plabel) plabel.textContent = playingLast ? ' Stop' : ' Play';
    }
  }

  // ============================================
  // GUIDED PHRASE PRACTICE
  // Two-stage flow per phrase: 'prompt' (read & record the phrase) → 'results'
  // (word-by-word + overall breakdown of the take, with Retry / Next). Takes are
  // saved as labeled clips; finishing opens the Clips drawer so the per-clip
  // metrics are reviewable side by side.
  // ============================================
  startPractice() {
    this.practice.active = true;
    this.practice.index = 0;
    this.practice.stage = 'prompt';
    this.practice.notice = null;
    this.practice.takeIndex = -1;
    this._renderPractice();
    document.getElementById('practicePanel')?.classList.add('show');
    document.getElementById('practiceBtn')?.setAttribute('aria-expanded', 'true');
  }

  async endPractice(openDrawer) {
    if (this.isRecording) {
      await this._practiceStopTake();
    }
    this.practice.active = false;
    this.practice.stage = 'prompt';
    this.practice.notice = null;
    this.practice.takeIndex = -1;
    document.getElementById('practicePanel')?.classList.remove('show');
    document.getElementById('practiceBtn')?.setAttribute('aria-expanded', 'false');
    if (openDrawer && this.recordings.length > 0) {
      // Deferred: the click that ends practice is still bubbling, and the global
      // outside-click handler would immediately close the drawer we just opened.
      setTimeout(() => {
        document.getElementById('recordingsDrawer')?.classList.add('show');
        document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'true');
      }, 0);
    }
  }

  // Stop the current take and save it labeled with the phrase being practiced.
  // _pendingPhrase carries the known phrase text into stopRecording, which runs the
  // word-by-word analysis (.phraseAnalysis); _pendingPhraseDef carries the phrase's
  // coaching definition, which adds scores + takeaway (.phraseScore).
  async _practiceStopTake() {
    const def = PRACTICE_PHRASES[this.practice.index];
    this._pendingClipLabel = `Practice: “${def.text}”`;
    this._pendingPhrase = def.text;
    this._pendingPhraseDef = def;
    await this.stopRecording();
    this._updateVoiceRecBtn();
  }

  async _practiceRecordToggle() {
    if (!this.practice.active) return;
    if (this.isRecording) {
      await this._practiceStopTake();
      const rec = this.recordings[this.recordings.length - 1];
      const analysis = rec && rec.phrase === PRACTICE_PHRASES[this.practice.index].text ? rec.phraseAnalysis : null;
      if (analysis && analysis.overall) {
        this.practice.stage = 'results';
        this.practice.notice = null;
        this.practice.takeIndex = this.recordings.length - 1;
      } else {
        // Silent / unusable take: stay on the prompt so the user can retry immediately.
        this.practice.notice = 'No speech detected — try again.';
      }
    } else {
      this.practice.notice = null;
      this.startRecording();
      this._updateVoiceRecBtn();
    }
    this._renderPractice();
  }

  // From the results stage: re-record the same phrase.
  _practiceRetry() {
    if (!this.practice.active) return;
    this.practice.stage = 'prompt';
    this.practice.takeIndex = -1;
    this._renderPractice();
  }

  // From the results stage: advance to the next phrase, or finish after the last one.
  async _practiceNext() {
    if (!this.practice.active || this.practice.stage !== 'results') return;
    if (this.practice.index + 1 >= PRACTICE_PHRASES.length) {
      await this.endPractice(true); // done — open the drawer to review the takes
      return;
    }
    this.practice.index++;
    this.practice.stage = 'prompt';
    this.practice.takeIndex = -1;
    this._renderPractice();
  }

  _practiceSkip() {
    if (!this.practice.active || this.isRecording || this.practice.stage === 'results') return;
    this.practice.notice = null;
    if (this.practice.index + 1 >= PRACTICE_PHRASES.length) {
      this.endPractice(this.recordings.length > 0);
      return;
    }
    this.practice.index++;
    this._renderPractice();
  }

  _renderPractice() {
    const idx = this.practice.index;
    const def = PRACTICE_PHRASES[idx];
    const results = this.practice.stage === 'results';
    // Results stage grows the phone sheet to full height (see .has-results) so
    // the word-by-word breakdown gets the screen instead of a sliver.
    const panel = document.getElementById('practicePanel');
    panel?.classList.toggle('has-results', results);
    // The panel body scrolls (results can be taller than the screen); a new
    // phrase or stage should start at the top rather than mid-scroll.
    const body = document.getElementById('practiceBody');
    const key = `${idx}:${this.practice.stage}`;
    if (body && this._practiceViewKey !== key) {
      this._practiceViewKey = key;
      body.scrollTop = 0;
    }
    const progress = document.getElementById('practiceProgress');
    if (progress) progress.textContent = `Phrase ${idx + 1} of ${PRACTICE_PHRASES.length}`;
    const phrase = document.getElementById('practicePhrase');
    if (phrase) phrase.textContent = def.text;
    const hint = document.getElementById('practiceHint');
    if (hint) {
      hint.textContent = results
        ? 'Word-by-word breakdown of your take.'
        : this.isRecording
          ? 'Recording — read the phrase, then press Done.'
          : (this.practice.notice || practiceTipForGoal(def, this.goalMode) || 'Press Record, read the phrase aloud, then press Done.');
    }
    const recBtn = document.getElementById('practiceRecordBtn');
    if (recBtn) {
      recBtn.hidden = results;
      recBtn.classList.toggle('recording', !!this.isRecording);
      recBtn.textContent = '';
      recBtn.append(
        Object.assign(document.createElement('span'), { className: 'rec-dot' }),
        document.createTextNode(this.isRecording ? ' Done — see analysis' : ' Record')
      );
    }
    const skipBtn = document.getElementById('practiceSkipBtn');
    if (skipBtn) {
      skipBtn.hidden = results;
      skipBtn.disabled = !!this.isRecording;
    }
    const retryBtn = document.getElementById('practiceRetryBtn');
    if (retryBtn) retryBtn.hidden = !results;
    const nextBtn = document.getElementById('practiceNextBtn');
    if (nextBtn) {
      nextBtn.hidden = !results;
      nextBtn.textContent = idx + 1 >= PRACTICE_PHRASES.length ? 'Finish' : 'Next phrase';
    }
    const playBtn = document.getElementById('practicePlayBtn');
    if (playBtn) playBtn.hidden = !results;
    const speakBtn = document.getElementById('practiceSpeakBtn');
    if (speakBtn) speakBtn.hidden = !results || !('speechSynthesis' in window);
    if (!results) this.stopSpeech(); // don't keep talking about a take the user has left
    const resultsEl = document.getElementById('practiceResults');
    if (resultsEl) {
      resultsEl.hidden = !results;
      // Render after unhiding so the sparkline canvas measures a real width.
      if (results) this._renderPracticeResults();
    }
  }

  // Score → severity tier shared by the results word cards and the Clips drawer chips.
  static scoreClass(score) {
    return score >= 75 ? 'good' : score >= 50 ? 'ok' : 'low';
  }

  // Render the take shown in the results stage (practice.takeIndex) into
  // #practiceResults: score + takeaway header, pitch-contour sparkline, word
  // cards (with coaching scores when available), overall chips, and the
  // segmentation caveat.
  _renderPracticeResults() {
    const box = document.getElementById('practiceResults');
    const rec = this.recordings[this.practice.takeIndex];
    const analysis = rec?.phraseAnalysis;
    if (!box || !analysis) return;
    const scored = rec.phraseScore;
    box.textContent = '';

    // Coaching header: take score + one-line takeaway.
    if (scored) {
      const header = Object.assign(document.createElement('div'), { className: 'practice-score-header' });
      header.append(
        Object.assign(document.createElement('span'), {
          className: `practice-score ${VoxBallGame.scoreClass(scored.score)}`,
          textContent: String(scored.score),
        }),
        Object.assign(document.createElement('span'), { className: 'practice-takeaway', textContent: scored.takeaway })
      );
      box.appendChild(header);
    }

    // Pitch contour sparkline with word-boundary ticks.
    if (rec.contourSeries && rec.contourSeries.length > 0) {
      const canvas = Object.assign(document.createElement('canvas'), { className: 'practice-spark' });
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Pitch contour of your take');
      box.appendChild(canvas);
      if (!this._drawPhraseSpark(canvas, rec.contourSeries, analysis.words)) canvas.remove();
    }

    const wordsRow = Object.assign(document.createElement('div'), { className: 'practice-words' });
    (analysis.words || []).forEach((w, i) => {
      const sw = scored?.words?.[i];
      const tier = sw ? ` ${VoxBallGame.scoreClass(sw.score)}` : '';
      const card = document.createElement('div');
      card.className = `word-card${w.metrics ? '' : ' muted'}${w.matched ? '' : ' estimated'}${tier}`;
      const titleBits = [];
      if (!w.matched) titleBits.push('Estimated — this word boundary was inferred, not detected');
      if (sw?.note) titleBits.push(sw.note);
      if (titleBits.length) card.title = titleBits.join(' · ');
      card.append(
        Object.assign(document.createElement('div'), { className: 'word-card-text', textContent: w.word }),
        Object.assign(document.createElement('div'), { className: 'word-card-metric', textContent: w.metrics ? `~${Math.round(w.metrics.pitchAvgHz)} Hz` : '—' }),
        Object.assign(document.createElement('div'), { className: 'word-card-metric', textContent: `${w.durSec.toFixed(2)}s` })
      );
      if (sw) {
        card.appendChild(Object.assign(document.createElement('div'), {
          className: 'word-card-score', textContent: String(sw.score),
        }));
      }
      const track = Object.assign(document.createElement('div'), { className: 'word-loud-bar' });
      const fill = Object.assign(document.createElement('div'), { className: 'word-loud-fill' });
      fill.style.width = `${Math.round(clamp01(w.relLoudness / 1.5) * 100)}%`;
      track.appendChild(fill);
      card.appendChild(track);
      wordsRow.appendChild(card);
    });
    box.appendChild(wordsRow);

    const overallRow = Object.assign(document.createElement('div'), { className: 'practice-overall' });
    const chip = (text, extraClass = '') => Object.assign(
      document.createElement('span'),
      { className: `rec-chip${extraClass ? ' ' + extraClass : ''}`, textContent: text }
    );
    const o = analysis.overall;
    if (o) {
      overallRow.append(
        chip(`avg ${Math.round(o.pitchAvgHz)} Hz`),
        chip(`${Math.round(o.pitchMinHz)}–${Math.round(o.pitchMaxHz)} Hz`),
        chip(o.resonanceAvg != null ? `res ${Math.round(o.resonanceAvg * 100)}%` : 'res —'),
        chip(`pros ${Math.round(o.prosodyAvg * 100)}%`),
        chip(`range ${o.pitchRangeSemitones.toFixed(1)} st`),
        chip(`pace ${o.paceWps.toFixed(1)} w/s`),
        chip(`pauses ${o.pauseCount} (${o.pauseTotalSec.toFixed(1)}s)`),
        chip(o.contour)
      );
    } else {
      overallRow.appendChild(chip('no voice data', 'muted'));
    }
    box.appendChild(overallRow);

    const seg = analysis.segmentation;
    if (seg && seg.status !== 'exact') {
      const note = Object.assign(document.createElement('div'), { className: 'practice-seg-note' });
      const chunks = `${seg.runCount} speech chunk${seg.runCount === 1 ? '' : 's'}`;
      note.textContent = seg.lowConfidence
        ? `Heard ${chunks} for ${seg.wordCount} words — word boundaries are rough estimates. A quieter room or clearer pauses will sharpen them.`
        : `Heard ${chunks} for ${seg.wordCount} words — word stats are estimated.`;
      box.appendChild(note);
    }
  }

  // Draw the take's pitch contour (semitone-scaled) with word-boundary ticks.
  // Returns false when there are too few voiced points to be worth drawing.
  _drawPhraseSpark(canvas, series, words) {
    // ⚡ Bolt: Replaced .filter, .map, and array spread with a single zero-allocation pass.
    // Reduces intermediate arrays and avoids Math.min/max stack overflow risks on long arrays.
    let voicedCount = 0;
    let stLo = Infinity;
    let stHi = -Infinity;
    for (let i = 0; i < series.length; i++) {
      const p = series[i];
      if (p.hz != null) {
        voicedCount++;
        const st = 12 * Math.log2(p.hz / 100);
        if (st < stLo) stLo = st;
        if (st > stHi) stHi = st;
      }
    }
    if (voicedCount < 4) return false;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.parentElement?.clientWidth || 300;
    const cssH = 56;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const t0 = series[0].t;
    const t1 = series[series.length - 1].t;
    const spanT = Math.max(0.001, t1 - t0);
    // Semitone scaling so equal musical moves get equal height anywhere in the range.
    if (stHi - stLo < 2) { const mid = (stLo + stHi) / 2; stLo = mid - 1; stHi = mid + 1; }
    const pad = 6;
    const x = (t) => pad + ((t - t0) / spanT) * (cssW - 2 * pad);
    const y = (hz) => {
      const st = 12 * Math.log2(hz / 100);
      return cssH - pad - ((st - stLo) / (stHi - stLo)) * (cssH - 2 * pad);
    };

    // Word-boundary ticks behind the contour (skip fallback slots with no span).
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    for (const w of words || []) {
      if (!(w.durSec > 0)) continue;
      ctx.beginPath();
      ctx.moveTo(x(w.startSec), 2);
      ctx.lineTo(x(w.startSec), cssH - 2);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(127, 215, 255, 0.95)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    let penDown = false;
    ctx.beginPath();
    for (const p of series) {
      if (p.hz == null) { penDown = false; continue; }
      if (!penDown) { ctx.moveTo(x(p.t), y(p.hz)); penDown = true; }
      else ctx.lineTo(x(p.t), y(p.hz));
    }
    ctx.stroke();
    return true;
  }

  downloadRecording(index) {
    const rec = this.recordings[index];
    if (!rec) return;
    if (this._recordingUrls.snapshot().objectUrlTimers >= RECORDING_LIMITS.maxPendingDownloads) {
      this._notifyRecording('Several downloads are still starting. Wait a moment, then try again.', 'info');
      return;
    }
    const url = this._recordingUrls.create(rec.blob, `download:${rec.id}`);
    const a = document.createElement('a');
    try {
      a.href = url;
      a.download = `${rec.name}${this._extensionForMimeType(rec.mimeType)}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoking inside the click task races Safari/Firefox download hand-off. A short,
      // tracked grace period keeps the Blob alive for that consumer and remains bounded.
      this._recordingUrls.releaseAfter(url, RECORDING_LIMITS.downloadUrlReleaseMs);
    } catch (error) {
      a.remove();
      this._recordingUrls.release(url);
      throw error;
    }
  }

  _extensionForMimeType(mimeType) {
    if (!mimeType) return '.wav';
    if (mimeType.includes('webm')) return '.webm';
    if (mimeType.includes('mp4')) return '.m4a';
    if (mimeType.includes('ogg')) return '.ogg';
    return '.wav';
  }

  deleteRecording(index) {
    const recording = this.recordings[index];
    if (!recording) return;
    if (this.currentPlayback && this.currentPlayback.recordingId === recording.id) {
      this.stopPlayback();
    }
    this.recordings.splice(index, 1);
    this.updateRecordingsUI();
  }

  clearAllRecordings() {
    this.stopPlayback();
    this.recordings = [];
    this.updateRecordingsUI();
  }

  getRecordingResourceSnapshot() {
    const attempt = this._recordingAttempt?.snapshot() || {
      activeChunks: 0,
      activeAudioBytes: 0,
      activeMetricSamples: 0,
      audioByteLimit: 0,
    };
    const urlState = this._recordingUrls.snapshot();
    const streamTracks = this.analyzer.stream?.getTracks?.() || [];
    const liveTracks = streamTracks.filter((track) => track.readyState !== 'ended').length;
    return {
      retainedAudioBytes: retainedAudioBytes(this.recordings),
      retainedChunks: this.recordings.length,
      retainedMetricSamples: retainedMetricSamples(this.recordings),
      activeChunks: attempt.activeChunks,
      activeAudioBytes: attempt.activeAudioBytes,
      activeMetricSamples: attempt.activeMetricSamples,
      activeObjectUrls: urlState.activeObjectUrls,
      liveStreams: liveTracks > 0 ? 1 : 0,
      liveTracks,
      liveRecordingNodes: this.analyzer.analyserRec ? 1 : 0,
      liveAudioElements: this.currentPlayback ? 1 : 0,
      recordingTimers: Number(this._recInterval != null) + Number(this._recDurationTimer != null)
        + Number(this._recStopTimer != null) + urlState.objectUrlTimers,
      recordingListeners: this._recordingListenerCount,
      limits: {
        durationMs: RECORDING_LIMITS.maxDurationMs,
        savedRecordings: RECORDING_LIMITS.maxSavedRecordings,
        retainedAudioBytes: RECORDING_LIMITS.maxRetainedAudioBytes,
        activeAudioBytes: RECORDING_LIMITS.maxActiveAudioBytes,
        metricSamples: Math.ceil(RECORDING_LIMITS.maxDurationMs / 1000 * RECORDING_LIMITS.metricSamplesPerSecond) + 1,
      },
    };
  }

  formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  updateRecordingsUI() {
    const list = document.getElementById('recordingsList');
    const empty = document.getElementById('recsEmpty');
    const badge = document.getElementById('recBadge');
    const recBtn = document.getElementById('recordingsBtn');
    const clearAllBtn = document.getElementById('clearAllRecs');

    badge.textContent = this.recordings.length;
    recBtn.classList.toggle('visible', this.recordings.length > 0);
    if (clearAllBtn) {
      clearAllBtn.disabled = this.recordings.length === 0;
    }
    this._updateVoiceRecBtn();

    // Keep the singleton empty-state node attached. Removing it with `textContent = ''`
    // made the final delete try to append `null` on the next render.
    list.querySelectorAll('.rec-item').forEach((item) => item.remove());
    if (this.recordings.length === 0) {
      empty.style.display = '';
      return;
    }

    empty.style.display = 'none';
    for (let i = this.recordings.length - 1; i >= 0; i--) {
      const rec = this.recordings[i];
      const item = document.createElement('div');
      item.className = 'rec-item';

      const info = Object.assign(document.createElement('div'), { className: 'rec-item-info' });
      info.append(
        Object.assign(document.createElement('div'), { className: 'rec-item-name', textContent: rec.label || `Recording ${i + 1}`, title: rec.label || '' }),
        Object.assign(document.createElement('div'), { className: 'rec-item-meta', textContent: `${rec.timestamp} · ${this.formatDuration(rec.duration)}` })
      );

      // Per-clip voice review chips (metrics captured live while recording)
      const metricsRow = Object.assign(document.createElement('div'), { className: 'rec-item-metrics' });
      const m = rec.metrics;
      const chip = (text, extraClass = '') => Object.assign(
        document.createElement('span'),
        { className: `rec-chip${extraClass ? ' ' + extraClass : ''}`, textContent: text }
      );
      if (m) {
        metricsRow.append(
          chip(`avg ${Math.round(m.pitchAvgHz)} Hz`),
          chip(`${Math.round(m.pitchMinHz)}–${Math.round(m.pitchMaxHz)} Hz`),
          chip(m.resonanceAvg != null ? `res ${Math.round(m.resonanceAvg * 100)}%` : 'res —'),
          chip(`pros ${Math.round(m.prosodyAvg * 100)}%`)
        );
        metricsRow.title = `Voiced ${Math.round(m.voicedRatio * 100)}% of ${this.formatDuration(rec.duration)}`;
        const prev = this.recordings[i - 1];
        if (prev && prev.metrics) {
          const delta = Math.round(m.pitchAvgHz - prev.metrics.pitchAvgHz);
          metricsRow.appendChild(chip(`Δ ${delta >= 0 ? '+' : '−'}${Math.abs(delta)} Hz vs prev`, 'delta'));
        }
      } else {
        metricsRow.appendChild(chip('no voice data', 'muted'));
      }
      // Practice takes carry word-by-word analysis: summarize as a chip + tooltip.
      const pw = rec.phraseAnalysis?.words;
      if (pw && pw.length > 0) {
        const okCount = pw.filter((w) => w.metrics).length;
        const wordChip = chip(`words ${okCount}/${pw.length}`);
        wordChip.title = pw.map((w) => `${w.word}: ${w.metrics ? `${Math.round(w.metrics.pitchAvgHz)} Hz` : '—'}`).join('\n');
        metricsRow.appendChild(wordChip);
      }
      info.appendChild(metricsRow);

      // Coached takes also get per-word score chips (tiered like the results cards).
      if (rec.phraseScore?.words?.length) {
        const scoreRow = Object.assign(document.createElement('div'), { className: 'rec-item-metrics' });
        for (const w of rec.phraseScore.words) {
          scoreRow.appendChild(chip(`${w.word} ${w.score}`, VoxBallGame.scoreClass(w.score)));
        }
        scoreRow.title = `Take score ${rec.phraseScore.score}/100 — ${rec.phraseScore.takeaway}`;
        info.appendChild(scoreRow);
      }

      const progress = Object.assign(document.createElement('div'), { className: 'rec-progress' });
      progress.appendChild(Object.assign(document.createElement('div'), { className: 'rec-progress-fill', id: `rec-progress-${i}` }));
      info.appendChild(progress);

      const actions = Object.assign(document.createElement('div'), { className: 'rec-item-actions' });
      actions.append(
        Object.assign(document.createElement('button'), { className: 'rec-btn', id: `rec-play-${i}`, title: 'Play', ariaLabel: 'Play Recording', textContent: '▶' }),
        Object.assign(document.createElement('button'), { className: 'rec-btn', title: 'Download', ariaLabel: 'Download Recording', textContent: '⬇' }),
        Object.assign(document.createElement('button'), { className: 'rec-btn delete', title: 'Delete', ariaLabel: 'Delete Recording', textContent: '✕' })
      );

      // Set data attributes
      actions.children[0].dataset.action = 'play'; actions.children[0].dataset.index = i;
      actions.children[1].dataset.action = 'download'; actions.children[1].dataset.index = i;
      actions.children[2].dataset.action = 'delete'; actions.children[2].dataset.index = i;

      item.append(info, actions);
      list.appendChild(item);
    }

    list.onclick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.index, 10);
      if (action === 'play') {
        if (this.currentPlayback && this.currentPlayback.recordingId === this.recordings[idx]?.id) {
          this.stopPlayback();
        } else {
          this.playRecording(idx);
        }
      } else if (action === 'download') {
        this.downloadRecording(idx);
      } else if (action === 'delete') {
        this.deleteRecording(idx);
      }
    };
  }


  // Wire the Smart Bulb section of the settings panel to the BulbController.
  // All transport/config state lives in the controller (persisted to localStorage);
  // this just binds the DOM controls and shows/hides transport-specific fields.
  _setupBulbUI() {
    const ctrl = this.bulbController;
    if (!ctrl) return;
    const enable = document.getElementById('bulbEnableToggle');
    const transportSel = document.getElementById('bulbTransportSelect');
    const testBtn = document.getElementById('bulbTestBtn');
    const connectBtn = document.getElementById('bulbConnectBtn');
    const autoReconnect = document.getElementById('bulbAutoReconnect');
    const fields = {
      hueBridge: document.getElementById('bulbHueBridge'),
      hueUser: document.getElementById('bulbHueUser'),
      hueLightId: document.getElementById('bulbHueLightId'),
      webhookUrl: document.getElementById('bulbWebhookUrl'),
      httpUrl: document.getElementById('bulbHttpUrl'),
      bleNamePrefix: document.getElementById('bulbBleNamePrefix'),
      bleServiceUuid: document.getElementById('bulbBleServiceUuid'),
      bleWriteUuid: document.getElementById('bulbBleWriteUuid'),
    };
    const groups = {
      hue: document.getElementById('bulbHueFields'),
      homeassistant: document.getElementById('bulbHaFields'),
      http: document.getElementById('bulbHttpFields'),
      genericble: document.getElementById('bulbGenericbleFields'),
    };
    // The Connect button (Bluetooth pairing) is shared by all BLE transports.
    const btFields = document.getElementById('bulbBtFields');
    const btTransports = new Set(['webbluetooth', 'genericble', 'esp32']);

    const syncVisibility = () => {
      const t = ctrl.config.transport;
      for (const [key, el] of Object.entries(groups)) {
        if (el) el.style.display = key === t ? '' : 'none';
      }
      if (btFields) btFields.style.display = btTransports.has(t) ? '' : 'none';
    };

    // Reflect controller config into the DOM controls. Runs initially and again
    // whenever the controller changes config itself (e.g. failure auto-disable).
    const hydrate = () => {
      if (enable) enable.checked = ctrl.config.enabled;
      if (transportSel) transportSel.value = ctrl.config.transport;
      if (autoReconnect) autoReconnect.checked = ctrl.config.autoReconnect;
      for (const [key, el] of Object.entries(fields)) {
        if (el) el.value = ctrl.config[key] ?? '';
      }
      syncVisibility();
    };
    hydrate();
    ctrl.onChange = hydrate;

    // Clinic convenience: silently re-link the saved BLE device on load so staff
    // don't re-pick it each session. No-op for non-BLE transports or when off.
    ctrl.restore?.();

    enable?.addEventListener('change', () => ctrl.setEnabled(enable.checked));
    autoReconnect?.addEventListener('change', () => ctrl.set('autoReconnect', autoReconnect.checked));
    transportSel?.addEventListener('change', () => {
      ctrl.set('transport', transportSel.value);
      syncVisibility();
    });
    for (const [key, el] of Object.entries(fields)) {
      el?.addEventListener('change', () => ctrl.set(key, el.value.trim()));
    }
    testBtn?.addEventListener('click', () => ctrl.test());
    // Bluetooth needs an explicit connect from a user gesture (this click).
    connectBtn?.addEventListener('click', () => ctrl.connect());
  }

  // Wire the Necklace section of the settings panel to the NecklaceController.
  // Unlike the Smart Bulb section, the necklace decides on its own when to buzz —
  // this UI only pushes a one-time calibration packet and shows the live status
  // notifications the necklace sends back (~1 Hz) while connected.
  _setupNecklaceUI() {
    const ctrl = this.necklaceController;
    if (!ctrl) return;
    const connectBtn = document.getElementById('necklaceConnectBtn');
    const pushBtn = document.getElementById('necklacePushBtn');
    const hapticSrcSel = document.getElementById('necklaceHapticSrcSelect');
    const loInput = document.getElementById('necklaceTargetLoHz');
    const hiInput = document.getElementById('necklaceTargetHiHz');
    const thrInput = document.getElementById('necklaceHapticThr');
    const pitchFields = document.getElementById('necklacePitchFields');
    const thrFields = document.getElementById('necklaceThrFields');
    const statusEl = document.getElementById('necklaceStatus');
    const liveEl = document.getElementById('necklaceLive');

    if (loInput && !loInput.value) loInput.value = 145;
    if (hiInput && !hiInput.value) hiInput.value = 175;
    if (thrInput && !thrInput.value) thrInput.value = 50;

    const setStatus = (text, kind) => {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.dataset.kind = kind || '';
    };

    const syncFieldVisibility = () => {
      const isPitch = hapticSrcSel?.value === String(HapticSrc.PITCH);
      if (pitchFields) pitchFields.style.display = isPitch ? '' : 'none';
      if (thrFields) thrFields.style.display = isPitch ? 'none' : '';
    };
    syncFieldVisibility();
    hapticSrcSel?.addEventListener('change', syncFieldVisibility);

    connectBtn?.addEventListener('click', async () => {
      setStatus('Opening device picker…', '');
      try {
        await ctrl.connect();
        setStatus('Necklace connected.', 'ok');
      } catch (err) {
        setStatus(`Connect failed: ${err && err.message ? err.message : err}`, 'err');
      }
    });

    pushBtn?.addEventListener('click', async () => {
      try {
        await ctrl.sendCalibration({
          hapticSrc: Number(hapticSrcSel?.value ?? HapticSrc.PITCH),
          hapticThrPct: Number(thrInput?.value ?? 50),
          targetLoHz: Number(loInput?.value ?? 145),
          targetHiHz: Number(hiInput?.value ?? 175),
        });
        setStatus('Calibration pushed.', 'ok');
      } catch (err) {
        setStatus(`Push failed: ${err && err.message ? err.message : err}`, 'err');
      }
    });

    if (liveEl) liveEl.textContent = '';
  }

  // Live readout from the necklace's ~1 Hz status notification (see
  // NecklaceController._onStatusPacket). Purely informational — the necklace has
  // already decided on its own whether to buzz by the time this arrives.
  _onNecklaceStatus(status) {
    const liveEl = document.getElementById('necklaceLive');
    if (!liveEl) return;
    const mins = Math.floor(status.voicedSeconds / 60);
    const secs = status.voicedSeconds % 60;
    const time = `${mins}:${String(secs).padStart(2, '0')}`;
    const battery = status.batteryPct == null ? '' : ` · battery ${status.batteryPct}%`;
    liveEl.textContent = status.calibrating
      ? 'Calibrating…'
      : `On target ${status.onTargetPct}% · ${time} voiced${battery}`;
  }

  setupUI() {
    const startBtn = document.getElementById('startBtn');
    const playBtn = document.getElementById('playBtn');
    const helpBtn = document.getElementById('helpBtn');
    const recalibrateBtn = document.getElementById('recalibrateBtn');
    const homeBtn = document.getElementById('homeBtn');
    const welcomeOverlay = document.getElementById('welcomeOverlay');
    const helpTooltip = document.getElementById('helpTooltip');
    const helpTabs = Array.from(helpTooltip?.querySelectorAll('.help-tab') || []);
    const helpPanels = Array.from(helpTooltip?.querySelectorAll('.help-panel') || []);

    const teleprompterModeSelect = document.getElementById('teleprompterModeSelect');
    const voiceProfileSelect = document.getElementById('voiceProfileSelect');
    const micDeviceSelect = document.getElementById('micDeviceSelect');
    const colorModeSelect = document.getElementById('colorModeSelect');
    const goalModeSelect = document.getElementById('goalModeSelect');
    const genderCueInputs = {
      modalF0: document.getElementById('genderCueModalF0'),
      dispersion: document.getElementById('genderCueDispersion'),
      sibilant: document.getElementById('genderCueSibilant'),
      cpp: document.getElementById('genderCueCpp'),
      intonation: document.getElementById('genderCueIntonation'),
    };
    const echoCancelToggle = document.getElementById('echoCancelToggle');
    const noiseSuppressToggle = document.getElementById('noiseSuppressToggle');
    const autoGainToggle = document.getElementById('autoGainToggle');
    const speechGateToggle = document.getElementById('speechGateToggle');
    const pitchProfileLearned = document.getElementById('pitchProfileLearned');
    const tiltProfileLearned = document.getElementById('tiltProfileLearned');
    const resonanceProfileLearned = document.getElementById('resonanceProfileLearned');
    const frameConfidenceLabel = document.getElementById('frameConfidenceLabel');
    const motionToggle = document.getElementById('motionToggle');
    const cameraBtn = document.getElementById('cameraBtn');
    const cameraModal = document.getElementById('cameraModal');
    const cameraClose = document.getElementById('cameraClose');
    const cameraVideo = document.getElementById('cameraVideo');
    const cameraZoom = document.getElementById('cameraZoom');
    const cameraHeader = document.getElementById('cameraHeader');

    const teleprompterCustomBtn = document.getElementById('teleprompterCustomBtn');
    const recordingsBtn = document.getElementById('recordingsBtn');
    const recordingsDrawer = document.getElementById('recordingsDrawer');
    const clearAllRecs = document.getElementById('clearAllRecs');
    const perfBtn = document.getElementById('perfBtn');
    const teleprompterOverlay = document.getElementById('teleprompterOverlay');
    const diagPanel = document.getElementById('diagPanel');

    const errorBanner = document.getElementById('errorBanner');
    const statusLiveRegion = document.getElementById('statusLiveRegion');
    const iframeNotice = document.getElementById('iframeNotice');
    const isInIframe = window.self !== window.top;

    // Detect iframe on load and show helpful notice
    if (isInIframe && iframeNotice) {
      // Build direct URL — HF Spaces has multiple URL patterns
      let directUrl = window.location.href;
      try {
        // Try to build the *.hf.space direct URL from the current location
        const url = new URL(window.location.href);
        // If we're already on a .hf.space domain, just use it directly
        if (!url.hostname.endsWith('.hf.space')) {
          directUrl = window.location.href;
        }
      } catch (e) { }
      iframeNotice.textContent = '';
      iframeNotice.appendChild(document.createTextNode('This app needs microphone access, which may be blocked when embedded.'));
      iframeNotice.appendChild(document.createElement('br'));
      const link = document.createElement('a');
      link.href = directUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open in new tab for full access ↗';
      iframeNotice.appendChild(link);
      iframeNotice.classList.add('show');
    }

    // Banner messages. Real errors stay up until something clears them, but
    // status notes ({ autoHideMs }) dismiss themselves — a "✅ Calibration
    // complete" note that sits on screen forever reads like a stuck dialog.
    // Every banner also gets a close button, so anything can be tapped away.
    let errorHideTimer = null;
    const showError = (msg, { autoHideMs = 0, tone = 'error' } = {}) => {
      if (msg instanceof Node) {
        errorBanner.textContent = '';
        errorBanner.appendChild(msg);
        if (statusLiveRegion) statusLiveRegion.textContent = msg.textContent.trim();
      } else {
        errorBanner.textContent = msg;
        if (statusLiveRegion) statusLiveRegion.textContent = String(msg).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      const dismissBtn = Object.assign(document.createElement('button'), {
        className: 'error-banner-close',
        type: 'button',
        textContent: '×',
      });
      dismissBtn.setAttribute('aria-label', 'Dismiss message');
      dismissBtn.addEventListener('click', () => clearError());
      errorBanner.appendChild(dismissBtn);
      errorBanner.classList.toggle('info', tone === 'info');
      errorBanner.classList.add('show');
      clearTimeout(errorHideTimer);
      errorHideTimer = autoHideMs > 0 ? setTimeout(() => clearError(), autoHideMs) : null;
    };
    const clearError = () => {
      clearTimeout(errorHideTimer);
      errorHideTimer = null;
      errorBanner.classList.remove('show');
      errorBanner.classList.remove('info');
      if (statusLiveRegion) statusLiveRegion.textContent = '';
    };
    // Recording limit/failure paths route through the shared accessible banner; the
    // lifecycle code owns resources, not a parallel notification element.
    this._showRecordingStatus = showError;

    const updateAdaptiveProfileStatus = () => {
      if (pitchProfileLearned) {
        pitchProfileLearned.textContent = this._formatAdaptiveStatus(this.analyzer.pitchProfile,
          (p) => `${Math.round(p.min)}–${Math.round(p.max)} Hz learned`);
      }
      if (tiltProfileLearned) {
        tiltProfileLearned.textContent = this._formatAdaptiveStatus(this.analyzer.tiltProfile,
          (t) => `${t.min.toFixed(1)} to ${t.max.toFixed(1)} dB learned`);
      }
      if (resonanceProfileLearned) {
        resonanceProfileLearned.textContent = this._resonanceSpanStatus();
      }
      if (frameConfidenceLabel) {
        frameConfidenceLabel.textContent = `${Math.round(this.analyzer.frameConfidence * 100)}%`;
      }
    };

    const syncMicSettingsUi = () => {
      if (echoCancelToggle) echoCancelToggle.checked = this.micInputPreferences.echoCancellation;
      if (noiseSuppressToggle) noiseSuppressToggle.checked = this.micInputPreferences.noiseSuppression;
      if (autoGainToggle) autoGainToggle.checked = this.micInputPreferences.autoGainControl;
      if (speechGateToggle) speechGateToggle.checked = this.speechGateEnabled;
      if (micDeviceSelect) micDeviceSelect.value = this.micInputPreferences.deviceId || 'default';
      const phoneMicPanel = document.getElementById('phoneMicPanel');
      if (phoneMicPanel) phoneMicPanel.style.display = this.micInputPreferences.deviceId === 'phone-mic' ? '' : 'none';
      if (colorModeSelect) colorModeSelect.value = this.colorMode || 'pitch';
      if (goalModeSelect) goalModeSelect.value = this.goalMode || 'feminization';
      for (const [cue, input] of Object.entries(genderCueInputs)) {
        if (input) input.checked = !!this.genderCues[cue];
      }
    };

    const populateMicDevices = async () => {
      if (!micDeviceSelect || !navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter((d) => d.kind === 'audioinput');
        micDeviceSelect.textContent = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = 'Microphone: System Default';
        micDeviceSelect.appendChild(defaultOption);
        const phoneOption = document.createElement('option');
        phoneOption.value = 'phone-mic';
        phoneOption.textContent = 'Phone Microphone (link via browser)';
        micDeviceSelect.appendChild(phoneOption);
        mics.forEach((mic, idx) => {
          const option = document.createElement('option');
          option.value = mic.deviceId;
          option.textContent = `Mic: ${mic.label || `Microphone ${idx + 1}`}`;
          micDeviceSelect.appendChild(option);
        });
        const hasStoredDevice = this.micInputPreferences.deviceId === 'default'
          || this.micInputPreferences.deviceId === 'phone-mic'
          || mics.some((mic) => mic.deviceId === this.micInputPreferences.deviceId);
        if (!hasStoredDevice) {
          this.micInputPreferences.deviceId = 'default';
          localStorage.setItem('vox:micDeviceId', 'default');
        }
        syncMicSettingsUi();
      } catch (err) {
        console.warn('Could not enumerate microphones:', err);
      }
    };

    // None of these block the session, so they read as status notes and time
    // out on their own. The ones carrying a "next action" hang around longer.
    const showCalibrationOutcome = (calResult) => {
      if (!calResult) return;
      if (calResult.outcome === 'completed') {
        showError('✅ Calibration complete. Tip: you can run Recalibrate from the top bar anytime.', { autoHideMs: 5000, tone: 'info' });
      } else if (calResult.outcome === 'incomplete') {
        showError('⚠ Calibration timed out. You can continue, but tracking may be less accurate. Next action: tap Recalibrate when your room is quieter.', { autoHideMs: 9000 });
      } else if (calResult.outcome === 'cancelled') {
        showError('ℹ Calibration cancelled. Next action: tap Recalibrate in the top bar when you are ready.', { autoHideMs: 8000, tone: 'info' });
      } else if (calResult.outcome === 'partial') {
        showError('ℹ Calibration partially completed. Next action: tap Recalibrate to finish vowel tuning for better accuracy.', { autoHideMs: 9000, tone: 'info' });
      } else if (calResult.outcome === 'skipped') {
        showError('ℹ Calibration skipped. Next action: tap Recalibrate in the top bar for more stable tracking.', { autoHideMs: 8000, tone: 'info' });
      }
    };


    // Camera Mirror Logic
    let cameraStream = null;

    const stopCamera = () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
      }
      if (cameraVideo) {
        cameraVideo.srcObject = null;
      }
      cameraModal?.classList.remove('show');
      cameraBtn?.setAttribute('aria-expanded', 'false');
      cameraBtn?.classList.remove('active');
      if (cameraBtn) cameraBtn.setAttribute('aria-expanded', 'false');
      cameraBtn?.setAttribute('aria-expanded', 'false');
    };

    const toggleCamera = async () => {
      if (cameraModal?.classList.contains('show')) {
        stopCamera();
        return;
      }

      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        if (cameraVideo) {
          cameraVideo.srcObject = cameraStream;
        }
        cameraModal?.classList.add('show');
        cameraBtn?.setAttribute('aria-expanded', 'true');
        cameraBtn?.classList.add('active');
        if (cameraBtn) cameraBtn.setAttribute('aria-expanded', 'true');
        cameraBtn?.setAttribute('aria-expanded', 'true');
      } catch (e) {
        showError('📷 Camera access denied or not available.');
        console.error('Camera error:', e);
      }
    };

    cameraBtn?.addEventListener('click', toggleCamera);
    cameraClose?.addEventListener('click', stopCamera);

    // Zoom Logic
    cameraZoom?.addEventListener('input', (e) => {
      if (cameraVideo) {
        cameraVideo.style.transform = `scale(${e.target.value})`;
      }
    });

    // Draggable Window Logic
    let isDraggingCamera = false;
    let cameraDragStartX = 0;
    let cameraDragStartY = 0;
    let cameraModalStartX = 0;
    let cameraModalStartY = 0;

    cameraHeader?.addEventListener('pointerdown', (e) => {
      isDraggingCamera = true;
      cameraDragStartX = e.clientX;
      cameraDragStartY = e.clientY;

      const rect = cameraModal.getBoundingClientRect();
      cameraModalStartX = rect.left;
      cameraModalStartY = rect.top;

      cameraHeader.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    cameraHeader?.addEventListener('pointermove', (e) => {
      if (!isDraggingCamera || !cameraModal) return;

      const dx = e.clientX - cameraDragStartX;
      const dy = e.clientY - cameraDragStartY;

      // Keep it within window bounds approximately
      const newLeft = Math.max(0, Math.min(window.innerWidth - cameraModal.offsetWidth, cameraModalStartX + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, cameraModalStartY + dy));

      cameraModal.style.left = `${newLeft}px`;
      cameraModal.style.top = `${newTop}px`;
      cameraModal.style.right = 'auto'; // overriding initial right positioning
    });

    cameraHeader?.addEventListener('pointerup', (e) => {
      isDraggingCamera = false;
      cameraHeader.releasePointerCapture(e.pointerId);
    });

    // Audio file upload handling
    const audioUploadInput = document.getElementById('audioUploadInput');
    let selectedAudioFile = null;

    audioUploadInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        selectedAudioFile = e.target.files[0];

        // if a game is running, stop it and start again with file
        if (this.isRunning) {
          stopGame().then(() => startGame());
        } else {
          startGame();
        }
      }
    });

    // Show/hide HUD secondary controls (hidden on main menu, visible during play)
    const setHudSettingsVisible = (visible) => {
      document.querySelectorAll('.hud-setting').forEach(el => {
        if (visible) {
          el.removeAttribute('hidden');
          el.style.display = '';
        } else {
          el.setAttribute('hidden', '');
          el.style.display = 'none';
        }
      });
    };

    const startPhoneMicSession = (onStatus) => new Promise((resolve, reject) => {
      function initPeer() {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        const code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
        const peerId = 'vox-' + code.toLowerCase();
        let settled = false;
        let timeoutId;
        let peer;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          try { peer?.destroy(); } catch (_) {}
          reject(err);
        };
        peer = new window.Peer(peerId);
        timeoutId = setTimeout(() => fail(new Error('Phone mic pairing timed out. Try pressing Start again.')), 120_000);
        peer.on('open', () => onStatus('waiting', code));
        peer.on('call', (call) => {
          if (settled) { call.close?.(); return; }
          call.answer();
          call.on('stream', (stream) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              onStatus('connected', code);
              resolve({ stream, cleanup: () => peer.destroy() });
            }
          });
          call.on('error', fail);
        });
        peer.on('error', fail);
      }
      if (window.Peer) {
        initPeer();
      } else {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
        s.integrity = 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR';
        s.crossOrigin = 'anonymous';
        s.onload = initPeer;
        s.onerror = () => reject(new Error('Could not load PeerJS. Check your internet connection.'));
        document.head.appendChild(s);
      }
    });

    const cleanupPhoneMic = () => {
      if (this._phoneMicCleanup) {
        try { this._phoneMicCleanup(); } catch (err) { console.warn('Phone mic cleanup failed:', err); }
        this._phoneMicCleanup = null;
      }
      const phoneMicUrlEl = document.getElementById('phoneMicUrl');
      const phoneMicCodeEl = document.getElementById('phoneMicCode');
      const phoneMicStatusEl = document.getElementById('phoneMicStatus');
      if (phoneMicUrlEl) phoneMicUrlEl.style.display = 'none';
      if (phoneMicCodeEl) phoneMicCodeEl.style.display = 'none';
      if (phoneMicStatusEl) phoneMicStatusEl.style.display = 'none';
    };

    const startGame = async () => {
      if (this._isStarting) return; // prevent concurrent start/stop race
      this._isStarting = true;
      try {
      // A new session owns a fresh analyzer graph. Finish any prior take and release
      // playback before creating that graph so late callbacks cannot cross sessions.
      if (this.isRecording) await this.stopRecording();
      else if (this._recordingFinalizePromise) await this._recordingFinalizePromise;
      this.stopPlayback();
      this.teleprompterSentenceIndex = 0; // start each session at the first sentence
      clearError();
      const initialDiag = await getMicDiagnostics(this.analyzer.audioCtx);
      if (diagPanel) {
        diagPanel.textContent = '';
        diagPanel.textContent = '';
        diagPanel.append(
          'Mic permission: ', Object.assign(document.createElement('b'), { textContent: initialDiag.permission }),
          ' · Audio: ', Object.assign(document.createElement('b'), { textContent: initialDiag.audioState }),
          ' · Secure: ', Object.assign(document.createElement('b'), { textContent: initialDiag.secureContext ? 'yes' : 'no' }),
          initialDiag.inIframe ? ' · Embedded iframe: yes' : ''
        );
      }
      if (this.idleAnimId) {
        cancelAnimationFrame(this.idleAnimId);
        this.idleAnimId = null;
      }

      // Check if we have an audio file OR microphone
      if (!selectedAudioFile && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
        const errNode = document.createElement('div');
        errNode.append(
          '🎙 Microphone API not available and no audio file selected.',
          document.createElement('br'),
          'This requires HTTPS and a modern browser. '
        );
        errNode.textContent = '';
        errNode.appendChild(document.createTextNode('🎙 Microphone API not available and no audio file selected.'));
        errNode.appendChild(document.createElement('br'));
        errNode.appendChild(document.createTextNode('This requires HTTPS and a modern browser. '));
        if (isInIframe) {
          const link = document.createElement('a');
          link.href = window.location.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Try opening in a new tab ↗';
          errNode.appendChild(link);
        } else {
          errNode.appendChild(document.createTextNode('Please use Chrome, Firefox, Safari, or Edge.'));
        }
        showError(errNode);
        this.drawIdleScene();
        return;
      }

      const buildInputOptions = () => ({
        deviceId: this.micInputPreferences.deviceId !== 'default' && this.micInputPreferences.deviceId !== 'phone-mic'
          ? this.micInputPreferences.deviceId : undefined,
        echoCancellation: this.micInputPreferences.echoCancellation,
        noiseSuppression: this.micInputPreferences.noiseSuppression,
        autoGainControl: this.micInputPreferences.autoGainControl,
      });

      let result;
      if (!selectedAudioFile && this.micInputPreferences.deviceId === 'phone-mic') {
        const phoneMicUrlEl = document.getElementById('phoneMicUrl');
        const phoneMicCodeEl = document.getElementById('phoneMicCode');
        const phoneMicStatusEl = document.getElementById('phoneMicStatus');
        try {
          const { stream, cleanup } = await startPhoneMicSession((status, code) => {
            if (status === 'waiting') {
              const url = new URL('phone.html', window.location.href);
              url.searchParams.set('room', code);
              url.searchParams.set('ec', this.micInputPreferences.echoCancellation ? '1' : '0');
              url.searchParams.set('ns', this.micInputPreferences.noiseSuppression ? '1' : '0');
              url.searchParams.set('ag', this.micInputPreferences.autoGainControl ? '1' : '0');
              if (phoneMicUrlEl) { phoneMicUrlEl.href = url.href; phoneMicUrlEl.textContent = url.href; phoneMicUrlEl.style.display = ''; }
              if (phoneMicCodeEl) { phoneMicCodeEl.style.display = ''; phoneMicCodeEl.querySelector('strong').textContent = code; }
              if (phoneMicStatusEl) { phoneMicStatusEl.style.display = ''; phoneMicStatusEl.textContent = 'Waiting for phone to connect...'; }
              showError(`📱 Open on your phone: ${url.href}`);
            } else if (status === 'connected') {
              if (phoneMicStatusEl) phoneMicStatusEl.textContent = '✅ Phone connected!';
              clearError();
            }
          });
          this._phoneMicCleanup = cleanup;
          result = await this.analyzer.start(null, { stream });
          if (!result.ok) { cleanupPhoneMic(); }
        } catch (err) {
          cleanupPhoneMic();
          showError('📱 Phone mic failed: ' + (err.message || 'Connection error'));
          this.drawIdleScene();
          return;
        }
      } else {
        result = await this.analyzer.start(selectedAudioFile, buildInputOptions());
        // Recover automatically if a previously saved device is no longer available.
        if (!selectedAudioFile && !result.ok && result.error === 'NotFoundError' && this.micInputPreferences.deviceId !== 'default') {
          this.micInputPreferences.deviceId = 'default';
          localStorage.setItem('vox:micDeviceId', 'default');
          syncMicSettingsUi();
          result = await this.analyzer.start(selectedAudioFile, buildInputOptions());
        }
      }

      // Clear the selected file after starting so it doesn't persistently start with the file
      // if the user later clicks the normal Start button.
      selectedAudioFile = null;
      if (audioUploadInput) audioUploadInput.value = "";

      if (!result.ok) {
        let msg = '';
        if (result.error === 'NotAllowedError') {
          if (isInIframe) {
            msg = document.createElement('div');
            msg.append(
              '🎙 Microphone blocked by browser — this usually happens inside iframes.',
              document.createElement('br')
            );
            msg.append('🎙 Microphone blocked by browser — this usually happens inside iframes.', document.createElement('br'));
            msg.textContent = '';
            msg.appendChild(document.createTextNode('🎙 Microphone blocked by browser — this usually happens inside iframes.'));
            msg.appendChild(document.createElement('br'));
            const link = document.createElement('a');
            link.href = window.location.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Open in a new tab for full mic access ↗';
            msg.appendChild(link);
          } else {
            msg = document.createElement('div');
            msg.append(
              '🎙 Microphone permission denied.',
              document.createElement('br'),
              'Click the lock/camera icon in your address bar → Allow microphone → then try again.'
            );
            msg.appendChild(document.createTextNode('🎙 Microphone permission denied.'));
            msg.appendChild(document.createElement('br'));
            msg.appendChild(document.createTextNode('Click the lock/camera icon in your address bar → Allow microphone → then try again.'));
          }
        } else if (result.error === 'NotFoundError') {
          msg = '🎙 No microphone detected. Please connect a microphone and try again.';
        } else if (result.error === 'NotReadableError') {
          msg = '🎙 Microphone is in use by another app. Close other apps using the mic and try again.';
        } else {
          msg = document.createElement('div');
          msg.textContent = '🎙 Could not access microphone: ' + (result.message || result.error);
        }
        showError(msg);
        this.drawIdleScene();
        return;
      }

      const resumed = await ensureAudioContextRunning(this.analyzer.audioCtx);
      if (!resumed.ok) {
        showError('🔊 Audio context could not be resumed automatically. Tap Start again after interacting with the page.');
      }

      const audioTracks = this.analyzer.stream?.getAudioTracks?.() || [];
      audioTracks.forEach((track) => {
        track.onended = () => {
          showError('🎙 Microphone stream ended unexpectedly. Press Start to resume.');
        };
      });

      const activeDiag = await getMicDiagnostics(this.analyzer.audioCtx);
      if (diagPanel) {
        diagPanel.textContent = '';
        diagPanel.textContent = '';
        diagPanel.append(
          'Mic permission: ', Object.assign(document.createElement('b'), { textContent: activeDiag.permission }),
          ' · Audio: ', Object.assign(document.createElement('b'), { textContent: activeDiag.audioState }),
          ' · API: ', Object.assign(document.createElement('b'), { textContent: activeDiag.mediaDevices ? 'ok' : 'missing' })
        );
      }
      populateMicDevices();

      if (!this.hasCompletedCalibration) {
        let calResult = { outcome: 'incomplete', skipped: true, reason: 'timeout-guard' };
        try {
          // Global guard so calibration can never stall session start.
          calResult = await runCalibrationWithTimeout(this.calibrationWizard, this.analyzer);
        } catch (err) {
          console.error('Calibration flow failed:', err);
          calResult = { outcome: 'incomplete', skipped: true, reason: 'wizard-exception' };
        }
        this.hasCompletedCalibration = true;
        showCalibrationOutcome(calResult);
      }

      // If the wizard was skipped/timed out, don't leave the analyzer in the
      // pre-calibration state where update() early-returns forever. finalizeNoiseCalibration()
      // owns this: it averages (or discards) whatever partial per-bin noise profile the
      // cancelled room-check accumulated, so the session can't start with a profile that is
      // N frames too loud — which used to pin SNR red and grey the ball for the whole session.
      if (!this.analyzer.isCalibrated) {
        this.analyzer.finalizeNoiseCalibration();
      }

      this.scrollX = 0;
      this.cameraY = 0;
      this.targetCameraY = 0;
      this.cameraZoom = 1.4;
      this.targetZoom = 1.4;
      this.prosodyScore = 0;
      this.guidedStartTs = performance.now();
      this.guidedDismissed = false;
      this.guidedCloseHitbox = null;
      this.guidedPitchStable = 0;
      this.guidedChecklist = {
        roomReady: this.analyzer.isCalibrated,
        voiceDetected: false,
        pitchLocked: false,
      };
      this.particles = [];
      this.trailPoints = [];
      this.sparkles = [];
      this.ball.vy = 0;
      this.ball.onGround = true;
      this.ball.squash = 1;
      this.ball.radius = this.ball.baseRadius;
      this.ball.x = this.width * 0.45;
      this.ball.y = this.getGroundHeight(this.scrollX + this.ball.x) - this.ball.radius;

      // Clear vibration alert tripped highlights
      for (const rule of this.vibration.rules) { rule.tripped = false; }
      this.vibration.flashAlpha = 0;
      if (this._renderVibRules) this._renderVibRules();

      // Clear windowed-average readout buffers so a quick restart doesn't average in
      // the previous session's history.
      this._avgBuffers = { pitch: [], resonance: [], attack: [], weight: [] };
      this._avgCache = {};
      this._avgLastRefresh = 0;
      this._avgLastFrameId = -1;

      // Initialize session stats
      this.session.startTime = Date.now();
      this.session.duration = 0;
      this.session.pitchSum = 0;
      this.session.pitchCount = 0;
      this.session.pitchMin = Infinity;
      this.session.pitchMax = 0;
      this.session.resonanceSum = 0;
      this.session.resonanceCount = 0;
      this.session.absoluteSum = 0;
      this.session.absoluteCount = 0;
      this.session.resonanceSuppressedCount = 0;
      this.session.resonanceSpanId = this.analyzer.resonanceSpanId;
      this.session.prosodyHistory = [];
      this.session.prosodySampleTimer = 0;
      this.session.scrollAtStart = this.scrollX;
      // Phase 2 (§5): "Session statistics use speech mode; the ball keeps exercise mode."
      // The v2 aggregators are session-scoped, so a new session starts them over. They carry
      // ABSOLUTE (§4) and are still not rendered; the summary card shows the plain mean of
      // CONTROL above, which is the scale the ring showed.
      this.analyzer.v2Aggregator.reset();
      this.analyzer.f2PositionAggregator.reset();

      // Show session timer
      const timerEl = document.getElementById('sessionTimer');
      timerEl.textContent = '0:00';
      timerEl.classList.add('active');

      // Hide summary if visible
      document.getElementById('summaryOverlay').classList.remove('show');

      welcomeOverlay.classList.add('hidden');
      document.getElementById('app').classList.add('playing');
      setHudSettingsVisible(true);
      if (iframeNotice) iframeNotice.classList.remove('show');
      helpTooltip.classList.remove('show');
      vibPanel.classList.remove('show');
      recordingsDrawer.classList.remove('show');
      startBtn.textContent = '⏹ Stop Ball';
      startBtn.classList.add('active');
      recBtn.classList.add('visible');
      this.isRunning = true;
      // Push the speech-gate preference onto the freshly built analyzer, and
      // clear any gate state left over from the previous session.
      this.analyzer.speechGateEnabled = this.speechGateEnabled;
      this.analyzer.speechGate.reset();
      this.wakeLock.request();
      if (this.dafEnabled) this.startDAF();
      this.lastTime = performance.now();
      this.loop();
      } finally {
        this._isStarting = false;
      }
    };

    const stopGame = async () => {
      // Clear any pending timeouts from the game session
      for (const id of this._pendingTimeouts) clearTimeout(id);
      this._pendingTimeouts = [];
      // Auto-stop recording if active — must await so recorder can
      // flush its final chunk before we kill the mic stream
      if (this.isRecording) {
        recBtn.classList.remove('recording');
        recBtn.querySelector('.rec-label').textContent = 'Rec';
        await this.stopRecording();
      }
      this.stopPlayback();
      this.stopDAF();
      document.getElementById('dafPanel')?.classList.remove('show');
      document.getElementById('dafBtn')?.setAttribute('aria-expanded', 'false');
      this.isRunning = false;
      this.wakeLock.release();
      this.analyzer.stop();
      cleanupPhoneMic();
      startBtn.textContent = '🎙 Start';
      startBtn.classList.remove('active');
      recBtn.classList.remove('visible');

      // Hide session timer
      document.getElementById('sessionTimer').classList.remove('active');

      // Clear vibration alert tripped highlights on stop
      for (const rule of this.vibration.rules) { rule.tripped = false; }
      this.vibration.flashAlpha = 0;
      if (this._renderVibRules) this._renderVibRules();
      if (this._gameArea) this._gameArea.classList.remove('vib-shake');

      // Close any open panels so they don't block the menu or summary overlay
      // (panels have higher z-index than the welcome overlay, so they must be
      // explicitly closed here — setHudSettingsVisible only hides .hud-setting
      // buttons, not the panel contents themselves).
      toggleSettings(false);
      document.getElementById('vibPanel')?.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
      document.getElementById('helpTooltip')?.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('recordingsDrawer')?.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');

      // Show session summary if session was meaningful (> 3 seconds)
      if (this.session.duration > 3) {
        this._showSessionSummary();
        this.drawIdleScene(); // animate behind semi-transparent summary
      } else {
        welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
        this.drawIdleScene();
      }
    };

    startBtn?.addEventListener('click', () => {
      if (this.isRunning) stopGame(); else startGame();
    });

    playBtn?.addEventListener('click', startGame);

    perfBtn?.addEventListener('click', () => {
      this.perfMonitor.toggle();
      perfBtn.classList.toggle('active', this.perfMonitor.enabled);
    });

    homeBtn?.addEventListener('click', async () => {
      // If a game is running, stop it and go directly to menu
      if (this.isRunning) {
        if (this.isRecording) await this.stopRecording();
        else if (this._recordingFinalizePromise) await this._recordingFinalizePromise;
        this.stopPlayback();
        this.stopDAF();
        this.isRunning = false;
        this.wakeLock.release();
        this.analyzer.stop();
        cleanupPhoneMic();
        startBtn.textContent = '🎙 Start';
        startBtn.classList.remove('active');
        const recBtn = document.getElementById('recBtn');
        if (recBtn) recBtn.classList.remove('visible');

        document.getElementById('sessionTimer').classList.remove('active');
        for (const rule of this.vibration.rules) { rule.tripped = false; }
        this.vibration.flashAlpha = 0;
        if (this._renderVibRules) this._renderVibRules();
        if (this._gameArea) this._gameArea.classList.remove('vib-shake');
      }

      // Show the menu directly
      welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
      document.getElementById('summaryOverlay').classList.remove('show');

      // Close all panels and reset aria-expanded
      this.stopDAF();
      toggleSettings(false);
      document.getElementById('vibPanel')?.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
      document.getElementById('helpTooltip')?.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('recordingsDrawer')?.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('dafPanel')?.classList.remove('show');
      document.getElementById('dafBtn')?.setAttribute('aria-expanded', 'false');

      this.drawIdleScene();
    });

    // Session summary buttons
    document.getElementById('summaryBackBtn')?.addEventListener('click', () => {
      document.getElementById('summaryOverlay').classList.remove('show');
      welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
      // Close any open panels before showing the menu
      toggleSettings(false);
      document.getElementById('vibPanel')?.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
      document.getElementById('helpTooltip')?.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('recordingsDrawer')?.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('dafPanel')?.classList.remove('show');
      document.getElementById('dafBtn')?.setAttribute('aria-expanded', 'false');
      this.drawIdleScene();
    });
    document.getElementById('summaryAgainBtn')?.addEventListener('click', () => {
      document.getElementById('summaryOverlay').classList.remove('show');
      startGame();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Don't capture when typing in inputs
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (this.isRunning && this.teleprompterMode !== 'off') {
          this._advanceTeleprompterManual();
          return;
        }
        if (document.getElementById('summaryOverlay').classList.contains('show')) {
          // From summary → start again
          document.getElementById('summaryOverlay').classList.remove('show');
          startGame();
        } else {
          startBtn.click();
        }
      }
      if (e.code === 'KeyP') {
        e.preventDefault();
        this.perfMonitor.toggle();
        perfBtn?.classList.toggle('active', this.perfMonitor.enabled);
      }
      if (e.code === 'KeyR' && this.isRunning) {
        e.preventDefault();
        recBtn.click();
      }
      if (e.code === 'Escape') {
        // Close metric popup first if open
        if (this.metricPopupOpen) {
          this._closeMetricPopup();
          return;
        }
        setSimplePanelVisibility(helpTooltip, helpBtn, false);
        setSimplePanelVisibility(vibPanel, vibBtn, false);
        setSimplePanelVisibility(recordingsDrawer, recordingsBtn, false);
        setSimplePanelVisibility(dafPanel, dafBtn, false);
        if (settingsPanel?.classList.contains('show')) toggleSettings(false);
        // If summary is showing, go to menu
        if (document.getElementById('summaryOverlay').classList.contains('show')) {
          document.getElementById('summaryOverlay').classList.remove('show');
          welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
          this.drawIdleScene();
        }
      }
    });

    // Single-mode (Vox Ball) setup — runs once during init.
    document.querySelectorAll('.ball-only').forEach(el => el.classList.add('show'));
    if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
    document.querySelector('.hud-title').textContent = 'VOX BALL';
    this._updateHelpContent();
    if (this.idleAnimId) { cancelAnimationFrame(this.idleAnimId); this.idleAnimId = null; }
    if (!this.isRunning) this.drawIdleScene();

    const applyVoiceProfilePreset = (preset) => {
      this.voiceProfilePreset = preset;
      const profiles = {
        auto: { min: 80, max: 380, sustainMul: 1, tiltShift: 0 },
        deeper: { min: 60, max: 260, sustainMul: 0.95, tiltShift: -2 },
        lighter: { min: 120, max: 520, sustainMul: 1.05, tiltShift: 2 },
        expressive: { min: 70, max: 460, sustainMul: 1.15, tiltShift: 0 }
      };
      const cfg = profiles[preset] || profiles.auto;
      this.analyzer.pitchProfile.min = cfg.min;
      this.analyzer.pitchProfile.max = cfg.max;
      this.analyzer.pitchProfile.isLearned = false;
      this.analyzer.pitchProfile.samples = [];
      this.analyzer.tiltProfile.isLearned = false;
      this.analyzer.tiltProfile.samples = [];
      this.analyzer.resonanceProfile.isLearned = false;   // v1's learner: still computed
      this.analyzer.resonanceProfile.samples = [];
      this.analyzer.resonanceProfile.voicedTime = 0;
      // The DISPLAYED metric's span goes with it, and so does the stored profile — a "reset my
      // voice profile" control that left a calibrated span in localStorage would put the app
      // back on a span the user believes they cleared.
      this.analyzer.clearResonanceProfile();
      try { localStorage.removeItem(RESONANCE_PROFILE_KEY); } catch { /* storage may be unavailable */ }
      const baseSustain = this.analyzer.defaultSustainedThreshold || this.analyzer.sustainedThreshold || 0.02;
      this.analyzer.sustainedThreshold = Math.max(0.01, baseSustain * cfg.sustainMul);
      this.analyzer.spectralTiltSmoothedDb += cfg.tiltShift;
    };

    voiceProfileSelect?.addEventListener('change', (e) => {
      applyVoiceProfilePreset(e.target.value);
    });

    micDeviceSelect?.addEventListener('change', (e) => {
      this.micInputPreferences.deviceId = e.target.value || 'default';
      localStorage.setItem('vox:micDeviceId', this.micInputPreferences.deviceId);
      const phoneMicPanel = document.getElementById('phoneMicPanel');
      if (phoneMicPanel) phoneMicPanel.style.display = this.micInputPreferences.deviceId === 'phone-mic' ? '' : 'none';
    });

    colorModeSelect?.addEventListener('change', (e) => {
      this.colorMode = e.target.value === 'gender' ? 'gender' : 'pitch';
      localStorage.setItem('vox:colorMode', this.colorMode);
      if (!this.isRunning) this.drawIdleScene();
    });

    goalModeSelect?.addEventListener('change', (e) => {
      this.goalMode = e.target.value === 'masculinization' ? 'masculinization' : 'feminization';
      localStorage.setItem('vox:goalMode', this.goalMode);
    });

    for (const [cue, input] of Object.entries(genderCueInputs)) {
      input?.addEventListener('change', (e) => {
        this.genderCues[cue] = !!e.target.checked;
        localStorage.setItem(`vox:genderCue:${cue}`, String(this.genderCues[cue]));
        if (!this.isRunning) this.drawIdleScene();
      });
    }

    echoCancelToggle?.addEventListener('change', (e) => {
      this.micInputPreferences.echoCancellation = !!e.target.checked;
      localStorage.setItem('vox:echoCancellation', String(this.micInputPreferences.echoCancellation));
    });

    noiseSuppressToggle?.addEventListener('change', (e) => {
      this.micInputPreferences.noiseSuppression = !!e.target.checked;
      localStorage.setItem('vox:noiseSuppression', String(this.micInputPreferences.noiseSuppression));
    });

    autoGainToggle?.addEventListener('change', (e) => {
      this.micInputPreferences.autoGainControl = !!e.target.checked;
      localStorage.setItem('vox:autoGainControl', String(this.micInputPreferences.autoGainControl));
    });

    speechGateToggle?.addEventListener('change', (e) => {
      this.speechGateEnabled = !!e.target.checked;
      localStorage.setItem('vox:speechGate', String(this.speechGateEnabled));
      // Applies live — no restart needed. Reset so a stale open/closed state
      // from earlier in the session doesn't carry over.
      if (this.analyzer) {
        this.analyzer.speechGateEnabled = this.speechGateEnabled;
        this.analyzer.speechGate.reset();
      }
    });

    // Tap-to-advance for the teleprompter (mobile tap + desktop click)
    if (teleprompterOverlay) {
      teleprompterOverlay.addEventListener('click', () => {
        if (this.isRunning && this.teleprompterMode !== 'off') {
          this._advanceTeleprompterManual();
        }
      });
    }

    teleprompterModeSelect?.addEventListener('change', (e) => {
      this.teleprompterMode = e.target.value;
      this.teleprompterIndex = 0;
      this.teleprompterSentenceIndex = 0;
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
      teleprompterCustomBtn?.classList.toggle('active', this.teleprompterMode === 'custom');
    });

    teleprompterCustomBtn?.addEventListener('click', () => {
      const existing = this.teleprompterCustomText || '';
      const input = window.prompt('Paste or type your teleprompter text:', existing);
      if (input === null) return;
      this.teleprompterCustomText = input.trim();
      if (!this.teleprompterCustomText) {
        this.teleprompterMode = 'rainbow';
      } else {
        this.teleprompterMode = 'custom';
      }
      if (teleprompterModeSelect) teleprompterModeSelect.value = this.teleprompterMode;
      this.teleprompterIndex = 0;
      this.teleprompterSentenceIndex = 0;
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
      teleprompterCustomBtn.classList.toggle('active', this.teleprompterMode === 'custom');
    });

    // Resonance method is selectable from two places — the compact meters bar (desktop) and the
    // expanded metrics panel's Resonance card (reachable on mobile). Route both through one apply
    // that resets the smoothed formants for a clean comparison and keeps the two <select>s in sync.
    const resMethodSelectIds = ['resMethodSelect', 'resMethodSelectExpanded'];
    const applyResonanceMethod = (value) => {
      this.analyzer.resonanceMethod = value;
      // Reset smoothed values when switching methods for clean comparison
      this.analyzer.smoothF1 = 500;
      this.analyzer.smoothF2 = 1500;
      this.analyzer.smoothF3 = 2700;
      // v1's live state, still reset for the same reason it always was: it is still computed,
      // it is just no longer displayed. The canonical v2 stream is deliberately NOT reset here
      // — `resonanceMethod` does not reach it (§5 Phase 3), so there is nothing for a method
      // change to invalidate.
      this.analyzer.smoothResonance = 0.5;
      this.analyzer.formantConfidence = 0;
      this.analyzer.formantSteadiness = 1;
      this.analyzer._prevResF1 = 0;
      this.analyzer._prevResF2 = 0;
      for (const id of resMethodSelectIds) {
        const el = document.getElementById(id);
        if (el && el.value !== value) el.value = value;
      }
    };
    for (const id of resMethodSelectIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('change', (e) => applyResonanceMethod(e.target.value));
      // The expanded selector sits inside a metric card whose click opens the focus popup —
      // stop the tap on the dropdown from also triggering that.
      el.addEventListener('click', (e) => e.stopPropagation());
    }

    // Readout-display mode selectors (mirror the resonance method selector). These are
    // display/selection only — they never change analyzer.metrics.* — and force an immediate
    // cache recompute so the readout updates on the next frame instead of after the throttle.
    const bindReadoutSelect = (id, apply) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', (e) => { apply(e.target.value); this._avgLastRefresh = 0; this._avgLastFrameId = -1; });
    };
    bindReadoutSelect('pitchDisplaySelect', (v) => { this.pitchDisplayMode = v; });
    bindReadoutSelect('weightModeSelect', (v) => { this.weightMode = v; });
    bindReadoutSelect('attackModeSelect', (v) => { this.attackMode = v; });
    bindReadoutSelect('avgWindowSelect', (v) => { this._avgWindowSecs = parseFloat(v) || 0; });

    // ---- Voice recorder: always-available Record + Play-last controls in the top bar ----
    // Reuses the analyser-based recorder (startRecording/stopRecording) and the recordings
    // drawer (Clips) for the full list; the Play button plays back the most recent clip.
    const voiceRecBtn = document.getElementById('voiceRecBtn');
    if (voiceRecBtn) {
      voiceRecBtn.addEventListener('click', async () => {
        if (this.isRecording) {
          await this.stopRecording();   // pushes the clip + calls updateRecordingsUI → syncs buttons
          this._updateVoiceRecBtn();    // also reset if no clip was saved (silent recording)
        } else if (!this.isRunning) {
          showError('🎙 Press Start to begin a session, then Record.');
        } else {
          this.startRecording();
          this._updateVoiceRecBtn();
        }
      });
    }
    // ---- Guided phrase practice: read short phrases, save labeled takes for review ----
    const practiceBtn = document.getElementById('practiceBtn');
    if (practiceBtn) {
      practiceBtn.addEventListener('click', () => {
        if (this.practice.active) { this.endPractice(false); return; }
        if (!this.isRunning) { showError('🎙 Press Start to begin a session, then Practice.'); return; }
        this.startPractice();
      });
    }
    document.getElementById('practiceRecordBtn')?.addEventListener('click', () => {
      if (!this.isRecording && !this.isRunning) {
        showError('🎙 Session ended — press Start to continue practicing.');
        return;
      }
      this._practiceRecordToggle();
    });
    document.getElementById('practiceSkipBtn')?.addEventListener('click', () => this._practiceSkip());
    document.getElementById('practiceExitBtn')?.addEventListener('click', () => this.endPractice(false));
    document.getElementById('practiceRetryBtn')?.addEventListener('click', () => this._practiceRetry());
    document.getElementById('practiceNextBtn')?.addEventListener('click', () => this._practiceNext());
    document.getElementById('practicePlayBtn')?.addEventListener('click', () => {
      const idx = this.practice.takeIndex;
      if (idx < 0) return;
      if (this.currentPlayback && this.currentPlayback.recordingId === this.recordings[idx]?.id) this.stopPlayback();
      else this.playRecording(idx);
    });
    document.getElementById('practiceSpeakBtn')?.addEventListener('click', () => {
      if (this.currentSpeech) { this.stopSpeech(); return; }
      const rec = this.recordings[this.practice.takeIndex];
      if (!rec) return;
      const phraseDef = PRACTICE_PHRASES[this.practice.index];
      const text = buildPhraseSpeechSummary({ scored: rec.phraseScore, phraseDef, goalMode: this.goalMode });
      this.speakPhraseSummary(text);
    });

    const voicePlayBtn = document.getElementById('voicePlayBtn');
    if (voicePlayBtn) {
      voicePlayBtn.addEventListener('click', () => {
        const lastIdx = this.recordings.length - 1;
        if (lastIdx < 0) return;
        if (this.currentPlayback && this.currentPlayback.recordingId === this.recordings[lastIdx]?.id) {
          this.stopPlayback();
        } else {
          this.playRecording(lastIdx);
        }
      });
    }

    // Colorblind mode toggle
    const cbBtn = document.getElementById('cbToggle');
    if (cbBtn) {
      cbBtn.addEventListener('click', () => {
        this.colorblindMode = !this.colorblindMode;
        document.documentElement.classList.toggle('colorblind', this.colorblindMode);
        cbBtn.classList.toggle('active', this.colorblindMode);
      });
    }


    // ====== EXPANDABLE METRICS PANEL ======
    const metersPanel = document.getElementById('metersPanel');
    const metersExpandToggle = document.getElementById('metersExpandToggle');
    const metersExpanded = document.getElementById('metersExpanded');
    const appEl = document.getElementById('app');
    metersExpandToggle?.addEventListener('click', () => {
      this.metersExpanded = !this.metersExpanded;
      metersPanel.classList.toggle('expanded', this.metersExpanded);
      appEl.classList.toggle('meters-open', this.metersExpanded);
      metersExpandToggle.setAttribute('aria-expanded', this.metersExpanded ? 'true' : 'false');
      metersExpandToggle.setAttribute('aria-label', this.metersExpanded ? 'Collapse metrics' : 'Expand metrics');
      // Reflow the game canvas after panel height changes so the ball/ground stay in view.
      requestAnimationFrame(() => this.resize());
      // Expansion animation shifts layout over ~300ms; run one more resize after it settles.
      setTimeout(() => this.resize(), 320);
      // Size canvases after layout settles
      if (this.metersExpanded) {
        requestAnimationFrame(() => this._sizeExpandedCanvases());
      }
    });

    // ====== BALL CAMERA ZOOM CONTROLS ======
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const ZOOM_STEP = 0.15;
    const ZOOM_MIN = 0.55;
    const ZOOM_MAX = 2.2;
    zoomInBtn?.addEventListener('click', () => {
      this.userZoomMultiplier = Math.min(ZOOM_MAX, this.userZoomMultiplier + ZOOM_STEP);
    });
    zoomOutBtn?.addEventListener('click', () => {
      this.userZoomMultiplier = Math.max(ZOOM_MIN, this.userZoomMultiplier - ZOOM_STEP);
    });

    // Metric card click → open popup
    metersExpanded?.querySelectorAll('.metric-card').forEach(card => {
      card.addEventListener('click', () => {
        const metric = card.dataset.metric;
        this._openMetricPopup(metric);
      });
    });

    // Popup close
    const popupBackdrop = document.getElementById('metricPopupBackdrop');
    const popupClose = document.getElementById('metricPopupClose');
    popupClose?.addEventListener('click', () => this._closeMetricPopup());
    popupBackdrop?.addEventListener('click', (e) => {
      if (e.target === popupBackdrop) this._closeMetricPopup();
    });
    const voiceMapResetBtn = document.getElementById('voiceMapResetBtn');
    voiceMapResetBtn?.addEventListener('click', () => this._resetVoiceMapForNewSpeaker(voiceMapResetBtn));

    const syncMotionToggleLabel = () => {
      if (!motionToggle) return;
      const next = this.userMotionPreference === 'auto' ? 'Auto' : this.userMotionPreference === 'low' ? 'Low' : 'Full';
      motionToggle.textContent = `Motion: ${next}`;
      motionToggle.classList.toggle('active', this.userMotionPreference === 'low');
    };
    syncMotionToggleLabel();
    syncMicSettingsUi();
    updateAdaptiveProfileStatus();
    populateMicDevices();
    motionToggle?.addEventListener('click', () => {
      const order = ['auto', 'low', 'full'];
      const idx = order.indexOf(this.userMotionPreference);
      this.userMotionPreference = order[(idx + 1) % order.length];
      localStorage.setItem('vox:motionPreference', this.userMotionPreference);
      this._applyMotionPreferences();
      syncMotionToggleLabel();
    });

    // ---- Smart Bulb UI ----
    this._setupBulbUI();
    this._setupNecklaceUI();


    // ---- Vibration alert UI ----
    const vibBtn = document.getElementById('vibToggle');
    const vibPanel = document.getElementById('vibPanel');
    const vibMaster = document.getElementById('vibMasterToggle');
    const vibRulesList = document.getElementById('vibRulesList');
    const vibAddBtn = document.getElementById('vibAddRule');
    const vibCloseBtn = document.getElementById('vibCloseBtn');
    const gameArea = document.querySelector('.game-area');
    const dafBtn = document.getElementById('dafBtn');
    const dafPanel = document.getElementById('dafPanel');

    // ---- Settings Panel UI ----
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    const modalBackdrop = document.getElementById('modalBackdrop');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const settingsCloseTopBtn = document.getElementById('settingsCloseTopBtn');
    const calibrationReadiness = document.getElementById('calibrationReadiness');
    const guidedResonanceBtn = document.getElementById('guidedResonanceBtn');

    const setSimplePanelVisibility = (panel, button, visible) => {
      panel?.classList.toggle('show', visible);
      button?.setAttribute('aria-expanded', visible ? 'true' : 'false');
    };

    const updateCalibrationReadiness = () => {
      const ready = this.analyzer.isActive;
      if (calibrationReadiness) {
        calibrationReadiness.textContent = ready
          ? 'Microphone active — calibration is ready.'
          : 'Start a session first so calibration can hear your voice.';
        calibrationReadiness.classList.toggle('ready', ready);
      }
      if (recalibrateBtn) {
        recalibrateBtn.textContent = ready ? 'Recalibrate microphone' : 'Start session to recalibrate';
        recalibrateBtn.setAttribute('aria-label', ready
          ? 'Run microphone calibration again'
          : 'Start a session before running microphone calibration');
      }
      if (guidedResonanceBtn) {
        guidedResonanceBtn.textContent = ready
          ? '🎚 Guided resonance setup'
          : '🎚 Start session to calibrate resonance';
        guidedResonanceBtn.setAttribute('aria-label', ready
          ? 'Run guided resonance setup'
          : 'Start a session before running guided resonance setup');
      }
    };

    // On phones, turn the long settings list into accessible collapsible sections.
    const mobileSettingsQuery = window.matchMedia('(max-width: 600px)');
    const settingsSections = Array.from(settingsPanel?.querySelectorAll('.settings-group') || []).map((group, index) => {
      const label = group.querySelector(':scope > .settings-label');
      if (!label) return null;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'settings-section-toggle';
      toggle.textContent = label.textContent.trim();
      const content = document.createElement('div');
      content.className = 'settings-section-content';
      content.id = `settingsSection${index + 1}`;
      toggle.setAttribute('aria-controls', content.id);
      while (group.firstChild) content.appendChild(group.firstChild);
      group.append(toggle, content);
      const startsOpen = toggle.textContent === 'Calibration';
      toggle.dataset.mobileExpanded = startsOpen ? 'true' : 'false';
      toggle.setAttribute('aria-expanded', startsOpen ? 'true' : 'false');
      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.dataset.mobileExpanded = expanded ? 'true' : 'false';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        content.hidden = !expanded;
      });
      return { toggle, content };
    }).filter(Boolean);

    const syncSettingsSections = () => {
      const mobile = mobileSettingsQuery.matches;
      for (const { toggle, content } of settingsSections) {
        toggle.hidden = !mobile;
        const expanded = toggle.dataset.mobileExpanded === 'true';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        content.hidden = mobile && !expanded;
      }
    };
    syncSettingsSections();
    mobileSettingsQuery.addEventListener('change', syncSettingsSections);
    this._disposables.push(() => mobileSettingsQuery.removeEventListener('change', syncSettingsSections));

    const toggleSettings = (show) => {
      const isVisible = show !== undefined ? show : !settingsPanel.classList.contains('show');
      settingsPanel.classList.toggle('show', isVisible);
      settingsBtn?.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      modalBackdrop.classList.toggle('show', isVisible);

      // Force DOM visibility (bypass any CSS specificity issues)
      if (isVisible) {
        settingsPanel.removeAttribute('hidden');
        settingsPanel.style.display = 'flex';
        settingsPanel.style.opacity = '1';
        settingsPanel.style.pointerEvents = 'auto';
        settingsPanel.scrollTop = 0;
        syncMicSettingsUi();
        updateAdaptiveProfileStatus();
        updateCalibrationReadiness();
        populateMicDevices();
        setSimplePanelVisibility(helpTooltip, helpBtn, false);
        setSimplePanelVisibility(recordingsDrawer, recordingsBtn, false);
        setSimplePanelVisibility(vibPanel, vibBtn, false);
        setSimplePanelVisibility(dafPanel, dafBtn, false);
        this.dialogManager.activate(settingsPanel, {
          initialFocus: settingsCloseTopBtn,
          onEscape: () => toggleSettings(false),
          exempt: [modalBackdrop],
        });
      } else {
        this.dialogManager.deactivate(settingsPanel);
        settingsPanel.style.display = 'none';
        settingsPanel.style.opacity = '0';
        settingsPanel.style.pointerEvents = 'none';
        settingsPanel.setAttribute('hidden', '');
      }
    };

    settingsBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettings();
    });

    closeSettingsBtn?.addEventListener('click', () => toggleSettings(false));
    settingsCloseTopBtn?.addEventListener('click', () => {
      toggleSettings(false);
      settingsBtn?.focus({ preventScroll: true });
    });
    modalBackdrop?.addEventListener('click', () => toggleSettings(false));

    const settingsDataStatus = document.getElementById('settingsDataStatus');
    const setSettingsDataStatus = (message) => {
      if (settingsDataStatus) settingsDataStatus.textContent = message;
    };
    document.getElementById('exportSettingsBtn')?.addEventListener('click', () => {
      const bundle = exportPortableSettings(localStorage);
      const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const link = Object.assign(document.createElement('a'), {
        href: blobUrl,
        download: `prosodyball-settings-${new Date().toISOString().slice(0, 10)}.json`,
      });
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      setSettingsDataStatus(`Exported ${Object.keys(bundle.settings).length} portable preferences.`);
    });
    const importSettingsInput = document.getElementById('importSettingsInput');
    document.getElementById('importSettingsBtn')?.addEventListener('click', () => importSettingsInput?.click());
    importSettingsInput?.addEventListener('change', async () => {
      try {
        const file = importSettingsInput.files?.[0];
        if (!file) return;
        const imported = importPortableSettings(localStorage, JSON.parse(await file.text()));
        setSettingsDataStatus(`Imported ${imported} preferences. Reloading…`);
        window.setTimeout(() => window.location.reload(), 500);
      } catch (error) {
        setSettingsDataStatus(error.message || 'Could not import this settings file.');
      } finally {
        importSettingsInput.value = '';
      }
    });
    document.getElementById('resetSettingsBtn')?.addEventListener('click', () => {
      if (!window.confirm('Reset all ProsodyBall preferences and calibrations on this device?')) return;
      const removed = resetPortableSettings(localStorage);
      setSettingsDataStatus(`Reset ${removed} saved values. Reloading…`);
      window.setTimeout(() => window.location.reload(), 500);
    });

    // One outside-click path keeps every auxiliary panel and aria state in sync.
    document.addEventListener('click', (e) => {
      if (settingsPanel && !settingsPanel.contains(e.target) && !settingsBtn?.contains(e.target)) {
        if (settingsPanel.classList.contains('show')) toggleSettings(false);
      }
      const dismissiblePanels = [
        [vibPanel, vibBtn],
        [dafPanel, dafBtn],
        [helpTooltip, helpBtn],
        [recordingsDrawer, recordingsBtn],
      ];
      for (const [panel, button] of dismissiblePanels) {
        if (panel && !panel.contains(e.target) && !button?.contains(e.target)) {
          setSimplePanelVisibility(panel, button, false);
        }
      }
    });

    if (vibBtn) {
      vibBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        if (vibPanel) {
          const isVisible = vibPanel.classList.toggle('show');
          vibBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
          if (isVisible) {
            vibPanel.scrollTop = 0;
            vibPanel.focus({ preventScroll: true });
          }
        }
        setSimplePanelVisibility(helpTooltip, helpBtn, false);
        setSimplePanelVisibility(recordingsDrawer, recordingsBtn, false);
        setSimplePanelVisibility(dafPanel, dafBtn, false);
        if (settingsPanel?.classList.contains('show')) toggleSettings(false);
      });
    }

    vibCloseBtn?.addEventListener('click', () => {
      setSimplePanelVisibility(vibPanel, vibBtn, false);
      vibBtn?.focus({ preventScroll: true });
    });

    const persistVibrationPreferences = () => {
      try {
        localStorage.setItem(VIBRATION_STORAGE_KEY, serializeVibrationPreferences(this.vibration));
      } catch {
        // Alerts still work for this session when storage is unavailable.
      }
    };

    if (vibMaster) {
      vibMaster.addEventListener('change', () => {
        this.vibration.enabled = vibMaster.checked;
        if (vibBtn) vibBtn.classList.toggle('active', vibMaster.checked);
        persistVibrationPreferences();
      });
    }

    const vibMetrics = VIBRATION_METRIC_SPECS;

    const getMetricInfo = (val) => vibMetrics.find(m => m.value === val) || vibMetrics[0];

    const renderVibRules = () => {
      vibRulesList.textContent = '';
      const hintEl = document.getElementById('vibEmptyHint');
      if (hintEl) hintEl.style.display = this.vibration.rules.length === 0 ? 'block' : 'none';
      for (const rule of this.vibration.rules) {
        const info = getMetricInfo(rule.metric);
        const el = document.createElement('div');
        el.className = 'vib-rule' + (rule.tripped ? ' tripped' : '');
        el.dataset.ruleId = rule.id;

        const frag = document.createDocumentFragment();

        const configDiv = document.createElement('div');
        configDiv.className = 'vib-rule-config';

        const topDiv1 = document.createElement('div');
        topDiv1.className = 'vib-rule-top';

        const metricSelect = document.createElement('select');
        metricSelect.className = 'vib-metric';
        metricSelect.setAttribute('aria-label', 'Metric');
        for (const m of vibMetrics) {
          const opt = document.createElement('option');
          opt.value = m.value;
          opt.textContent = m.label;
          if (m.value === rule.metric) opt.selected = true;
          metricSelect.append(opt);
        }

        const dirSelect = document.createElement('select');
        dirSelect.className = 'vib-dir';
        dirSelect.setAttribute('aria-label', 'Direction');
        const optBelow = document.createElement('option');
        optBelow.value = 'below';
        optBelow.textContent = 'drops below';
        if (rule.direction === 'below') optBelow.selected = true;
        const optAbove = document.createElement('option');
        optAbove.value = 'above';
        optAbove.textContent = 'goes above';
        if (rule.direction === 'above') optAbove.selected = true;
        dirSelect.append(optBelow, optAbove);

        topDiv1.append(metricSelect, dirSelect);

        const topDiv2 = document.createElement('div');
        topDiv2.className = 'vib-rule-top';

        const thresholdInput = document.createElement('input');
        thresholdInput.type = 'number';
        thresholdInput.className = 'vib-threshold';
        thresholdInput.value = rule.threshold;
        thresholdInput.min = info.min;
        thresholdInput.max = info.max;
        thresholdInput.step = info.step;
        thresholdInput.setAttribute('aria-label', 'Threshold');

        const unitSpan = document.createElement('span');
        unitSpan.className = 'vib-rule-unit';
        unitSpan.textContent = info.unit;

        const liveValSpan = document.createElement('span');
        liveValSpan.className = 'vib-live-val';
        liveValSpan.dataset.ruleId = rule.id;
        liveValSpan.style.cssText = 'font-size:0.62rem;color:rgba(255,255,255,0.35);margin-left:4px;min-width:32px;text-align:right';
        liveValSpan.textContent = '—';

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'toggle-switch';
        toggleLabel.style.marginLeft = '4px';

        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.className = 'vib-rule-toggle';
        toggleInput.setAttribute('aria-label', 'Enable alert rule');
        if (rule.enabled) toggleInput.checked = true;

        const toggleSlider = document.createElement('span');
        toggleSlider.className = 'toggle-slider';

        toggleLabel.append(toggleInput, toggleSlider);
        topDiv2.append(thresholdInput, unitSpan, liveValSpan, toggleLabel);

        configDiv.append(topDiv1, topDiv2);

        // §3.5's "re-prompted, never silently reinterpreted", made visible. A resonance rule
        // set against v1 is shown with its threshold intact, marked as not firing, and given
        // one button. Nothing here rescales the number: the user reads the live value on the
        // new scale (the readout beside the threshold is already live) and decides.
        if (rule.suspended === true) {
          const notice = document.createElement('div');
          notice.className = 'vib-rule-notice';
          notice.style.cssText = 'font-size:0.62rem;line-height:1.35;color:#ffb86b;margin-top:4px';
          notice.textContent = 'Resonance is measured differently now — this alert is paused so it '
            + 'can\u2019t buzz at the wrong moment. Watch the live number, then keep or change it.';
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'vib-confirm-btn';
          confirmBtn.textContent = 'Use this threshold';
          confirmBtn.style.cssText = 'margin-top:4px;font-size:0.62rem;padding:3px 8px';
          confirmBtn.addEventListener('click', () => {
            const confirmed = confirmResonanceRule(rule, { threshold: Number(thresholdInput.value) });
            Object.assign(rule, confirmed);
            // The user confirmed this threshold while looking at the CURRENT span, so that is
            // the span it now belongs to.
            rule.spanId = this.analyzer.resonanceSpanId;
            this.resonanceRulesNeedingReprompt =
              (this.resonanceRulesNeedingReprompt || []).filter((r) => r.id !== rule.id);
            persistVibrationPreferences();
            renderVibRules();
          });
          configDiv.append(notice, confirmBtn);
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'vib-rule-del';
        delBtn.title = 'Delete rule';
        delBtn.setAttribute('aria-label', 'Delete rule');
        delBtn.textContent = '✕';

        frag.append(configDiv, delBtn);
        el.append(frag);

        // Wire events
        el.querySelector('.vib-metric').addEventListener('change', (e) => {
          rule.metric = e.target.value;
          const newInfo = getMetricInfo(rule.metric);
          rule.threshold = rule.direction === 'below' ? newInfo.defaultBelow : newInfo.defaultAbove;
          // The user is choosing this metric and this threshold NOW, looking at the current
          // scale, so the rule is current and any inherited suspension is spent.
          stampCurrentMetricVersion(rule, this.analyzer.resonanceSpanId);
          persistVibrationPreferences();
          renderVibRules();
        });
        el.querySelector('.vib-dir').addEventListener('change', (e) => {
          rule.direction = e.target.value;
          persistVibrationPreferences();
        });
        el.querySelector('.vib-threshold').addEventListener('input', (e) => {
          rule.threshold = parseFloat(e.target.value) || 0;
          persistVibrationPreferences();
        });
        el.querySelector('.vib-rule-toggle').addEventListener('change', (e) => {
          rule.enabled = e.target.checked;
          persistVibrationPreferences();
        });
        el.querySelector('.vib-rule-del').addEventListener('click', () => {
          this.vibration.rules = this.vibration.rules.filter(r => r.id !== rule.id);
          persistVibrationPreferences();
          renderVibRules();
        });

        vibRulesList.appendChild(el);
      }
    };

    vibAddBtn.addEventListener('click', () => {
      this.vibration.rules.push(stampCurrentMetricVersion({
        id: this.vibration.nextId++,
        metric: 'pitch',
        direction: 'below',
        threshold: 150,
        enabled: true,
        cooldownTimer: 0,
        tripped: false,
      }, this.analyzer.resonanceSpanId));
      persistVibrationPreferences();
      renderVibRules();
    });

    // Store render function for external updates
    this._renderVibRules = renderVibRules;
    this._gameArea = gameArea;
    this._vibRulesList = vibRulesList;
    vibMaster.checked = this.vibration.enabled;
    vibBtn?.classList.toggle('active', this.vibration.enabled);
    renderVibRules();

    // Lightweight live-value updater (called from game loop, no DOM rebuild)
    this._updateVibLiveUI = () => {
      const m = this.analyzer.metrics;
      const hz = this.analyzer.smoothPitchHz;
      for (const rule of this.vibration.rules) {
        // Update live value readout
        const valEl = vibRulesList.querySelector(`.vib-live-val[data-rule-id="${rule.id}"]`);
        if (valEl) {
          let val;
          switch (rule.metric) {
            case 'pitch': val = Math.round(hz); break;
            case 'resonance': val = this.analyzer.resonanceControl != null
              ? Math.round(this.analyzer.resonanceControl * 100) : null; break;
            case 'energy': val = Math.round(m.energy * 100); break;
            case 'bounce': val = Math.round(m.bounce * 100); break;
            case 'tempo': val = 0; break;
            case 'vowel': val = Math.round(m.vowel * 100); break;
            case 'articulation': val = Math.round(m.articulation * 100); break;
            default: val = 0;
          }
          const isActive = m.energy > 0.05 && val != null;
          valEl.textContent = isActive ? `${val}` : '—';
          valEl.style.color = rule.tripped
            ? 'rgba(255,160,60,0.8)'
            : 'rgba(255,255,255,0.35)';
        }
        // Update tripped highlight on row (lightweight class toggle)
        const rowEl = vibRulesList.querySelector(`[data-rule-id="${rule.id}"]`);
        if (rowEl && rowEl.classList.contains('vib-rule')) {
          rowEl.classList.toggle('tripped', rule.tripped);
        }
      }
    };

    document.getElementById('vibTestBtn').addEventListener('click', () => {
      this._triggerVibration('Test');
    });

    // Preset configurations
    const addPresetRules = (rules) => {
      // Clear existing rules
      this.vibration.rules = [];
      for (const r of rules) {
        this.vibration.rules.push(stampCurrentMetricVersion({
          id: this.vibration.nextId++,
          metric: r.metric,
          direction: r.direction,
          threshold: r.threshold,
          enabled: true,
          cooldownTimer: 0,
          tripped: false,
        }, this.analyzer.resonanceSpanId));
      }
      // Enable master toggle
      this.vibration.enabled = true;
      vibMaster.checked = true;
      vibBtn.classList.add('active');
      persistVibrationPreferences();
      renderVibRules();
    };

    document.getElementById('vibPresetFem').addEventListener('click', () => {
      addPresetRules([
        { metric: 'pitch', direction: 'below', threshold: 155 },
        { metric: 'pitch', direction: 'above', threshold: 280 },
        { metric: 'resonance', direction: 'below', threshold: 40 },
      ]);
    });

    // ── DAF (Delayed Auditory Feedback) panel handlers ──
    dafBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = dafPanel.classList.toggle('show');
      dafBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      if (isVisible) {
        document.getElementById('dafEnableToggle').checked = this.dafEnabled;
        document.getElementById('dafDelaySlider').value = this.dafDelayMs;
        document.getElementById('dafDelayLabel').textContent = `${this.dafDelayMs}ms`;
        document.getElementById('dafBassFilterToggle').checked = this.dafBassFilter;
        setSimplePanelVisibility(vibPanel, vibBtn, false);
        setSimplePanelVisibility(helpTooltip, helpBtn, false);
        setSimplePanelVisibility(recordingsDrawer, recordingsBtn, false);
        if (settingsPanel?.classList.contains('show')) toggleSettings(false);
        this._startDafLatencyWatch();
        this._refreshDafOutputs();
      } else {
        this._stopDafLatencyWatch();
      }
    });

    document.getElementById('dafOutputSelect')?.addEventListener('change', async (e) => {
      this.dafOutputDeviceId = e.target.value || '';
      localStorage.setItem('vox:daf:outputDeviceId', this.dafOutputDeviceId);
      const hint = document.getElementById('dafOutputHint');
      const ok = await this.daf.setOutputDevice(this.dafOutputDeviceId);
      if (hint && !ok) {
        hint.textContent = 'Could not switch to that output. It may have disconnected.';
      } else if (hint && ok) {
        hint.textContent = 'Output switched. Press Test sound to check it.';
      }
    });

    document.getElementById('dafTestToneBtn')?.addEventListener('click', () => {
      const hint = document.getElementById('dafOutputHint');
      if (!hint) return;
      if (!this.isRunning) {
        hint.textContent = 'Start the ball first — the test tone uses the live DAF output.';
        return;
      }
      if (!this.dafEnabled) {
        hint.textContent = 'Turn DAF on first — the test tone plays through its output.';
        return;
      }
      if (this.daf.playTestTone()) {
        hint.textContent = 'Playing a beep through the DAF output. Hear it in your headphones? '
          + 'Then the output is fine and the problem is the mic. Nothing at all? '
          + 'The audio is not reaching them — see above.';
      } else {
        hint.textContent = 'DAF is not running, so there is no output path to test.';
      }
    });

    document.getElementById('dafEnableToggle')?.addEventListener('change', (e) => {
      this.dafEnabled = e.target.checked;
      localStorage.setItem('vox:daf:enabled', String(this.dafEnabled));
      dafBtn?.classList.toggle('active', this.dafEnabled);
      if (this.isRunning) {
        if (this.dafEnabled) this.startDAF();
        else this.stopDAF();
      }
      this._updateDafLatencyReadout();
    });

    document.getElementById('dafDelaySlider')?.addEventListener('input', (e) => {
      this.dafDelayMs = parseInt(e.target.value);
      localStorage.setItem('vox:daf:delayMs', String(this.dafDelayMs));
      document.getElementById('dafDelayLabel').textContent = `${this.dafDelayMs}ms`;
      this.daf.setDelayMs(this.dafDelayMs);
      this._updateDafLatencyReadout();
    });

    document.getElementById('dafBassFilterToggle')?.addEventListener('change', (e) => {
      this.dafBassFilter = e.target.checked;
      localStorage.setItem('vox:daf:bassFilter', String(this.dafBassFilter));
      this.daf.setBassFilter(this.dafBassFilter);
    });

    if (this.dafEnabled) dafBtn?.classList.add('active');
    // ── end DAF handlers ──

    document.getElementById('vibPresetMasc').addEventListener('click', () => {
      addPresetRules([
        { metric: 'pitch', direction: 'above', threshold: 140 },
        { metric: 'pitch', direction: 'below', threshold: 80 },
        { metric: 'resonance', direction: 'above', threshold: 60 },
      ]);
    });

    recalibrateBtn?.addEventListener('click', async () => {
      toggleSettings(false);
      if (!this.analyzer.isActive) {
        showError('ℹ Start a session first, then open Settings and tap Recalibrate.', { autoHideMs: 6000, tone: 'info' });
        return;
      }
      // Clear stale calibration data so fresh samples are collected
      this.analyzer.resetCalibration();
      const calResult = await this.calibrationWizard.run(this.analyzer);
      this.hasCompletedCalibration = true;
      this.guidedStartTs = performance.now();
      this.guidedDismissed = false;
      this.guidedCloseHitbox = null;
      this.guidedPitchStable = 0;
      this.guidedChecklist.roomReady = this.analyzer.isCalibrated;
      this.guidedChecklist.voiceDetected = false;
      this.guidedChecklist.pitchLocked = false;
      showCalibrationOutcome(calResult);
      updateCalibrationReadiness();
    });

    guidedResonanceBtn?.addEventListener('click', async () => {
      // Close the sheet before reporting prerequisites or opening calibration.
      // Otherwise the feedback/overlay is visually hidden behind Settings on phones.
      toggleSettings(false);
      if (!this.analyzer.isActive) {
        showError('ℹ Start a session first, then open Settings and run Guided resonance setup.', { autoHideMs: 6000, tone: 'info' });
        return;
      }
      // Phase 4's flow: a vowel set (which sizes the ANALYSIS, via calibrateLpcCeiling) then
      // three postures on the standard phrase (which size the DISPLAY, via the personal span).
      // The wizard never touches storage itself — it hands back a versioned profile and this
      // callback writes it, so there is one place that knows the storage key and the schema.
      const result = await this.calibrationWizard.runVowelSetCalibration(this.analyzer, {
        onProfile: (profile) => {
          try {
            localStorage.setItem(RESONANCE_PROFILE_KEY, serializeResonanceProfile(profile));
            this.resonanceProfileStatus = 'ok';
          } catch {
            // An unwritable store means the span is live for this session and gone on reload.
            // That is the pre-Phase-4 behaviour, so it degrades to what the app already did.
            this.resonanceProfileStatus = 'unwritable';
          }
        },
      });
      if (result?.outcome === 'completed') {
        updateAdaptiveProfileStatus();
        updateCalibrationReadiness();
        // The span moved, so any resonance threshold set against the OLD span is now pointing
        // at a different vocal target. §3.5's rule applies to a span change exactly as it does
        // to a version change: re-prompt, never silently reinterpret.
        this._suspendResonanceRulesForNewSpan(result.profile);
      }
    });

    this.canvas.addEventListener('click', (e) => {
      if (!this.isRunning || this.guidedDismissed || !this.guidedCloseHitbox) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this.guidedCloseHitbox;
      if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
        this.guidedDismissed = true;
        this.guidedCloseHitbox = null;
      }
    });

    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._updateHelpContent();
      const isVisible = helpTooltip.classList.toggle('show');
      helpBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      setSimplePanelVisibility(recordingsDrawer, recordingsBtn, false);
      setSimplePanelVisibility(vibPanel, vibBtn, false);
      setSimplePanelVisibility(dafPanel, dafBtn, false);
      if (settingsPanel?.classList.contains('show')) toggleSettings(false);
    });

    helpTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const selected = tab.dataset.tab;
        helpTabs.forEach((btn) => btn.classList.toggle('active', btn === tab));
        helpPanels.forEach((panel) => {
          panel.classList.toggle('active', panel.dataset.panel === selected);
        });
      });
    });

    // Recording controls
    if (typeof recBtn !== 'undefined' && recBtn) {
      recBtn.addEventListener('click', () => {
        if (this.isRecording) {
          this.stopRecording();
          recBtn.classList.remove('recording');
          recBtn.querySelector('.rec-label').textContent = 'Rec';
        } else {
          if (this.startRecording()) this._updateVoiceRecBtn();
        }
      });
    }


    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !this.isRunning) return;
      // Resume AudioContext if it was suspended while tab was hidden
      try {
        if (this.analyzer.audioCtx && this.analyzer.audioCtx.state === 'suspended') {
          await this.analyzer.audioCtx.resume();
        }
      } catch (_) { /* non-blocking */ }
      try {
        if (navigator.permissions?.query) {
          const mic = await navigator.permissions.query({ name: 'microphone' });
          if (mic.state === 'denied') {
            showError('🎙 Microphone permission changed to denied. Re-enable browser mic permission, then press Start.');
          }
        }
      } catch (e) {
        // non-blocking permissions probe
      }
    });

    recordingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = recordingsDrawer.classList.toggle('show');
      recordingsBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      setSimplePanelVisibility(helpTooltip, helpBtn, false);
      setSimplePanelVisibility(vibPanel, vibBtn, false);
      setSimplePanelVisibility(dafPanel, dafBtn, false);
      if (settingsPanel?.classList.contains('show')) toggleSettings(false);
    });

    clearAllRecs.addEventListener('click', () => {
      if (this.recordings.length === 0) return;
      if (window.confirm('Are you sure you want to delete all recordings? This cannot be undone.')) {
        this.clearAllRecordings();
      }
    });


  }

  // FIX: Idle scene animation behind the overlay
  drawIdleScene() {
    // Cancel any existing idle loop first so repeated calls (e.g. toggling color
    // mode while idle) don't stack independent rAF loops.
    if (this.idleAnimId) { cancelAnimationFrame(this.idleAnimId); this.idleAnimId = null; }
    const idleScroll = { x: this.scrollX || 0 };
    let idleTime = 0;
    const animate = () => {
      if (this.isRunning) return;
      idleTime += 0.016;
      idleScroll.x += 0.5;
      this.scrollX = idleScroll.x;
      this.ball.x = this.width * 0.45;
      const ground = this.getGroundHeight(this.scrollX + this.ball.x);
      this.ball.y = ground - this.ball.radius;
      this.ball.rotation += 0.01;
      this.ballHue = 275;
      this.ballSat = 70;
      this.ballLit = 55;
      this.cameraY = 0;
      this.targetCameraY = 0;
      this.cameraZoom = 1.4;
      this.targetZoom = 1.4;
      this.drawSceneInternal(0);
      this.idleAnimId = requestAnimationFrame(animate);
    };
    animate();
  }

  // A recalibration moves the span, and every `resonanceControl` threshold is a position inside
  // it — so a rule set against the old span now means a different vocal target. Suspending it is
  // the same remedy as a metric-version change and for the same reason: the app cannot know
  // whether the user wants the same NUMBER or the same VOICE, and guessing is the silent
  // reinterpretation §3.5 forbids. A rule already set against this exact span (a recalibration
  // that landed in the same place) is left alone — spanIdFor is derived from the span's own
  // numbers precisely so that re-prompting for a no-op does not happen.
  _suspendResonanceRulesForNewSpan(profile) {
    const newSpanId = profile && profile.spanId;
    if (!newSpanId) return;
    const affected = [];
    for (const rule of this.vibration.rules) {
      if (rule.metric !== 'resonance') continue;
      if (rule.spanId === newSpanId) continue;
      rule.suspended = true;
      rule.suspendedReason = 'span-changed';
      rule.spanId = newSpanId;
      affected.push(rule);
    }
    if (!affected.length) return;
    this.resonanceRulesNeedingReprompt = affected;
    try {
      localStorage.setItem(VIBRATION_STORAGE_KEY, serializeVibrationPreferences(this.vibration));
    } catch { /* storage may be unavailable */ }
    this._renderVibRules?.();
  }

  // The presentation ramp described in the constructor. Pure presentation: it never produces
  // a resonance value, it only decides how much of the ring is a reading.
  _updateResonanceDisplay(dt) {
    const a = this.analyzer;
    const present = !!(a && a.resonancePresent && a.resonanceControl != null);
    const step = Math.max(0, Math.min(0.25, dt));   // a long stall must not jump the ramp
    if (present) {
      this._resDisplayValue = a.resonanceControl;
      this._resPresence = Math.min(1, this._resPresence + step / RESONANCE_FADE_IN_SEC);
    } else {
      this._resPresence = Math.max(0, this._resPresence - step / RESONANCE_FADE_OUT_SEC);
      // Only once the ring has fully reached neutral is the last value forgotten. Dropping it
      // on the first suppressed frame would make the ramp jump to the origin instead of
      // relaxing from where it was.
      if (this._resPresence === 0) this._resDisplayValue = null;
    }
  }

  loop() {
    if (!this.isRunning) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // While the calibration wizard is active it drives analyzer.update() from its
    // own loops — skip the main-loop update so frame time isn't counted twice
    // (double-driving corrupts calibration timers and every EMA-smoothed metric).
    if (!this.calibrationWizard?.isWizardLoopActive) {
      this.analyzer.update(dt);
    }

    // Skip rendering when the tab is hidden to save CPU/GPU.
    // Audio analysis above still runs so calibration state stays warm.
    if (document.hidden) {
      requestAnimationFrame(() => this.loop());
      return;
    }

    this.perfMonitor.sample(dt);

    const targetQualityScale = this.perfMonitor.fps > 0 && this.perfMonitor.fps < 30 ? 0.55 : this.perfMonitor.fps > 0 && this.perfMonitor.fps < 42 ? 0.75 : 1;
    this.dynamicQualityScale += (targetQualityScale - this.dynamicQualityScale) * 0.08;
    this.particleScale = this.baseParticleScale * this.dynamicQualityScale;

    this._updateResonanceDisplay(dt);
    this.update(dt);
    this.drawSceneInternal(this.prosodyScore);
    // Mirror the live ball color onto a smart bulb (throttled internally).
    // Driven from the central loop so it tracks every mode that updates the color.
    // The bulb is a presentation surface, so it reads CONTROL like the ball. On a frame with
    // no reading it holds the last colour it was given rather than being driven to 0 — a lamp
    // snapping to "darkest" because the room got noisy is the substitute D1 forbids.
    const currentResonance = this._resDisplayValue != null
      ? this._resDisplayValue
      : (this._lastBulbResonance != null ? this._lastBulbResonance : 0.5);
    this._lastBulbResonance = currentResonance;
    const currentWeight = this.analyzer ? this.analyzer.weightSmoothed : 0.5;
    this.bulbController?.update(this.ballHue, this.ballSat, this.ballLit, currentResonance, dt, currentWeight);
    this._pushAvgSamples();
    this.updateMeters();
    this._updateExpandedMetrics();
    this.renderTeleprompter(dt);
    this.checkVibrationAlerts(dt);
    this.perfMonitor.render(`Particles: ${this.particles.length} · Trail: ${this.trailPoints.length}`);

    // ---- Session stats accumulation ----
    const sess = this.session;
    sess.duration = (Date.now() - sess.startTime) / 1000;

    // Update HUD timer
    const mins = Math.floor(sess.duration / 60);
    const secs = Math.floor(sess.duration % 60);
    const timerEl = document.getElementById('sessionTimer');
    if (timerEl) timerEl.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;

    // Sample pitch and resonance when speaking
    const sessM = this.analyzer.metrics;
    const sessHz = this.analyzer.smoothPitchHz;
    if (sessM.energy > 0.05 && this.analyzer.lastPitch > 0) {
      sess.pitchSum += sessHz;
      sess.pitchCount++;
      if (sessHz < sess.pitchMin) sess.pitchMin = sessHz;
      if (sessHz > sess.pitchMax) sess.pitchMax = sessHz;
      // TWO ACCUMULATORS, AND THE SPLIT BETWEEN THEM IS §4 AND §6 PULLING IN DIFFERENT
      // DIRECTIONS — resolved by what each number is FOR.
      //
      // §4 puts "cross-session progress" on the absolute axis, and it is right: control moves
      // whenever the span does, so a user who recalibrates between Tuesday and Friday would
      // otherwise see "progress" that is entirely the new span. So the STATISTIC is absolute,
      // versioned, and tagged with its scale.
      //
      // §6 says the user sees one ring. The end-of-session card is the same surface as the ring,
      // and there is no cross-session history in this app to compare against — nothing persists
      // one. Showing a number on an axis the user has never seen, with no second reading to
      // compare it to, would be the decomposition leaking into the interface for no benefit. So
      // the DISPLAYED average is control: the same scale the ring showed while they were
      // speaking.
      //
      // Frames with no reading are counted as neither. They are not zeroes.
      const sessControl = this.analyzer.currentResonanceReading(RESONANCE_SCALE_CONTROL);
      const sessAbsolute = this.analyzer.currentResonanceReading(RESONANCE_SCALE_ABSOLUTE);
      if (sessControl && sessAbsolute) {
        sess.resonanceSum += sessControl.value;
        sess.resonanceCount++;
        sess.resonanceScale = sessControl.scale;
        sess.resonanceSpanId = sessControl.spanId;
        sess.absoluteSum += sessAbsolute.value;
        sess.absoluteCount++;
        sess.resonanceMetricVersion = sessAbsolute.metricVersion;
      } else {
        sess.resonanceSuppressedCount++;
      }
    }

    // Sample prosody score every 0.5s for sparkline
    sess.prosodySampleTimer += dt;
    if (sess.prosodySampleTimer >= 0.5) {
      sess.prosodySampleTimer = 0;
      sess.prosodyHistory.push(this.prosodyScore);
      // Cap at 240 samples (2 minutes)
      if (sess.prosodyHistory.length > 240) sess.prosodyHistory.shift();
    }

    // Show calibration notice during noise floor measurement
    if (!this.analyzer.isCalibrated && this.analyzer.isActive) {
      const ctx = this.ctx;
      const progress = Math.min(1, this.analyzer.noiseCalibrationTimer / this.analyzer.noiseCalibrationDuration);
      ctx.save();
      ctx.fillStyle = 'rgba(10,10,18,0.6)';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.fillStyle = '#e8e6f0';
      ctx.font = '600 16px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🎙 Calibrating to room noise...', this.width / 2, this.height / 2 - 12);
      ctx.font = '400 13px "Outfit", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('Stay quiet for a moment', this.width / 2, this.height / 2 + 14);
      // Progress bar
      const barW = 160, barH = 4;
      const barX = (this.width - barW) / 2;
      const barY = this.height / 2 + 34;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = this.colorblindMode ? '#56B4E9' : '#4d96ff';
      ctx.fillRect(barX, barY, barW * progress, barH);
      ctx.restore();
    }

    // Guided onboarding overlay for first 30 seconds
    const guidedElapsed = (performance.now() - this.guidedStartTs) / 1000;
    if (this.isRunning && this.guidedStartTs > 0 && !this.guidedDismissed && guidedElapsed < this.guidedDurationSec) {
      const hasVoice = this.analyzer.metrics.energy > 0.05 || this.analyzer.lastPitch > 0;
      this.guidedChecklist.voiceDetected = this.guidedChecklist.voiceDetected || hasVoice;
      if (this.analyzer.pitchConfidence > 0.65 && this.analyzer.lastPitch > 0) {
        this.guidedPitchStable += dt;
      } else {
        this.guidedPitchStable = Math.max(0, this.guidedPitchStable - dt * 0.5);
      }
      if (this.guidedPitchStable > 0.8) this.guidedChecklist.pitchLocked = true;
      this.guidedChecklist.roomReady = this.guidedChecklist.roomReady || this.analyzer.isCalibrated;

      const ctx = this.ctx;
      const x = 16;
      const y = 68;
      const w = Math.min(360, this.width - 32);
      const h = 120;
      const left = Math.max(8, Math.min(x, this.width - w - 8));
      ctx.save();
      ctx.fillStyle = 'rgba(9, 12, 22, 0.72)';
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(left, y, w, h, 10);
      ctx.fill();
      ctx.stroke();

      const closeSize = 18;
      const closeX = left + w - closeSize - 8;
      const closeY = y + 8;
      this.guidedCloseHitbox = { x: closeX, y: closeY, w: closeSize, h: closeSize };

      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.roundRect(closeX, closeY, closeSize, closeSize, 6);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '600 12px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✕', closeX + closeSize * 0.5, closeY + 13);

      const secsLeft = Math.max(0, Math.ceil(this.guidedDurationSec - guidedElapsed));
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e8e6f0';
      ctx.font = '600 14px "Outfit", sans-serif';
      ctx.fillText(`Quick setup guide · ${secsLeft}s`, left + 12, y + 22);
      ctx.font = '500 12px "Outfit", sans-serif';
      const rows = [
        ['Room calibrated', this.guidedChecklist.roomReady],
        ['Voice detected', this.guidedChecklist.voiceDetected],
        ['Pitch lock stable', this.guidedChecklist.pitchLocked],
      ];
      rows.forEach((row, i) => {
        ctx.fillStyle = row[1] ? '#6bcb77' : 'rgba(255,255,255,0.55)';
        ctx.fillText(`${row[1] ? '✅' : '⬜'} ${row[0]}`, left + 14, y + 48 + i * 22);
      });
      if (this.guidedChecklist.roomReady && this.guidedChecklist.voiceDetected && this.guidedChecklist.pitchLocked) {
        ctx.fillStyle = this.colorblindMode ? '#56B4E9' : '#4d96ff';
        ctx.fillText('Great! You are fully tracked.', left + 14, y + 112);
      }
      ctx.restore();
    } else {
      this.guidedCloseHitbox = null;
    }

    // Vibration alert flash overlay
    if (this.vibration.flashAlpha > 0.01) {
      const vib = this.vibration;
      const fa = vib.flashAlpha;
      const ctx = this.ctx;
      ctx.save();

      // Edge flash — orange border glow
      const edgeW = 4 + fa * 4;
      const grad = ctx.createLinearGradient(0, 0, edgeW * 3, 0);
      grad.addColorStop(0, `rgba(255,140,40,${fa * 0.4})`);
      grad.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, edgeW * 3, this.height); // left edge
      const grad2 = ctx.createLinearGradient(this.width, 0, this.width - edgeW * 3, 0);
      grad2.addColorStop(0, `rgba(255,140,40,${fa * 0.4})`);
      grad2.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = grad2;
      ctx.fillRect(this.width - edgeW * 3, 0, edgeW * 3, this.height); // right edge

      // Metric label badge at top center
      if (vib.flashMetric && fa > 0.3) {
        const badgeAlpha = Math.min(1, (fa - 0.3) * 2);
        ctx.font = '600 12px "Outfit", sans-serif';
        ctx.textAlign = 'center';
        const text = `⚠ ${vib.flashMetric}`;
        const tw = ctx.measureText(text).width;
        const bx = this.width / 2 - tw / 2 - 10;
        const by = 32;
        const bw = tw + 20;
        const bh = 22;
        const br = 6;
        ctx.fillStyle = `rgba(50,30,10,${badgeAlpha * 0.7})`;
        ctx.beginPath();
        ctx.moveTo(bx + br, by);
        ctx.lineTo(bx + bw - br, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + br, br);
        ctx.lineTo(bx + bw, by + bh - br);
        ctx.arcTo(bx + bw, by + bh, bx + bw - br, by + bh, br);
        ctx.lineTo(bx + br, by + bh);
        ctx.arcTo(bx, by + bh, bx, by + bh - br, br);
        ctx.lineTo(bx, by + br);
        ctx.arcTo(bx, by, bx + br, by, br);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(255,160,60,${badgeAlpha})`;
        ctx.fillText(text, this.width / 2, by + 15);
      }

      ctx.restore();
    }

    requestAnimationFrame(() => this.loop());
  }

  update(dt) {
    const m = this.analyzer.metrics;
    const gravity = 800;

    // ==========================================================
    // PROSODY SCORE — the core pedagogical signal
    // Monotone speech ≈ 0. Expressive prosody → 1.
    // Weighted toward variation metrics, NOT raw energy/volume.
    // During low-confidence frames, slow the smoothing factor so
    // unreliable data doesn't jerk the score around.
    // ==========================================================
    const scoreSmoothing = 0.12 * Math.max(0.2, this.analyzer.frameConfidence);
    this.prosodyScore = computeProsodyScore(this.prosodyScore, m, scoreSmoothing);

    const ps = this.prosodyScore;

    // ==========================================================
    // SCROLL SPEED — prosody + rolling syllable frequency drives movement
    // Monotone: sluggish crawl (20 px/s). High rate: >300 px/s.
    // ==========================================================
    const nowSec = performance.now() / 1000;
    this.syllableTimes = this.syllableTimes || [];
    const currentImpulse = this.analyzer.syllableImpulse;
    if (currentImpulse > 0.9 && !this._hadSyllableTrigger) {
      this.syllableTimes.push(nowSec);
      this._hadSyllableTrigger = true;
    } else if (currentImpulse <= 0.8) {
      this._hadSyllableTrigger = false;
    }
    this.syllableTimes = this.syllableTimes.filter(t => nowSec - t <= 3.0);
    const syllableFreq = this.syllableTimes.length / 3.0;
    const speedFactor = Math.min(1.0, syllableFreq / 3.0);
    this.syllableSpeedFactor = speedFactor;

    this.targetScrollSpeed = 20 + ps * 150 + speedFactor * 250;
    this.scrollSpeed += (this.targetScrollSpeed - this.scrollSpeed) * 0.06;
    this.scrollX += this.scrollSpeed * dt;

    this.ball.x = this.width * 0.45;
    const localGround = this.getGroundHeight(this.scrollX + this.ball.x);

    // ==========================================================
    // SYLLABLE BOUNCE — gated by prosody
    // Monotone syllables = tiny nudge. Prosodic = BIG bounce.
    // At ps=0.4 → ~120px height. At ps=0.8 → ~400px height.
    // ==========================================================
    const sylImpulse = this.analyzer.syllableImpulse;
    if (sylImpulse > 0.5) {
      const bouncePower = 120 + ps * 1800;
      if (this.ball.vy > -bouncePower * 0.5) {
        this.ball.vy = -bouncePower * sylImpulse;
        this.ball.onGround = false;
        this.ball.squash = 0.7 - ps * 0.15;
        if (ps > 0.15) {
          const pY = Math.min(this.ball.y + this.ball.radius, localGround);
          const n = Math.floor((2 + ps * 6) * this.particleScale);
          for (let i = 0; i < n; i++) {
            const angle = Math.PI + Math.random() * Math.PI;
            const pr = this.colorblindMode ? 240 : 255;
            const pg = this.colorblindMode ? 200 + Math.floor(Math.random() * 55) : 120 + Math.floor(Math.random() * 100);
            const pb = this.colorblindMode ? 60 : 100;
            this.particles.push(new Particle(
              this.ball.x, pY,
              pr, pg, pb,
              Math.cos(angle) * (30 + ps * 60 + Math.random() * 50),
              Math.sin(angle) * (30 + ps * 70 + Math.random() * 60),
              0.4 + ps * 0.4,
              1.5 + ps * 3
            ));
          }
        }
      }
    }

    // ==========================================================
    // CONTINUOUS PITCH LIFT — requires real pitch variation
    // Stronger force so expressive speech sustains altitude
    // ==========================================================
    if (m.bounce > 0.2) {
      this.ball.vy -= m.bounce * ps * 1200 * dt;
    }

    if (!this.ball.onGround) {
      this.ball.vy += gravity * dt;
    }

    this.ball.y += this.ball.vy * dt;

    // Ground collision
    const groundContact = localGround - this.ball.radius;
    if (this.ball.y >= groundContact) {
      this.ball.y = groundContact;
      if (Math.abs(this.ball.vy) > 30 && ps > 0.1) {
        this.ball.squash = 0.7;
        const gParts = Math.max(1, Math.floor(3 * this.particleScale));
        for (let i = 0; i < gParts; i++) {
          this.particles.push(new Particle(
            this.ball.x + (Math.random() - 0.5) * 20, localGround,
            200, 200, 220,
            (Math.random() - 0.5) * 50, -Math.random() * 40,
            0.3, 1.5
          ));
        }
      }
      this.ball.vy *= -0.3;
      if (Math.abs(this.ball.vy) < 15) {
        this.ball.vy = 0;
        this.ball.onGround = true;
      }
    } else {
      this.ball.onGround = false;
    }

    this.ball.rotation += (this.scrollSpeed / (this.ball.radius * 2)) * dt;
    this.ball.squash += (1 - this.ball.squash) * 5 * dt;

    // Camera Y tracking
    const upperLimit = this.height * 0.3;
    const ballScreenY = this.ball.y;
    if (ballScreenY < upperLimit) {
      this.targetCameraY = ballScreenY - upperLimit;
    } else {
      this.targetCameraY = 0;
    }
    const camSpeed = this.targetCameraY < this.cameraY ? 0.18 : 0.06;
    this.cameraY += (this.targetCameraY - this.cameraY) * camSpeed;
    this.cameraY = Math.min(0, this.cameraY);
    const ballScreenY2 = this.ball.y - this.cameraY;
    if (ballScreenY2 < this.ball.radius * 2) {
      this.cameraY = this.ball.y - this.ball.radius * 2;
    }

    // Dynamic zoom — zoom in when grounded, zoom out when high
    // Also zoom out slightly at high speed for dramatic effect
    const heightAboveGround = Math.max(0, localGround - this.ball.radius - this.ball.y);
    const heightRatio = Math.min(1, heightAboveGround / (this.height * 0.5));
    const scrollSpeedFactor = Math.min(1, this.scrollSpeed / 300);
    this.targetZoom = (1.48 - heightRatio * 0.3 - scrollSpeedFactor * 0.08) * this.userZoomMultiplier; // 1.48 → 1.10, scaled by manual zoom
    this.cameraZoom += (this.targetZoom - this.cameraZoom) * 0.04;

    // ==========================================================
    // BALL SIZE — monotone: small (16). Prosodic: 22-40.
    // ==========================================================
    const prosodyRadius = 16 + ps * 10;
    const vowelBonus = m.vowel * 14;
    this.ball.targetRadius = prosodyRadius + vowelBonus;
    this.ball.radius += (this.ball.targetRadius - this.ball.radius) * 0.1;

    // ==========================================================
    // VOWEL TRAIL — only with real prosody
    // ==========================================================
    if (m.vowel > 0.2 && ps > 0.1) {
      this.trailPoints.push({
        wx: this.ball.x + this.scrollX,
        sy: this.ball.y + this.ball.radius,
        size: this.ball.radius * 0.5 * m.vowel * Math.min(1, ps * 3),
        life: 1.0,
        hue: this.ballHue
      });
    }

    for (let i = this.trailPoints.length - 1; i >= 0; i--) {
      this.trailPoints[i].life -= dt * 1.5;
      if (this.trailPoints[i].life <= 0) this.trailPoints.splice(i, 1);
    }
    if (this.trailPoints.length > 60) this.trailPoints.splice(0, this.trailPoints.length - 60);

    // ==========================================================
    // SPARKLES — gated by prosody
    // ==========================================================
    if (m.articulation > 0.3 && ps > 0.1) {
      const sparkleCount = Math.floor(m.articulation * ps * 6 * this.particleScale);
      for (let i = 0; i < sparkleCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = this.ball.radius + Math.random() * 20;
        this.sparkles.push({
          x: this.ball.x + Math.cos(angle) * dist,
          y: this.ball.y + this.ball.radius * 0.5 + Math.sin(angle) * dist,
          life: 0.4 + Math.random() * 0.3,
          maxLife: 0.5,
          size: 1 + ps * 3
        });
      }
    }

    for (let i = this.sparkles.length - 1; i >= 0; i--) {
      this.sparkles[i].life -= dt;
      if (this.sparkles[i].life <= 0) this.sparkles.splice(i, 1);
    }
    if (this.sparkles.length > MAX_SPARKLES) this.sparkles.splice(0, this.sparkles.length - MAX_SPARKLES);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      this.particles[i].update(dt);
      if (this.particles[i].life <= 0) this.particles.splice(i, 1);
    }
    if (this.particles.length > 80) this.particles.splice(0, this.particles.length - 80);

    // ==========================================================
    // BALL COLOR — hue from pitch or perceived gender (see _computeBallHue),
    // prosody drives saturation and brightness
    // ==========================================================
    const pitchHue = this._computeBallHue(dt);
    this.ballHue = pitchHue;
    this.ballSat = 25 + ps * 75;   // 25% (muted) → 100% (vivid)
    this.ballLit = this.colorblindMode
      ? (40 + ps * 30) + (pitchHue < 100 ? 10 : 0) // extra luminance boost at yellow end
      : 40 + ps * 30;

    // --- Reliability vividness ---
    // In noise (low SNR trust) desaturate + gently dim the ball, so it visibly reads as
    // "uncertain" rather than as a confident voice change. We smooth snrConfidence again
    // here (it is already smoothed in the analyzer) so the ball eases, never strobes, and
    // we drive saturation + luminance (not hue) so the cue survives colorblind mode.
    //
    // This is a TOP-UP, not the whole cue: snrConfidence already multiplies into
    // confidenceGate (dsp-utils computeFrameReliability), which gates bounce and
    // articulation — 70% of the prosody score that set ballSat above. A full 0.30..1.0
    // multiply here applied SNR a third time, so a merely-marginal room (~14 dB) collapsed
    // the ball to ~29% saturation and read as "you were monotone" rather than "I can't hear
    // you well". The gentler ramp still desaturates visibly (≈63% → ≈30% across the tiers)
    // without double-charging the same measurement.
    const snrConf = this.analyzer.metrics.snrConfidence;
    this.trustVividness += (snrConf - this.trustVividness) * Math.min(1, dt * 4); // ~250ms
    const trust = this.trustVividness;
    this.ballSat *= 0.70 + 0.30 * trust;
    this.ballLit *= 0.70 + 0.30 * trust;
    this._lowTrustSecs = this.analyzer.metrics.snrTier === 'red'
      ? Math.min(6, this._lowTrustSecs + dt)
      : Math.max(0, this._lowTrustSecs - dt * 2);
  }

  // ==========================================================
  // BALL HUE — single source of truth for ball color.
  //
  // colorMode 'pitch' (default): hue follows F0
  //   ≤100 Hz → 210 (deep blue), 145 → 250, 160 → 275 (androgynous center),
  //   175 → 310, ≥250 → 340 (hot pink)
  //
  // colorMode 'gender': hue follows perceived vocal gender (pitch + resonance)
  //   blue (masculine) → purple ~275 (androgynous/nonbinary) → pink (feminine)
  //
  // Each mode has a colorblind sub-ramp (luminance-mapped blue→yellow).
  // ==========================================================
  _computeBallHue(dt) {
    if (this.colorMode === 'gender') {
      return this._updateGenderHue();
    }
    const hz = this.analyzer.smoothPitchHz;
    let pitchHue;
    if (this.colorblindMode) {
      // Colorblind: blue(220)→cyan(190)→yellow(55) — luminance-mapped
      // Works for protanopia, deuteranopia, tritanopia, and grayscale
      if (hz <= 100) {
        pitchHue = 220;
      } else if (hz <= 160) {
        pitchHue = 220 - ((hz - 100) / 60) * 30;  // 220 → 190
      } else if (hz <= 220) {
        pitchHue = 190 - ((hz - 160) / 60) * 135; // 190 → 55
      } else {
        pitchHue = 55;
      }
    } else {
      if (hz <= 100) {
        pitchHue = 210;
      } else if (hz <= 145) {
        pitchHue = 210 + ((hz - 100) / 45) * 40;  // 210 → 250
      } else if (hz <= 175) {
        pitchHue = 250 + ((hz - 145) / 30) * 60;  // 250 → 310
      } else if (hz <= 250) {
        pitchHue = 310 + ((hz - 175) / 75) * 30;  // 310 → 340
      } else {
        pitchHue = 340;
      }
    }
    return pitchHue;
  }

  // Perceived-gender hue: combine all enabled acoustic cues into a 0..1 score, smooth it,
  // then map to a hue. Smoothing rate rises with confidence so the hue settles quickly on
  // confident voiced frames and coasts gently when the signal is weak. Every cue feeds only
  // this score, so the smart bulb and colorblind ramp inherit it automatically.
  _updateGenderHue() {
    const a = this.analyzer;
    const g = this.genderCues;

    // Build per-cue {value (0..1 femininity), confidence}.
    // pitchZone: absolute F0 position (110–230 Hz → 0–1) from modal F0 — no longer relative
    //   to the user's own range, so it carries real gender-perceptual information.
    // resonance: aVTL-primary score. Not vowel-robust — vowel identity moves it about 3x more
    //   than speaker sex does (see the resonance-score comment in VoiceAnalyzer.update).
    // weight: lower = lighter/breathier (more feminine); higher = heavier/pressed (more masculine).
    // dispersion and cpp are now absorbed into resonance and weight respectively.
    const cues = {
      pitchZone: { value: clamp01(a.metrics.pitchZone), confidence: a.modalF0Confidence },
      // §4: THE PERCEPTION MODEL CONSUMES ABSOLUTE ONLY. This is §2.7's accepted point — a
      // personally-normalised resonance feeding a gender score means two speakers with
      // completely different vocal tracts both score 1.0 at their own brightest, which is not a
      // statement about how either of them sounds. A frame with no reading contributes the cue
      // at zero confidence rather than a substituted value.
      resonance: {
        value: a.resonanceAbsolute != null ? clamp01(a.resonanceAbsolute) : 0,
        confidence: a.resonanceAbsolute != null ? a.formantConfidence : 0,
      },
      weight: { value: 1 - clamp01(a.metrics.weight), confidence: a.spectralTiltConfidence }, // invert: low weight = light/feminine
      sibilant: { value: computeSibilantFemininity(a.sibilantCentroidHz), confidence: a.sibilantConfidence },
      intonation: { value: clamp01(a.metrics.bounce), confidence: a.pitchConfidence },
    };

    const enabledMap = {
      pitchZone: true,
      resonance: true,
      weight: g.weight != null ? g.weight : true,
      sibilant: g.sibilant,
      intonation: g.intonation,
    };

    const gMode = this.goalMode || 'feminization';
    const gWeights = gMode === 'masculinization' ? MASCULINIZATION_CUE_WEIGHTS : FEMINIZATION_CUE_WEIGHTS;
    const { score, uncertainty } = computeGenderScoreMulti({
      cues,
      weights: gWeights,
      enabledMap,
      goalMode: gMode,
      modalF0Hz: a.modalF0Hz,
    });

    const conf = clamp01(1 - uncertainty);
    const lerp = 0.05 + conf * 0.08;
    this.smoothGenderScore += (score - this.smoothGenderScore) * lerp;
    this.genderUncertainty = uncertainty;
    return genderScoreToHue(this.smoothGenderScore, this.colorblindMode);
  }

  drawSceneInternal(prosodyGlow) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (!w || !h) return;

    // Background — theme-aware
    const themePresets = {
      highcontrast: ['#030305', '#080814', '#0c0c1f', '#12122a']
    };
    const colors = themePresets[this.themeMode] || themePresets.highcontrast;
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, colors[0]);
    bgGrad.addColorStop(0.4, colors[1]);
    bgGrad.addColorStop(0.7, colors[2]);
    bgGrad.addColorStop(1, colors[3]);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Stars
    const time = performance.now() / 1000;
    for (const star of this.stars) {
      const sx = ((star.x - this.scrollX * 0.05) % (w + 100) + w + 100) % (w + 100);
      const twinkle = 0.4 + 0.6 * Math.sin(time * 2.2 + star.twinkle + prosodyGlow * 2);
      ctx.globalAlpha = twinkle * 0.6;
      ctx.fillStyle = '#e8e6f0';
      ctx.beginPath();
      ctx.arc(sx, star.y, star.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Mountain ranges — parallax layers for speed perception
    if (this.mountainLayers) {
      for (const mtn of this.mountainLayers) {
        const baseY = h * mtn.baseY;
        const scrollOffset = this.scrollX * mtn.parallax;
        ctx.beginPath();
        ctx.moveTo(-20, h);
        for (let x = -20; x <= w + 20; x += 3) {
          const worldX = x + scrollOffset;
          let my = 0;
          for (const l of mtn.layers) {
            my += l.amp * Math.sin(worldX * l.freq + l.phase);
          }
          ctx.lineTo(x, baseY - Math.abs(my));
        }
        ctx.lineTo(w + 20, h);
        ctx.closePath();
        ctx.fillStyle = mtn.color;
        ctx.fill();
        // Subtle top edge highlight
        ctx.beginPath();
        for (let x = -20; x <= w + 20; x += 3) {
          const worldX = x + scrollOffset;
          let my = 0;
          for (const l of mtn.layers) {
            my += l.amp * Math.sin(worldX * l.freq + l.phase);
          }
          const gy = baseY - Math.abs(my);
          if (x === -20) ctx.moveTo(x, gy); else ctx.lineTo(x, gy);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // === Camera transform — zoom + vertical follow ===
    ctx.save();
    const zoomPivotX = this.ball.x;
    const zoomPivotY = this.groundY;
    ctx.translate(zoomPivotX, zoomPivotY);
    ctx.scale(this.cameraZoom, this.cameraZoom);
    ctx.translate(-zoomPivotX, -zoomPivotY);
    ctx.translate(0, -this.cameraY);

    // Ground fill — extend bottom well past viewport for camera shifts + zoom
    const groundFillBottom = h / this.cameraZoom + Math.abs(this.cameraY) + 200;
    // Ground fill with extended range for zoom
    const margin = w * 0.3; // extra margin for zoom edges
    ctx.beginPath();
    ctx.moveTo(-margin, groundFillBottom);
    for (let x = -margin; x <= w + margin; x += 4) {
      ctx.lineTo(x, this.getGroundHeight(this.scrollX + x));
    }
    ctx.lineTo(w + margin, groundFillBottom);
    ctx.closePath();
    const groundGrad = ctx.createLinearGradient(0, this.groundY - 40, 0, groundFillBottom);
    const gc = this._groundColors || ['#1e1e3a', '#191932', '#121228'];
    groundGrad.addColorStop(0, gc[0]);
    groundGrad.addColorStop(0.2, gc[1]);
    groundGrad.addColorStop(1, gc[2]);
    ctx.fillStyle = groundGrad;
    ctx.fill();

    // Ground line — brighter for visibility
    ctx.beginPath();
    for (let x = -margin; x <= w + margin; x += 4) {
      const gy = this.getGroundHeight(this.scrollX + x);
      if (x === -margin) ctx.moveTo(x, gy); else ctx.lineTo(x, gy);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Trail
    for (const tp of this.trailPoints) {
      const screenX = tp.wx - this.scrollX;
      if (screenX < -50 || screenX > w + 50) continue;
      ctx.globalAlpha = tp.life * 0.4;
      ctx.fillStyle = `hsl(${tp.hue}, 80%, 60%)`;
      ctx.beginPath();
      ctx.arc(screenX, tp.sy, tp.size * tp.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Speed lines — horizontal streaks when moving fast
    if (this.scrollSpeed > 150) {
      const speedIntensity = Math.min(1, (this.scrollSpeed - 150) / 200); // 0→1 from 150→350 px/s
      const lineCount = Math.floor(3 + speedIntensity * 8);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.04 + speedIntensity * 0.12})`;
      ctx.lineWidth = 1 + speedIntensity;
      for (let i = 0; i < lineCount; i++) {
        // Distribute lines around the ball with some randomness
        const seed = (i * 7919 + Math.floor(this.scrollX * 0.1)) % 1000 / 1000; // deterministic per frame
        const yOffset = (seed - 0.5) * this.height * 0.6;
        const lineY = this.ball.y + yOffset;
        const lineLen = 30 + speedIntensity * 80 + seed * 40;
        const lineX = this.ball.x - this.ball.radius * 2 - 20 - seed * 60;
        ctx.globalAlpha = (0.08 + speedIntensity * 0.2) * (1 - Math.abs(yOffset) / (this.height * 0.35));
        if (ctx.globalAlpha > 0.02) {
          ctx.beginPath();
          ctx.moveTo(lineX, lineY);
          ctx.lineTo(lineX - lineLen, lineY);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Particles
    for (const p of this.particles) p.draw(ctx);

    // Shadow
    const groundAtBall = this.getGroundHeight(this.scrollX + this.ball.x);
    const shadowDist = groundAtBall - (this.ball.y + this.ball.radius);
    const shadowAlpha = Math.max(0, 0.3 - shadowDist * 0.002);
    const shadowScale = Math.max(0.3, 1 - shadowDist * 0.003);
    if (shadowAlpha > 0.01) {
      ctx.globalAlpha = shadowAlpha;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(this.ball.x, groundAtBall, this.ball.radius * shadowScale * 1.2, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Ball
    ctx.save();
    ctx.translate(this.ball.x, this.ball.y + this.ball.radius * (1 - this.ball.squash) * 0.5);
    ctx.scale(1 + (1 - this.ball.squash) * 0.3, this.ball.squash);

    // Ball glow — boosted for visibility against dark scene. When SNR trust is low the
    // glow shrinks and breathes with a calm slow pulse (never a strobe), so an unreliable
    // reading looks unsettled rather than confidently bright.
    const trust = this.trustVividness;
    const glowPulse = trust > 0.85 ? 1 : 0.82 + 0.18 * Math.sin(time * 2.2);
    const glowSize = this.ball.radius * (2.2 + prosodyGlow * 1.5) * (0.7 + 0.3 * trust);
    const glowGrad = ctx.createRadialGradient(0, 0, this.ball.radius * 0.2, 0, 0, glowSize);
    glowGrad.addColorStop(0, this.getBallColor(0.35 * glowPulse));
    glowGrad.addColorStop(0.4, this.getBallColor(0.12 * glowPulse));
    glowGrad.addColorStop(0.7, this.getBallColor(0.04 * glowPulse));
    glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(0, 0, glowSize, 0, Math.PI * 2);
    ctx.fill();

    // Ball body — bright with rim light
    const ballGrad = ctx.createRadialGradient(
      -this.ball.radius * 0.25, -this.ball.radius * 0.25, 0,
      0, 0, this.ball.radius
    );
    ballGrad.addColorStop(0, '#fff');
    ballGrad.addColorStop(0.12, this.getBallColor());
    ballGrad.addColorStop(0.85, this.getBallColor());
    ballGrad.addColorStop(1, '#222');
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius, 0, Math.PI * 2);
    ctx.fill();

    // Rim light — subtle bright edge
    ctx.strokeStyle = this.getBallColor(0.4);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius - 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // Resonance ring — the ONE ring §6 requires. It shows `resonanceControl` and nothing else.
    // Five internal variables (formantScale, apparentVTL, formantPattern, f2Position,
    // resonanceConfidence) exist behind it and none of them is drawn: a two-scale metric is not
    // permission for two meters.
    //
    // Cool blue-violet = darker/longer → warm gold = brighter/shorter, on the user's own span
    // once they have calibrated and on the published population span until then.
    //
    // NO READING: the ring relaxes into a neutral listening ring — fixed radius, no hue travel,
    // no width travel — over RESONANCE_FADE_OUT_SEC. `presence` is the only thing that ramps;
    // it is not a resonance value and it is never used as one. See the constructor.
    const presence = this._resPresence;
    const resValue = this._resDisplayValue;
    // The CANONICAL confidence, not v1's `formantConfidence`. The ring's vividness is a claim
    // about how much to trust the number it is drawing, and that number now comes from the
    // canonical path — reading v1's estimator confidence here would put "which estimator the
    // room's noise selected" back into the display through the alpha channel, which is exactly
    // what Phase 3 took out of the value (§5 Phase 3).
    const resConf = this.analyzer.resonanceConfidenceV2;
    // The neutral ring is a constant. It encodes nothing, which is the point: a person can tell
    // "the app is not reading you" from "the app is reading you as very dark" because the two
    // do not look alike.
    const NEUTRAL_HUE = 250, NEUTRAL_SAT = 6, NEUTRAL_LIT = 42;
    const mix = (neutral, value) => neutral + (value - neutral) * presence;
    // Before the first reading of a session there is no value to relax FROM, so the ring is
    // simply the neutral one at its resting alpha.
    const res = resValue != null ? resValue : 0.5;
    const readingAlpha = (0.10 + res * 0.35 + prosodyGlow * 0.1) * (0.3 + resConf * 0.7);
    const resAlpha = mix(0.07, readingAlpha);
    if (resAlpha > 0.04) {
      // F2 ring (primary): colorblind = blue(220)→yellow(55), normal = blue(240)→gold(45)
      let resHue, resSat, resLit;
      if (this.colorblindMode) {
        resHue = mix(NEUTRAL_HUE, 220 - res * 165); // 220 (blue) → 55 (yellow)
        resSat = mix(NEUTRAL_SAT, 70 + res * 30);
        resLit = mix(NEUTRAL_LIT, 45 + res * 35);   // darker blue → brighter yellow
      } else {
        resHue = mix(NEUTRAL_HUE, 240 - res * 195);
        resSat = mix(NEUTRAL_SAT, 60 + res * 40);
        resLit = mix(NEUTRAL_LIT, 50 + res * 30);
      }
      const ringRadius = this.ball.radius + mix(6, 4 + res * 6 + prosodyGlow * 3);
      ctx.strokeStyle = `hsla(${resHue}, ${resSat}%, ${resLit}%, ${resAlpha})`;
      ctx.lineWidth = mix(1, 1.5 + res * 2);
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      // F2 glow
      const ringGlow = ctx.createRadialGradient(0, 0, ringRadius - 2, 0, 0, ringRadius + 8 + res * 6);
      ringGlow.addColorStop(0, `hsla(${resHue}, ${resSat}%, ${resLit}%, ${resAlpha * 0.4})`);
      ringGlow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ringGlow;
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius + 8 + res * 6, 0, Math.PI * 2);
      ctx.fill();

      // F3 outer ring — appears when F3 is high (> 2500 Hz) and confident
      // Separate visual from F2 ring: thinner, more cyan/white toned
      const f3Norm = Math.max(0, Math.min(1, (this.analyzer.smoothF3 - 2200) / 1200));
      // Scaled by presence for the same reason as the main ring: it is a value-bearing mark and
      // must not keep asserting an F3 on a frame the app declined to read.
      const f3Alpha = f3Norm * resConf * 0.45 * presence;
      if (f3Alpha > 0.03) {
        const f3Radius = ringRadius + 6 + res * 6 + f3Norm * 4;
        const f3Hue = 200 - f3Norm * 30; // cyan → bright blue-white
        ctx.strokeStyle = `hsla(${f3Hue}, ${40 + f3Norm * 30}%, ${65 + f3Norm * 25}%, ${f3Alpha})`;
        ctx.lineWidth = 0.8 + f3Norm * 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, f3Radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Rotation stripe
    ctx.save();
    ctx.rotate(this.ball.rotation);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius * 0.7, -0.5, 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius * 0.7, Math.PI - 0.5, Math.PI + 0.5);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // --- Calm reliability nudge (the non-color channel) ---
    // After SNR has sat in the red tier for a moment, say it plainly so a noisy room isn't
    // mistaken for a voice change. Calm amber (never alarm red), fades in, auto-hides as
    // trust recovers. Pairs with the ball's desaturation so the cue isn't colour-only.
    if (this._lowTrustSecs > 1.5) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (this._lowTrustSecs - 1.5) / 0.8) * 0.92;
      ctx.font = '600 13px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = this.colorblindMode ? '#ffd166' : '#ffb86b';
      // With DAF on, the most likely "noise" is the app's own playback leaking
      // out of the speakers and back into the mic — that loop also drags the
      // adaptive noise floor up. Name that cause first; it's the fixable one.
      ctx.fillText(
        this.dafActive
          ? 'Room’s a bit noisy — if DAF is on speakers, headphones will fix this'
          : 'Room’s a bit noisy — readings may drift (try a closer mic)',
        w / 2, 34);
      ctx.restore();
    }

    // Sparkles
    for (const s of this.sparkles) {
      const alpha = s.life / s.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff';
      const cx = s.x, cy = s.y, sz = s.size * alpha;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const r = i % 2 === 0 ? sz : sz * 0.3;
        ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // === End camera transform ===
    ctx.restore();
  }

  _pitchHzToNoteLabel(hz) {
    if (!hz || !Number.isFinite(hz)) return '—';
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const note = names[(midi + 1200) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${note}${octave}`;
  }

  _triggerMetricHighlight(metric, threshold = 0.75) {
    const val = this.analyzer.metrics[metric] || 0;
    const isExtreme = val >= threshold;
    if (isExtreme && !this.metricExtremeLatch[metric]) {
      this.metricHighlightTimers[metric] = 0.35;
    }
    this.metricExtremeLatch[metric] = isExtreme;
  }
  // ============================================================
  // VIBRATION ALERT ENGINE
  // ============================================================
  // ===== §7 QUESTION 3, DECIDED: the haptic threshold lives on CONTROL =====
  //
  // "Absolute is cross-device consistent; control is what the user is training against." Both
  // halves are true, and the tie is broken by what a haptic IS: an instruction to move, fired
  // while the user is speaking and cannot look at a screen. Three reasons, in order of weight:
  //
  //   1. On absolute, the shipped defaults are unreachable for most speakers. `resonanceAbsolute`
  //      puts a whole adult population inside about 22 points (P&B's two pooled means are 46.1
  //      and 54.8), and one speaker's entire across-vowel excursion is 14.5 of them. A rule that
  //      says "buzz below 30" would never fire for a great many people and would fire
  //      permanently for the rest. A threshold that cannot be crossed is not a coaching signal.
  //   2. D1's cross-surface argument is satisfied by the SPAN, not by the axis. D1 objects to
  //      "resonance 50%" meaning VTL on the desktop and brightness on the watch — a different
  //      QUANTITY per device. Control is the same quantity everywhere; what it needs to travel
  //      is the same span everywhere, which is why the calibrated profile is persisted and
  //      whitelisted for export alongside the rules that depend on it. A rule and the span it
  //      was set against travel together or neither does.
  //   3. Control is defined on frame one. Until the user calibrates it is the PUBLISHED
  //      POPULATION SPAN, so a fresh install has working haptics with defensible ends rather
  //      than an inert feature and a nag screen.
  //
  // The cost is stated rather than hidden: a control threshold means something different after
  // a recalibration than before it. That is exactly what §3.5's machinery is for — the span has
  // an id, a stored reading records which span it was taken on, and a rule set against one span
  // is re-prompted rather than silently reinterpreted when the span moves.
  //
  // `resonanceAbsolute` remains what the perception model, the session summary and any
  // cross-device or cross-session comparison read. Nothing here changes that.
  checkVibrationAlerts(dt) {
    const vib = this.vibration;

    // Decay flash alpha always (even when disabled, to fade out)
    vib.flashAlpha = Math.max(0, vib.flashAlpha - dt * 3);

    if (!vib.enabled || vib.rules.length === 0) return;

    vib.globalCooldown = Math.max(0, vib.globalCooldown - dt);

    if (vib.shakeTimer > 0) {
      vib.shakeTimer -= dt;
      if (vib.shakeTimer <= 0 && this._gameArea) {
        this._gameArea.classList.remove('vib-shake');
      }
    }

    const m = this.analyzer.metrics;
    const hz = this.analyzer.smoothPitchHz;
    const isSpeaking = m.energy > 0.05;
    let anyTrippedNow = false;
    let needsRender = false;
    let trippedLabel = '';

    for (const rule of vib.rules) {
      // §3.5: "no hardware threshold fires against a value from a different version." One
      // question, one definition, asked here and on the watch overlay both (ruleMayFire). A
      // resonance rule stored before the split carries no metric version, is read as v1, and
      // CANNOT FIRE until the user has looked at the number on the new scale and confirmed it.
      // Its threshold is preserved exactly as they typed it; nothing is rescaled or guessed.
      if (!ruleMayFire(rule)) {
        if (rule.tripped) { rule.tripped = false; needsRender = true; }
        continue;
      }

      rule.cooldownTimer = Math.max(0, rule.cooldownTimer - dt);

      let currentVal;
      switch (rule.metric) {
        case 'pitch': currentVal = hz; break;
        // §7 question 3, answered: THE HAPTIC THRESHOLD IS ON CONTROL. See the note above
        // checkVibrationAlerts. A suppressed frame has no value, so no rule can trip on it —
        // `currentVal` stays null and the comparison below is skipped rather than being fed a 0
        // that would fire every "below" rule the moment the room got noisy.
        case 'resonance': currentVal = this.analyzer.resonanceControl != null
          ? this.analyzer.resonanceControl * 100 : null; break;
        case 'energy': currentVal = m.energy * 100; break;
        case 'bounce': currentVal = m.bounce * 100; break;
        case 'tempo': currentVal = 0; break;
        case 'vowel': currentVal = m.vowel * 100; break;
        case 'articulation': currentVal = m.articulation * 100; break;
        default: currentVal = 0;
      }

      let conditionMet = false;
      if (isSpeaking && currentVal != null) {
        conditionMet = rule.direction === 'below'
          ? currentVal < rule.threshold
          : currentVal > rule.threshold;
      }

      const wasTripped = rule.tripped;
      rule.tripped = conditionMet;
      if (wasTripped !== conditionMet) needsRender = true;

      if (conditionMet) {
        anyTrippedNow = true;
        const metricLabels = {
          pitch: 'Pitch', resonance: 'Resonance', energy: 'Energy',
          bounce: 'Pitch Var.', tempo: 'Tempo', vowel: 'Vowels', articulation: 'Articulation'
        };
        trippedLabel = metricLabels[rule.metric] || rule.metric;

        if (rule.cooldownTimer <= 0 && vib.globalCooldown <= 0) {
          this._triggerVibration(trippedLabel);
          rule.cooldownTimer = 0.5;
          vib.globalCooldown = 0.25;
        }
      }
    }

    // Update live values when vib panel is visible (throttled to ~10fps)
    if (this._updateVibLiveUI) {
      vib._liveUpdateTimer = (vib._liveUpdateTimer || 0) + dt;
      if (vib._liveUpdateTimer > 0.1) {
        vib._liveUpdateTimer = 0;
        const vibPanelEl = document.getElementById('vibPanel');
        if (vibPanelEl && vibPanelEl.classList.contains('show')) {
          this._updateVibLiveUI();
        } else if (needsRender) {
          // Even if panel closed, update tripped state for next open
          this._updateVibLiveUI();
        }
      }
    }
  }

  _triggerVibration(metricLabel) {
    const vib = this.vibration;

    if (vib.hasHaptic) {
      try { navigator.vibrate([40, 30, 40]); } catch (e) { }
    }

    // Screen shake (skip if reduced motion)
    if (this._gameArea && !this.reducedMotion) {
      this._gameArea.classList.remove('vib-shake');
      void this._gameArea.offsetWidth;
      this._gameArea.classList.add('vib-shake');
      vib.shakeTimer = 0.15;
    }

    // On-canvas flash (always show — it's a brief opacity change, not motion)
    vib.flashAlpha = 1;
    vib.flashMetric = metricLabel || '';
  }

  // ============================================================
  // SESSION SUMMARY
  // ============================================================
  _showSessionSummary() {
    const sess = this.session;
    const overlay = document.getElementById('summaryOverlay');
    const grid = document.getElementById('summaryGrid');
    const bar = document.getElementById('summaryProsodyBar');

    // Format duration
    const mins = Math.floor(sess.duration / 60);
    const secs = Math.floor(sess.duration % 60);
    document.getElementById('summaryDuration').textContent =
      mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    // Build stats grid based on mode
    const stats = [];

    // Pitch stats (all modes)
    if (sess.pitchCount > 0) {
      const avgPitch = Math.round(sess.pitchSum / sess.pitchCount);
      const minP = sess.pitchMin === Infinity ? 0 : Math.round(sess.pitchMin);
      const maxP = Math.round(sess.pitchMax);
      stats.push({ value: `${avgPitch} Hz`, label: 'Avg Pitch' });
      stats.push({ value: `${minP}–${maxP}`, label: 'Pitch Range (Hz)' });
    } else {
      stats.push({ value: '—', label: 'Avg Pitch' });
      stats.push({ value: '—', label: 'Pitch Range' });
    }

    // Resonance (all modes)
    if (sess.resonanceCount > 0) {
      const avgRes = Math.round((sess.resonanceSum / sess.resonanceCount) * 100);
      stats.push({ value: `${avgRes}%`, label: 'Avg Resonance' });
    } else {
      stats.push({ value: '—', label: 'Avg Resonance' });
    }

    // Average prosody
    if (sess.prosodyHistory.length > 0) {
      // ⚡ Bolt: Replace reduce with traditional loop for performance
      let prosodySum = 0;
      for (let i = 0; i < sess.prosodyHistory.length; i++) {
        prosodySum += sess.prosodyHistory[i];
      }
      const avgProsody = Math.round((prosodySum / sess.prosodyHistory.length) * 100);
      stats.push({ value: `${avgProsody}%`, label: 'Avg Prosody' });
    } else {
      stats.push({ value: '—', label: 'Avg Prosody' });
    }

    // Render stats grid (Security enhancement: safe DOM construction)
    grid.textContent = '';
    const gridFrag = document.createDocumentFragment();
    for (const s of stats) {
      const statDiv = document.createElement('div');
      statDiv.className = 'summary-stat' + (s.wide ? ' wide' : '');
      const valDiv = document.createElement('div');
      valDiv.className = 'summary-stat-value';
      valDiv.textContent = s.value;
      const labelDiv = document.createElement('div');
      labelDiv.className = 'summary-stat-label';
      labelDiv.textContent = s.label;
      statDiv.append(valDiv, labelDiv);
      gridFrag.append(statDiv);
    }
    grid.append(gridFrag);

    // Render prosody sparkline
    const history = sess.prosodyHistory;
    if (history.length > 2) {
      document.getElementById('summaryProsodyWrap').style.display = '';
      const barFrag = document.createDocumentFragment();
      const bar = document.getElementById('summaryProsodyBar');
      bar.textContent = '';

      // Downsample to ~60 bars max
      const maxBars = 60;
      const step = Math.max(1, Math.floor(history.length / maxBars));
      const bars = [];
      for (let i = 0; i < history.length; i += step) {
        const slice = history.slice(i, i + step);
        let sliceSum = 0;
        for (let j = 0; j < slice.length; j++) {
          sliceSum += slice[j];
        }
        const v = sliceSum / slice.length;
        bars.push(v);
      }
      // ...
      for (const v of bars) {
        const h = Math.max(2, v * 30);
        const hue = 220 + v * 80; // blue → purple as prosody increases
        const seg = document.createElement('div');
        seg.className = 'bar-seg';
        seg.style.height = `${h}px`;
        seg.style.backgroundColor = `hsl(${Math.round(hue)}, 60%, ${Math.round(45 + v * 20)}%)`;
        barFrag.append(seg);
      }
      bar.append(barFrag);
    } else {
      document.getElementById('summaryProsodyWrap').style.display = 'none';
    }

    overlay.classList.add('show');
  }

  // Split a passage into sentences, keeping terminal punctuation with each
  // sentence and capturing any trailing fragment that lacks final punctuation.
  _splitSentences(text) {
    if (!text) return [];
    const parts = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|\S[^.!?]*$/g);
    return (parts || [text]).map((s) => s.trim()).filter(Boolean);
  }

  _teleprompterSourceText() {
    return this.teleprompterMode === 'custom' ? this.teleprompterCustomText : this.teleprompterRainbowText;
  }

  // Manual advance: speaker presses Space (desktop) or taps (mobile) to reveal
  // the next sentence. Wraps back to the start at the end of the passage.
  _advanceTeleprompterManual() {
    const enabled = this.teleprompterMode !== 'off';
    if (!enabled) return;
    const sentences = this._splitSentences(this._teleprompterSourceText());
    if (!sentences.length) return;
    this.teleprompterSentenceIndex = (this.teleprompterSentenceIndex + 1) % sentences.length;
  }

  renderTeleprompter(dt) {
    const overlay = document.getElementById('teleprompterOverlay');
    if (!overlay) return;
    const hint = document.getElementById('teleprompterHint');
    const enabled = this.teleprompterMode !== 'off';
    overlay.classList.toggle('show', enabled);
    if (hint) hint.classList.toggle('show', enabled && this.isRunning);
    if (!enabled) { this._tpLastIdx = -1; return; }

    // This runs every frame — only re-split and rebuild the overlay DOM when the
    // passage text or sentence index actually changed.
    const sourceText = this._teleprompterSourceText();
    if (this.teleprompterSentenceIndex === this._tpLastIdx && sourceText === this._tpLastText) return;

    const sentences = this._splitSentences(sourceText);
    if (!sentences.length) return;
    if (this.teleprompterSentenceIndex >= sentences.length) {
      this.teleprompterSentenceIndex = sentences.length - 1;
    }
    const idx = this.teleprompterSentenceIndex;
    this._tpLastIdx = idx;
    this._tpLastText = sourceText;

    overlay.textContent = '';
    const frag = document.createDocumentFragment();
    const cur = document.createElement('span');
    cur.className = 'active-sentence';
    cur.textContent = sentences[idx];
    frag.append(cur);
    if (idx + 1 < sentences.length) {
      frag.append(document.createTextNode(' '));
      const nxt = document.createElement('span');
      nxt.className = 'next-sentence';
      nxt.textContent = sentences[idx + 1];
      frag.append(nxt);
    }
    overlay.append(frag);
  }

  updateMeters() {
    this._triggerMetricHighlight('articulation', 0.72);

    // Cache the DOM lookups — this runs every frame, and getElementById/querySelector
    // ten times per frame is pure waste. The static 3px indicator width is set once here too.
    if (!this._meterEls) {
      this._meterEls = {
        pitch: document.getElementById('meterPitch'),
        valPitch: document.getElementById('valPitch'),
        resonance: document.getElementById('meterResonance'),
        valResonance: document.getElementById('valResonance'),
        highlight: {
          tempo: document.querySelector('.meter-tempo .meter-label'),
          articulation: document.querySelector('.meter-artic .meter-label'),
        },
        mapSplatter: document.getElementById('mapSplatter'),
        pitchStatus: document.getElementById('pitchProfileLearned'),
        tiltStatus: document.getElementById('tiltProfileLearned'),
        resonanceStatus: document.getElementById('resonanceProfileLearned'),
        confidenceStatus: document.getElementById('frameConfidenceLabel'),
      };
      this._meterEls.pitch.style.width = '3px';
      this._meterEls.resonance.style.width = '3px';
    }
    const els = this._meterEls;

    // Pitch meter — position-based indicator (not fill width). The bar tracks the live pitch;
    // the numeric readout shows a windowed average (formatted per the Pitch display mode).
    // Map 80-300 Hz to 0-100% position on the gradient bar
    const hz = this.analyzer.smoothPitchHz;
    const pitchPos = pitchHzToPosition(hz, 80, 300);
    els.pitch.style.left = (pitchPos * 100) + '%';
    els.valPitch.textContent = this._pitchReadout();

    // Resonance meter — position-based indicator like pitch; numeric readout = windowed average.
    //
    // NO READING: the indicator FADES OUT rather than parking somewhere. A greyed-out marker
    // still sitting at 62% is a position claim, and there is no position to claim. The numeric
    // readout blanks on the first suppressed frame on its own, because `_pushAvgSamples` stops
    // feeding the window (see the constructor's note).
    const resPos = this._resDisplayValue != null ? this._resDisplayValue : 0.5;
    els.resonance.style.left = (resPos * 100) + '%';
    els.resonance.style.opacity = String(this._resPresence);
    els.valResonance.textContent = this._resonanceReadout();

    for (const [k, el] of Object.entries(els.highlight)) {
      this.metricHighlightTimers[k] = Math.max(0, this.metricHighlightTimers[k] - 1 / 60);
      if (el) el.classList.toggle('active-ping', this.metricHighlightTimers[k] > 0);
    }
    if (els.mapSplatter) els.mapSplatter.classList.toggle('active-ping', this.metricHighlightTimers.articulation > 0);

    const pitchStatus = els.pitchStatus;
    const tiltStatus = els.tiltStatus;
    const resonanceStatus = els.resonanceStatus;
    const confidenceStatus = els.confidenceStatus;
    if (pitchStatus || tiltStatus || resonanceStatus || confidenceStatus) {
      if (pitchStatus) {
        pitchStatus.textContent = this._formatAdaptiveStatus(this.analyzer.pitchProfile,
          (p) => `${Math.round(p.min)}–${Math.round(p.max)} Hz learned`);
      }
      if (tiltStatus) {
        tiltStatus.textContent = this._formatAdaptiveStatus(this.analyzer.tiltProfile,
          (t) => `${t.min.toFixed(1)} to ${t.max.toFixed(1)} dB learned`);
      }
      if (resonanceStatus) {
        resonanceStatus.textContent = this._resonanceSpanStatus();
      }
      if (confidenceStatus) confidenceStatus.textContent = `${Math.round(this.analyzer.frameConfidence * 100)}%`;
    }
  }

  // Shared formatter for an adaptive-profile status readout (pitch / tilt / resonance). Returns
  // the learned label once the profile is trained, otherwise a capped "Learning… X%" from its
  // voiced-time progress. Single source for the string so the settings panel and the meters
  // panel can't drift apart.
  // What the resonance status line says now that the displayed number is normalised against a
  // SPAN rather than learned passively from ambient speech. Deliberately never shows the
  // absolute value, the tract length, the vowel or f2Position: §6's risk is that the
  // decomposition leaks into the interface, and "five internal variables is an implementation
  // detail" applies to a status string as much as to a second meter.
  _resonanceSpanStatus() {
    const p = this.analyzer.resonanceProfileV2;
    if (!p) return 'Typical adult range — calibrate to use your own';
    const width = Math.round((p.span.max - p.span.min) * 100);
    return p.spreadFloored
      ? `Your range (narrow — ${width} pts; try wider postures)`
      : `Your range (${width} pts wide)`;
  }

  _formatAdaptiveStatus(profile, learnedFormatter) {
    if (profile.isLearned) return learnedFormatter(profile);
    const pct = Math.min(100, Math.round((profile.voicedTime / Math.max(0.1, profile.learningDuration)) * 100));
    return `Learning… ${pct}%`;
  }

  _meterLabel(val, low, mid, high) {
    const pct = Math.round(val * 100);
    if (pct <= 15) return `${pct}% · ${low}`;
    if (pct <= 55) return `${pct}% · ${mid}`;
    return `${pct}% · ${high}`;
  }

  // ============================================================
  // WINDOWED-AVERAGE READOUTS (pitch / resonance / attack / weight)
  // ============================================================

  // Collect one time-stamped sample per metric every frame (voicing/confidence-gated so the
  // averages reflect actual phonation, not silence). Called unconditionally from the render
  // loop — independent of whether the expanded panel is open — so the always-visible HUD
  // readouts have history to average.
  _pushAvgSamples() {
    const a = this.analyzer, m = a.metrics;
    const t = performance.now() / 1000;
    const B = this._avgBuffers;

    if (a.lastPitch > 0 && a.smoothPitchHz > 0 && a.pitchConfidence > 0.35 && m.energy > 0.05) {
      B.pitch.push({ t, v: a.smoothPitchHz });
    }
    // Only frames that PRODUCED A READING reach the windowed average. That is what makes the
    // HUD's numeric readout blank on its own during a suppressed stretch rather than needing a
    // second "is it suppressed" rule beside the averaging one. `resonancePresent` already
    // subsumes the old confidence gate — a frame below the confidence floor is suppressed — so
    // there is no second threshold here to drift away from the first.
    if (a.resonancePresent && m.energy > 0.05) {
      // Carry the frame's confidence so the readout can weight by it. The 0.2 gate admits a
      // frame; it does not make a 0.21-confidence frame worth as much as a 0.95 one, and the
      // Voice Map cloud has always weighted its samples this way (summarizeVoiceCloud).
      // Canonical throughout: the formants, the value and the weight all come from the path
      // that defines the measurement, so one record cannot mix two provenances.
      B.resonance.push({
        t, f1: a.canonicalF1 || a.smoothF1, f2: a.canonicalF2 || a.smoothF2, res: a.resonanceControl,
        w: clamp01(a.resonanceConfidenceV2) * (0.4 + 0.6 * clamp01(a.formantScaleFitQuality)),
      });
    }
    if (m.attack > 0.02) {
      B.attack.push({ t, v: m.attack, rise: a.attackRiseHardness, abrupt: a.attackAbruptness });
    }
    if (a.spectralTiltConfidence > 0.2) {
      B.weight.push({ t, v: m.weight, tilt: 1 - a.spectralWeight, h1h2: a.h1h2SmoothedDb });
    }

    // Voice Map cloud — one confidence-weighted sample per ~100 ms of confident voicing.
    // The per-sample score is the pure pitch+resonance blend (not smoothGenderScore, which
    // only updates in gender color mode), so map tinting works in every mode and matches
    // the background field, which is painted with the same function.
    if (t - this._voiceMapLastPush >= 0.1 &&
        a.lastPitch > 0 && a.smoothPitchHz > 0 && a.pitchConfidence > 0.35 &&
        a.resonancePresent && a.formantConfidence > 0.2 && m.energy > 0.05) {
      this._voiceMapPoints.push({
        t,
        hz: a.smoothPitchHz,
        // The map's Y AXIS is the displayed axis, so it is control. Its TINT is a perceived-
        // gender score, so that reads absolute — the same split as everywhere else, and the
        // reason the two are named separately here rather than sharing one variable.
        res: clamp01(a.resonanceControl),
        score: computeGenderScore({
          pitchHz: a.smoothPitchHz,
          resonance: clamp01(a.resonanceAbsolute),
          pitchConfidence: a.pitchConfidence,
          formantConfidence: a.formantConfidence,
        }),
        w: clamp01(a.frameConfidence),
      });
      if (this._voiceMapPoints.length > this._voiceMapMax) this._voiceMapPoints.shift();
      this._voiceMapLastPush = t;
    }

    // Evict samples older than the retained max so buffers stay bounded; the active window
    // (which may be shorter, or 0 for "Live") is applied at read time in _recomputeAvgCache().
    const cutoff = t - this._avgWindowMaxSecs;
    for (const k in B) {
      const buf = B[k];
      while (buf.length && buf[0].t < cutoff) buf.shift();
    }
  }

  // Throttled accessor: returns a cached per-metric summary (or null when there aren't enough
  // samples). The whole cache is recomputed at most every _avgRefreshSecs so the displayed
  // numbers read calmly even though samples arrive at 60fps.
  _avgSummary(metric) {
    const t = performance.now() / 1000;
    if (this._avgWindowSecs <= 0) {
      // Live mode tracks every frame, but recompute at most once per frame (HUD + cards +
      // popup all call this), not once per readout.
      const frameId = Math.floor(t * 1000 / 16);
      if (frameId !== this._avgLastFrameId) { this._recomputeAvgCache(t); this._avgLastFrameId = frameId; }
    } else if (t - this._avgLastRefresh >= this._avgRefreshSecs) {
      this._recomputeAvgCache(t);
      this._avgLastRefresh = t;
    }
    return this._avgCache[metric] || null;
  }

  _recomputeAvgCache(now) {
    const B = this._avgBuffers;
    const live = this._avgWindowSecs <= 0;
    // In Live mode use only the most recent sample; otherwise the trailing time window.
    const within = (buf) => {
      if (!buf.length) return [];
      if (live) return buf.slice(-1);
      const cutoff = now - this._avgWindowSecs;
      let i = buf.length;
      while (i > 0 && buf[i - 1].t >= cutoff) i--;
      return buf.slice(i);
    };
    const MIN_N = live ? 1 : 5; // need a few samples for a stable window average

    // Pitch — mean Hz plus min/max and semitone range (range is the most training-useful cue).
    {
      const s = within(B.pitch);
      if (s.length >= MIN_N) {
        let sum = 0, min = Infinity, max = -Infinity;
        for (const p of s) { sum += p.v; if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
        const meanHz = sum / s.length;
        const rangeSemitones = (min > 0 && max > 0) ? 12 * Math.log2(max / min) : 0;
        this._avgCache.pitch = { n: s.length, meanHz, minHz: min, maxHz: max, rangeSemitones };
      } else this._avgCache.pitch = null;
    }

    // Resonance — CONFIDENCE-WEIGHTED mean of the adaptive 0-1 resonance score (the same score
    // that drives the meter bar position), bucketed into a plain-language 5-tier descriptor.
    // F1/F2 are kept only as supporting detail, not shown as raw numbers to the user.
    //
    // Also reports how much that descriptor is worth. Two things separate a settled reading
    // from a lucky one, and neither was visible before:
    //   - `effectiveN` (Kish): the number of full-confidence frames this window is *equivalent*
    //     to. Twenty barely-admitted frames are not twenty measurements.
    //   - `sd`: the weighted spread. A window straddling a tier edge reports a descriptor that
    //     will flip on the next frame; one sitting inside a tier reports a stable one.
    {
      const s = within(B.resonance);
      if (s.length >= MIN_N) {
        let wSum = 0, wSqSum = 0, f1 = 0, f2 = 0, res = 0;
        for (const p of s) {
          const w = Math.max(1e-6, p.w != null ? p.w : 1);
          wSum += w; wSqSum += w * w;
          f1 += p.f1 * w; f2 += p.f2 * w; res += p.res * w;
        }
        const meanF1 = f1 / wSum, meanF2 = f2 / wSum, meanRes = res / wSum;
        let varRes = 0;
        for (const p of s) {
          const w = Math.max(1e-6, p.w != null ? p.w : 1);
          const d = p.res - meanRes;
          varRes += d * d * w;
        }
        const sdRes = Math.sqrt(varRes / wSum);
        const effectiveN = wSqSum > 0 ? (wSum * wSum) / wSqSum : 0;
        const descriptor = meanRes >= 0.8 ? 'Bright'
          : meanRes >= 0.6 ? 'Bright Mid'
          : meanRes >= 0.4 ? 'Mid'
          : meanRes >= 0.2 ? 'Dark Mid'
          : 'Dark';
        // Distance to the nearest tier edge, in units of the reading's own spread. Below ~1 the
        // descriptor is inside the noise and should not be presented as settled.
        const edges = [0.2, 0.4, 0.6, 0.8];
        const edgeGap = Math.min(...edges.map((e) => Math.abs(meanRes - e)));
        const margin = sdRes > 1e-6 ? edgeGap / sdRes : Infinity;
        const reliability = (effectiveN >= 8 && margin >= 1) ? 'settled'
          : (effectiveN >= 4) ? 'provisional'
          : 'unsettled';
        this._avgCache.resonance = {
          n: s.length, effectiveN, meanF1, meanF2, meanRes, sd: sdRes, margin, reliability, descriptor,
        };
      } else this._avgCache.resonance = null;
    }

    // Attack — mean blended hardness plus the two sub-cues (rise-rate vs abruptness).
    {
      const s = within(B.attack);
      if (s.length >= MIN_N) {
        let v = 0, rise = 0, abrupt = 0;
        for (const p of s) { v += p.v; rise += (p.rise || 0); abrupt += (p.abrupt || 0); }
        const mean = v / s.length;
        const descriptor = mean <= 0.15 ? 'Soft' : mean <= 0.55 ? 'Medium' : 'Hard';
        this._avgCache.attack = { n: s.length, mean, meanRise: rise / s.length, meanAbrupt: abrupt / s.length, descriptor };
      } else this._avgCache.attack = null;
    }

    // Weight — mean blended heaviness plus per-cue means (spectral tilt, H1–H2 in dB).
    {
      const s = within(B.weight);
      if (s.length >= MIN_N) {
        let v = 0, tilt = 0, h1h2 = 0;
        for (const p of s) { v += p.v; tilt += p.tilt; h1h2 += p.h1h2; }
        const mean = v / s.length;
        const descriptor = mean <= 0.35 ? 'Light' : mean <= 0.6 ? 'Balanced' : 'Heavy';
        this._avgCache.weight = { n: s.length, mean, meanTilt: tilt / s.length, meanH1H2: h1h2 / s.length, descriptor };
      } else this._avgCache.weight = null;
    }
  }

  // ---- Readout formatters (shared by HUD meters, expanded cards, and focus popup) ----

  _pitchReadout(rich = false) {
    const s = this._avgSummary('pitch');
    if (!s) return (rich || this.pitchDisplayMode === 'hz') ? '— Hz' : '—';
    const note = this._pitchHzToNoteLabel(s.meanHz);
    if (rich) return `${Math.round(s.meanHz)} Hz · ${note} · ±${(s.rangeSemitones / 2).toFixed(1)}st`;
    switch (this.pitchDisplayMode) {
      case 'note': return note;
      case 'range': return `${s.rangeSemitones.toFixed(1)} st`;
      default: return `${Math.round(s.meanHz)} Hz`;
    }
  }

  // Plain-language tier: Bright / Bright Mid / Mid / Dark Mid / Dark.
  //
  // A tier label is a strong claim — five buckets across the whole scale, so landing in one
  // asserts the reading is accurate to about a tenth of the range. It frequently is not: near a
  // bucket edge, or on a handful of low-confidence frames, the label flips while the voice does
  // nothing. Rather than present that as a firm reading, mark it. `~` prefixes a provisional
  // tier; an unsettled one shows no tier at all, because a wrong tier is worse than none in an
  // app whose users are trying to hold a target.
  _resonanceReadout(rich = false) {
    const s = this._avgSummary('resonance');
    if (!s) return '—';
    if (s.reliability === 'unsettled') return rich ? 'Listening…' : '…';
    const tier = s.reliability === 'provisional' ? `~${s.descriptor}` : s.descriptor;
    if (!rich) return tier;
    return `${tier} · ${Math.round(s.meanRes * 100)}% ±${Math.round(s.sd * 100)}`;
  }

  _attackReadout() {
    const s = this._avgSummary('attack');
    if (!s) return '—';
    const v = this.attackMode === 'rise' ? s.meanRise
            : this.attackMode === 'abrupt' ? s.meanAbrupt
            : s.mean;
    const d = v <= 0.15 ? 'Soft' : v <= 0.55 ? 'Medium' : 'Hard';
    return `${Math.round(v * 100)}% · ${d}`;
  }

  _weightReadout() {
    const s = this._avgSummary('weight');
    if (!s) return '—';
    let v;
    if (this.weightMode === 'tilt') v = s.meanTilt;
    else if (this.weightMode === 'h1h2') v = 1 - normalizeAgainstRange(s.meanH1H2, H1H2_HEAVY_DB, H1H2_LIGHT_DB);
    else v = s.mean;
    v = Math.max(0, Math.min(1, v));
    const d = v <= 0.35 ? 'Light' : v <= 0.6 ? 'Balanced' : 'Heavy';
    return `${Math.round(v * 100)}% · ${d}`;
  }

  // ============================================================
  // EXPANDED METRICS — History tracking & rendering
  // ============================================================

  _pushMetricHistory() {
    const m = this.analyzer.metrics;
    const h = this._metricHistory;
    const max = this._metricHistoryMax;

    h.pitch.push(this.analyzer.smoothPitchHz);
    // Presentation history (the expanded-metrics sparkline), so control. A frame with no
    // reading pushes the last drawn presentation value rather than a 0 spike the user never
    // produced; `_resDisplayValue` is null only before the first ever reading.
    h.resonance.push(this._resDisplayValue != null ? this._resDisplayValue : 0);
    h.bounce.push(m.bounce);
    h.vowels.push(m.vowel);
    h.attack.push(m.attack);
    h.weight.push(m.weight);

    for (const k of Object.keys(h)) {
      const limit = (k === 'pitch' || k === 'bounce') ? this._metricHistoryMaxLong : max;
      if (h[k].length > limit) h[k].shift();
    }

    // Vowel scatter plot: collect F1/F2 points during voiced speech
    if (m.energy > 0.05 && this.analyzer.formantConfidence > 0.25 && this.analyzer.lastPitch > 0) {
      const f1 = this.analyzer.smoothF1;
      const f2 = this.analyzer.smoothF2;
      this._vowelPlotPoints.push({ x: f2, y: f1 });
      if (this._vowelPlotPoints.length > this._vowelPlotMax) this._vowelPlotPoints.shift();
    }
  }

  _sizeExpandedCanvases() {
    const ids = ['expCanvasPitch', 'expCanvasResonance', 'expCanvasBounce',
                 'expCanvasVowels', 'expCanvasAttack', 'expCanvasWeight', 'expCanvasVoiceMap'];
    for (const id of ids) {
      const c = document.getElementById(id);
      if (c) {
        const r = c.getBoundingClientRect();
        c.width = Math.round(r.width * devicePixelRatio);
        c.height = Math.round(r.height * devicePixelRatio);
      }
    }
  }

  _sizePopupCanvas() {
    const c = document.getElementById('metricPopupCanvas');
    if (c) {
      const r = c.getBoundingClientRect();
      c.width = Math.round(r.width * devicePixelRatio);
      c.height = Math.round(r.height * devicePixelRatio);
    }
  }

  _updateExpandedMetrics() {
    if (!this.metersExpanded && !this.metricPopupOpen) return;
    this._pushMetricHistory();
    this._updateAttackOrb(this.analyzer.metrics.attack);

    const m = this.analyzer.metrics;

    if (this.metersExpanded) {
      // Update expanded card values — windowed averages (visuals below stay live)
      const pEl = document.getElementById('expValPitch');
      if (pEl) pEl.textContent = this._pitchReadout(true);
      const rEl = document.getElementById('expValResonance');
      if (rEl) {
        rEl.textContent = this._resonanceReadout(true);
        const rs = this._avgSummary('resonance');
        // Say what the number is built on, so a reading taken from four shaky frames is not
        // presented with the same authority as one taken from a held vowel.
        rEl.title = rs
          ? `${rs.reliability} · ${rs.effectiveN.toFixed(1)} effective frames · ` +
            `F1 ${Math.round(rs.meanF1)} Hz, F2 ${Math.round(rs.meanF2)} Hz · ` +
            `method ${this.analyzer.activeResonanceMethod}`
          : 'no confident formant frames yet';
      }
      const atkEl = document.getElementById('expValAttack');
      if (atkEl) atkEl.textContent = this._attackReadout();
      const wtEl = document.getElementById('expValWeight');
      if (wtEl) wtEl.textContent = this._weightReadout();
      const vmEl = document.getElementById('expValVoiceMap');
      if (vmEl) vmEl.textContent = this._voiceMapReadout();

      // Render each card canvas
      this._drawLineGraph('expCanvasPitch', this._metricHistory.pitch, '#c084fc', 60, 400, true);
      this._drawSpectrogram('expCanvasResonance');
      this._drawLineGraph('expCanvasBounce', this._metricHistory.bounce, '#ff6b6b', 0, 1, false);
      this._drawVowelPlot('expCanvasVowels');
      this._drawOrb('expCanvasAttack', this._attackOrb.solidity, '#2ec4b6');
      this._drawOrb('expCanvasWeight', m.weight, '#e06c9f');
      this._drawVoiceMap('expCanvasVoiceMap');
    }

    // Render popup if open
    if (this.metricPopupOpen) {
      this._renderPopupCanvas(this.metricPopupOpen);
      this._updatePopupValue(this.metricPopupOpen);
    }
  }

  // ---- Drawing helpers for expanded cards ----

  _drawLineGraph(canvasId, data, color, minVal, maxVal, isHz) {
    const c = document.getElementById(canvasId);
    if (!c || !data.length) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Data line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const range = maxVal - minVal || 1;
    const xMax = Math.max(data.length, 2) - 1;
    for (let i = 0; i < data.length; i++) {
      const x = (i / xMax) * w;
      const val = Math.max(minVal, Math.min(maxVal, data[i]));
      const y = h - ((val - minVal) / range) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Glow effect
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 6 * devicePixelRatio;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Current value label
    if (data.length > 0) {
      const last = data[data.length - 1];
      const lastY = h - ((Math.max(minVal, Math.min(maxVal, last)) - minVal) / range) * (h - 4) - 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(w - 2, lastY, 3 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Advance the vocal-attack orb's gas→solid animation. A rising edge of the (decaying) attack
  // impulse marks a fresh onset; the orb then condenses toward that hardness at a speed
  // proportional to it — a hard attack snaps solid almost instantly, a soft attack blooms
  // slowly — before evaporating back to gas, ready for the next onset. The condensation *speed*
  // (and the solidity it reaches) is the readable signal.
  _updateAttackOrb(attackVal) {
    const st = this._attackOrb;
    const now = performance.now();
    const dt = st.lastT ? Math.min(0.1, (now - st.lastT) / 1000) : 0.016;
    st.lastT = now;
    if (attackVal > st.prevAttack + 0.02) st.hardness = attackVal; // fresh onset captured
    st.prevAttack = attackVal;
    const a = st.hardness;
    if (a > 0.01 && st.solidity < a - 0.005) {
      const rate = Math.min(1, (1.5 + a * 12) * dt); // speed ∝ hardness
      st.solidity += (a - st.solidity) * rate;
    } else {
      st.solidity += (0 - st.solidity) * Math.min(1, 2.2 * dt); // evaporate back to gas
      st.hardness *= 0.96;
    }
  }

  // Draw a single "gas → solid" orb for solidity ∈ [0,1]: a wide faint glow when gassy, a bright
  // dense core with a crisp rim when solid. Used for the Vocal Attack and Weight visualizations
  // (reads the canvas size, so it scales for both the small cards and the larger focus popup).
  _drawOrb(canvasId, solidity, color) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const s = Math.max(0, Math.min(1, solidity || 0));
    const cx = w / 2, cy = h / 2;
    const n = parseInt(color.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const rgba = (a) => `rgba(${r},${g},${b},${a})`;
    const maxR = Math.min(w, h) * 0.42;

    // Halo — wide and faint when gassy, tighter and brighter when solid
    const haloR = maxR * (1.0 + (1 - s) * 0.8);
    const haloA = 0.08 + s * 0.22;
    const halo = ctx.createRadialGradient(cx, cy, maxR * 0.1, cx, cy, haloR);
    halo.addColorStop(0, rgba(haloA));
    halo.addColorStop(0.5, rgba(haloA * 0.4));
    halo.addColorStop(1, rgba(0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

    // Core — emerges from the gas and brightens as it solidifies
    const coreR = maxR * (0.30 + s * 0.55);
    const coreA = 0.12 + s * 0.82;
    const core = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.3, 0, cx, cy, coreR);
    core.addColorStop(0, rgba(Math.min(1, coreA + 0.15)));
    core.addColorStop(0.7, rgba(coreA));
    core.addColorStop(1, rgba(coreA * (0.2 + s * 0.5)));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

    // Rim — only crisp once solid
    if (s > 0.12) {
      ctx.strokeStyle = rgba(0.2 + s * 0.6);
      ctx.lineWidth = (0.5 + s * 1.5) * (window.devicePixelRatio || 1);
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _drawSpectrogram(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;

    // Shift existing content left by 1 column
    const imgData = ctx.getImageData(1, 0, w - 1, h);
    ctx.putImageData(imgData, 0, 0);

    // Draw new column on the right using frequency data
    const fData = this.analyzer.frequencyData;
    if (!fData || fData.length === 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(w - 1, 0, 1, h);
      return;
    }

    // Map frequency bins to vertical pixels (low freq at bottom)
    const binsToShow = Math.min(fData.length, 256); // focus on lower frequencies
    for (let y = 0; y < h; y++) {
      const binIdx = Math.floor(((h - y) / h) * binsToShow);
      const dbVal = fData[binIdx] || -100;
      // Map dB (-100 to 0) to intensity
      const intensity = Math.max(0, Math.min(1, (dbVal + 100) / 80));
      // Warm color map: black → blue → orange → gold
      const r = Math.round(intensity * intensity * 255);
      const g = Math.round(Math.pow(intensity, 3) * 200);
      const b = Math.round(intensity * 180);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(w - 1, y, 1, 1);
    }
  }

  _drawVowelPlot(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();

    // Reference vowel positions (approximate F2, F1 in Hz)
    const vowels = [
      { label: 'EE', f2: 2300, f1: 300 },
      { label: 'AH', f2: 1100, f1: 800 },
      { label: 'OO', f2: 800, f1: 350 },
      { label: 'EH', f2: 1800, f1: 550 },
      { label: 'AW', f2: 900, f1: 600 },
    ];

    // F2 range: 600-2600, F1 range: 200-1000
    const mapF2 = f2 => ((f2 - 600) / 2000) * w;
    const mapF1 = f1 => ((f1 - 200) / 800) * h;

    // Reference labels
    ctx.font = `${8 * devicePixelRatio}px "Space Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    for (const v of vowels) {
      const vx = mapF2(v.f2);
      const vy = mapF1(v.f1);
      ctx.fillText(v.label, vx, vy);
    }

    // Scatter points
    const pts = this._vowelPlotPoints;
    for (let i = 0; i < pts.length; i++) {
      const alpha = 0.2 + (i / pts.length) * 0.6;
      const size = 2 + (i / pts.length) * 2;
      ctx.fillStyle = `rgba(107, 203, 119, ${alpha})`;
      ctx.beginPath();
      ctx.arc(mapF2(pts[i].x), mapF1(pts[i].y), size * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Voice Map (pitch × resonance constellation) ----
  // A 2D view of the session on the pitch(log-Hz, Y) × resonance(X) plane. Design language is
  // the game's, not a lab plot: the live voice is a glowing comet (head vividness = frame
  // confidence, the same trust-aware dimming the ball uses), the session history is a firefly
  // cloud tinted by each moment's own blended score, the dashed ellipse is the ±1 SD "home
  // zone", and the dashed rectangle is the user's own practice zone derived from their
  // pitch/resonance vibration rules. The faint background tint is the app's OWN gender model
  // (computeGenderScore) evaluated across the plane — the same score that drives the ball hue —
  // which also makes the falsetto corner visible: high pitch over dark resonance never turns pink.

  _voiceMapStatsFresh() {
    const t = performance.now() / 1000;
    if (!this._voiceMapStats || t - this._voiceMapStatsAt > 1) {
      this._voiceMapStats = summarizeVoiceCloud(this._voiceMapPoints);
      this._voiceMapStatsAt = t;
    }
    return this._voiceMapStats;
  }

  // format: 'card' keeps the header on one line; 'popup' spells the stats out.
  _voiceMapReadout(format = 'card') {
    const s = this._voiceMapStatsFresh();
    if (!s || s.n < 10) return '—';
    const hz = Math.round(s.medianHz);
    const pct = Math.round(s.medianRes * 100);
    return format === 'popup' ? `med ${hz} Hz · res ${pct}%` : `${hz}Hz·${pct}%`;
  }

  // Ambient perception field behind the map, cached per size + palette. Painted at low
  // resolution and upscaled with smoothing so it reads as a soft glow, not a heat map.
  _voiceMapBackground(w, h, minHz, maxHz) {
    const key = `${w}x${h}:${this.colorblindMode ? 'cb' : 'std'}`;
    const cached = this._voiceMapBgCache.get(key);
    if (cached) return cached;
    const cols = 40, rows = 28;
    const off = document.createElement('canvas');
    off.width = cols; off.height = rows;
    const octx = off.getContext('2d');
    for (let ry = 0; ry < rows; ry++) {
      const yPos = 1 - (ry + 0.5) / rows; // top row = high pitch
      const hz = minHz * Math.pow(maxHz / minHz, yPos);
      for (let cx = 0; cx < cols; cx++) {
        const res = (cx + 0.5) / cols;
        const score = computeGenderScore({ pitchHz: hz, resonance: res, pitchConfidence: 1, formantConfidence: 1 });
        const hue = genderScoreToHue(score, this.colorblindMode);
        // Slightly stronger tint toward the decisive corners, near-neutral in the middle.
        // Large canvases (the focus popup) get a modest boost — the same alpha spread over
        // a big area reads flatter than on the small card.
        const boost = h / (devicePixelRatio || 1) > 160 ? 1.35 : 1;
        octx.fillStyle = `hsla(${hue}, 60%, 45%, ${(0.10 + 0.10 * Math.abs(score - 0.5) * 2) * boost})`;
        octx.fillRect(cx, ry, 1, 1);
      }
    }
    const bg = document.createElement('canvas');
    bg.width = w; bg.height = h;
    const bctx = bg.getContext('2d');
    bctx.imageSmoothingEnabled = true;
    bctx.drawImage(off, 0, 0, w, h);
    // Bound the cache: resizes and palette flips mint new keys; keep only the recent few.
    if (this._voiceMapBgCache.size >= 4) {
      this._voiceMapBgCache.delete(this._voiceMapBgCache.keys().next().value);
    }
    this._voiceMapBgCache.set(key, bg);
    return bg;
  }

  _drawVoiceMap(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c || !c.width) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    const dpr = devicePixelRatio || 1;
    const MIN_HZ = 80, MAX_HZ = 400;
    const TRAIL_SECS = 4;
    // The card and the focus popup share this renderer; the popup earns slightly larger
    // type and the resonance tick percentages that would be clutter at card size.
    const large = h / dpr > 160;
    const fontPx = (large ? 10 : 8) * dpr;
    // Mark sizes scale with the canvas (floored at dpr) so fireflies/comet keep the same
    // visual proportion on the small card and the large focus popup.
    const sz = Math.max(dpr, Math.min(w, h) / 150);
    const X = (res) => clamp01(res) * w;
    const Y = (hz) => (1 - pitchHzToLogPosition(hz, MIN_HZ, MAX_HZ)) * h;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this._voiceMapBackground(w, h, MIN_HZ, MAX_HZ), 0, 0);

    // Log-pitch gridlines + Hz labels (equal vertical steps = equal musical intervals).
    // Labels sit ON the line, right-aligned in a quiet left gutter, so they read as part
    // of the grid instead of floating over the constellation.
    ctx.font = `${fontPx}px "Space Mono", monospace`;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const gutter = 3 * dpr;
    for (const hz of [100, 150, 200, 300]) {
      const y = Y(hz);
      const label = hz === 300 ? '300 Hz' : `${hz}`;
      const tw = ctx.measureText(label).width;
      ctx.beginPath(); ctx.moveTo(gutter * 2 + tw, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillText(label, gutter, y);
    }
    // Resonance axis: ticks plus the app's own dark→bright vocabulary at the corners.
    for (const r of [0.25, 0.5, 0.75]) {
      const x = X(r);
      ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x, h - 4 * dpr); ctx.stroke();
      if (large) {
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.round(r * 100)}`, x, h - 8 * dpr);
      }
    }
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.textAlign = 'left';
    ctx.fillText('← darker', gutter, h - 3 * dpr);
    ctx.textAlign = 'right';
    ctx.fillText('brighter →', w - gutter, h - 3 * dpr);

    // Personal practice zone from the user's own pitch/resonance vibration rules
    // A SUSPENDED rule does not draw a target zone. The zone is the user's own goal read off
    // their alert thresholds, and a threshold whose metric they have not re-confirmed is not a
    // goal on this scale — drawing it would be the silent reinterpretation §3.5 forbids, in
    // pixels instead of haptics.
    const zone = voiceMapZoneFromRules((this.vibration?.rules || []).filter((r) => ruleMayFire(r)));
    if (zone) {
      const x0 = zone.resMin != null ? X(zone.resMin) : 0;
      const x1 = zone.resMax != null ? X(zone.resMax) : w;
      const y0 = zone.pitchMaxHz != null ? Y(zone.pitchMaxHz) : 0;
      const y1 = zone.pitchMinHz != null ? Y(zone.pitchMinHz) : h;
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }

    const pts = this._voiceMapPoints;
    const now = performance.now() / 1000;

    // Firefly cloud — every confident sample this session, each tinted by the score the
    // app read at that moment, so the cloud itself shows how each region was perceived.
    // Additive blending makes dense regions glow brighter instead of smearing into mud,
    // and a slow age fade (full → 30% over ~5 min) keeps recent practice the brightest.
    ctx.globalCompositeOperation = 'lighter';
    for (const p of pts) {
      const ageFade = Math.max(0.3, 1 - (now - p.t) / 300);
      const hue = genderScoreToHue(p.score, this.colorblindMode);
      ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${(0.04 + 0.10 * p.w) * ageFade})`;
      ctx.beginPath();
      ctx.arc(X(p.res), Y(p.hz), 1.1 * sz, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Home zone — mean ±1 SD ellipse of the session cloud (pitch SD in semitones)
    const s = this._voiceMapStatsFresh();
    if (s && s.n >= 20) {
      const stSpan = 12 * Math.log2(MAX_HZ / MIN_HZ); // full map height in semitones
      const rx = Math.max(3 * dpr, s.sdRes * w);
      const ry = Math.max(3 * dpr, (s.sdSemitones / stSpan) * h);
      ctx.beginPath();
      ctx.ellipse(X(s.meanRes), Y(s.meanHz), rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.lineWidth = dpr;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Comet tail — the last few seconds of trajectory, brightening and thickening toward
    // now with an eased falloff (long faint tail, vivid tip). Segments spanning a silence
    // (>0.5 s gap) are not bridged. Additive, so the tail glows where it crosses the cloud.
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = pts.length - 1; i >= 1; i--) {
      const p1 = pts[i], p0 = pts[i - 1];
      const age = now - p1.t;
      if (age > TRAIL_SECS) break;
      if (p1.t - p0.t > 0.5) continue;
      const k = Math.pow(1 - age / TRAIL_SECS, 1.4);
      const hue = genderScoreToHue(p1.score, this.colorblindMode);
      ctx.strokeStyle = `hsla(${hue}, 85%, 65%, ${0.06 + 0.40 * k})`;
      ctx.lineWidth = (0.5 + 2.5 * k) * sz;
      ctx.beginPath();
      ctx.moveTo(X(p0.res), Y(p0.hz));
      ctx.lineTo(X(p1.res), Y(p1.hz));
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Comet head — glowing orb at the live position; vividness = frame confidence, and it
    // fades out over ~1.5 s of silence instead of lingering stale.
    const head = pts.length ? pts[pts.length - 1] : null;
    if (head) {
      const age = now - head.t;
      if (age < 1.5) {
        const fade = 1 - age / 1.5;
        const conf = clamp01(this.analyzer.frameConfidence);
        const hue = genderScoreToHue(head.score, this.colorblindMode);
        const hx = X(head.res), hy = Y(head.hz);
        const r = (4 + 3 * conf) * sz;
        const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 2.4);
        glow.addColorStop(0, `hsla(${hue}, 90%, 72%, ${(0.35 + 0.55 * conf) * fade})`);
        glow.addColorStop(0.55, `hsla(${hue}, 90%, 60%, ${0.18 * fade})`);
        glow.addColorStop(1, `hsla(${hue}, 90%, 55%, 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(hx, hy, r * 2.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `hsla(${hue}, 95%, 78%, ${(0.5 + 0.5 * conf) * fade})`;
        ctx.beginPath(); ctx.arc(hx, hy, r * 0.55, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Empty state
    if (pts.length < 5) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.textAlign = 'center';
      ctx.font = `${Math.round(9 * sz)}px "Space Mono", monospace`;
      ctx.fillText('speak — the map lights up', w / 2, h / 2);
    }
  }

  // Reset the Voice Map for a new speaker: clear this session's cloud/home-zone and drop the
  // per-speaker pitch/tilt/resonance calibration so the next person's map starts blank and
  // recalibrates to their own voice. The room's noise calibration is kept. Gives brief button
  // feedback since it's a one-tap action (no modal — the whole point is fast speaker switching).
  _resetVoiceMapForNewSpeaker(btn) {
    this._voiceMapPoints = [];
    this._voiceMapStats = null;
    this._voiceMapStatsAt = 0;
    this._voiceMapLastPush = 0;
    this.smoothGenderScore = 0.5;
    this.analyzer.resetSpeakerProfiles();

    // Repaint the map + readouts immediately so the reset is visible even before the next frame.
    if (this.metricPopupOpen === 'voicemap') {
      this._renderPopupCanvas('voicemap');
      this._updatePopupValue('voicemap');
    }
    const vmEl = document.getElementById('expValVoiceMap');
    if (vmEl) vmEl.textContent = this._voiceMapReadout();

    if (btn) {
      const original = btn.textContent;
      btn.textContent = '✓ Reset — new speaker, speak to recalibrate';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1600);
    }
  }

  // ---- Metric Popup ----

  _openMetricPopup(metric) {
    this.metricPopupOpen = metric;
    const backdrop = document.getElementById('metricPopupBackdrop');
    const popup = document.getElementById('metricPopup');
    const title = document.getElementById('metricPopupTitle');
    const desc = document.getElementById('metricPopupDesc');
    // Tag the popup so per-metric layout (e.g. the Voice Map's wider frame + tall canvas) applies.
    if (popup) popup.dataset.metric = metric;

    const descriptions = {
      pitch: 'Displays the current fundamental frequency (F0). The color-coded slider shows your position in the pitch range. The line graph shows pitch stability and range over time.',
      resonance: 'Shows a real-time spectrogram tracking formant frequencies (F1, F2). The "Q" value indicates the sharpness of the resonance filter (Harmonic Envelope).',
      bounce: 'A stylized wave graph measuring prosodic inflection or "melody" in speech. Higher values suggest more dynamic pitch variation rather than monotonic delivery.',
      vowels: 'A vowel space plot (F1 vs F2) showing the brightness or darkness of vowel sounds like "EE" and "AH." Tracks resonance shifts during articulation.',
      attack: 'Vocal attack measures onset hardness — how steeply your voice rises into phonation. High = crisp glottal onsets; low = soft, breathy, gradual starts.',
      weight: 'Vocal weight is perceived heaviness from spectral tilt. High = thick, heavy, buzzy tone; low = light, bright, breathy tone.',
      voicemap: 'Height = pitch, left–right = resonance (darker → brighter). The comet is your voice now; fireflies show everywhere it’s been this session, and the dashed ring is your home zone. Set a pitch or resonance alert to add a target box.',
    };

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      vowels: '#6bcb77', attack: '#2ec4b6', weight: '#e06c9f',
      voicemap: '#7fd4ff',
    };

    title.textContent = metric === 'voicemap' ? 'VOICE MAP' : metric.toUpperCase();
    title.style.color = colors[metric] || '#fff';
    desc.textContent = descriptions[metric] || '';

    backdrop.classList.add('show');
    // Allow layout, then size canvas
    requestAnimationFrame(() => this._sizePopupCanvas());
  }

  _closeMetricPopup() {
    this.metricPopupOpen = null;
    const backdrop = document.getElementById('metricPopupBackdrop');
    backdrop.classList.remove('show');
  }

  _updatePopupValue(metric) {
    const el = document.getElementById('metricPopupValue');
    if (!el) return;

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      vowels: '#6bcb77', attack: '#2ec4b6', weight: '#e06c9f',
      voicemap: '#7fd4ff',
    };
    el.style.color = colors[metric] || '#fff';

    switch (metric) {
      case 'pitch': el.textContent = this._pitchReadout(true); break;
      case 'resonance': el.textContent = this._resonanceReadout(true); break;
      // Bounce/Vowels: percentage readouts removed — the chart below is the readout.
      case 'bounce': el.textContent = ''; break;
      case 'vowels': el.textContent = ''; break;
      case 'attack': el.textContent = this._attackReadout(); break;
      case 'weight': el.textContent = this._weightReadout(); break;
      case 'voicemap': el.textContent = this._voiceMapReadout('popup'); break;
    }
  }

  _renderPopupCanvas(metric) {
    const canvasId = 'metricPopupCanvas';
    switch (metric) {
      case 'pitch':
        this._drawLineGraph(canvasId, this._metricHistory.pitch, '#c084fc', 60, 400, true);
        break;
      case 'resonance':
        this._drawSpectrogram(canvasId);
        break;
      case 'bounce':
        this._drawLineGraph(canvasId, this._metricHistory.bounce, '#ff6b6b', 0, 1, false);
        break;
      case 'vowels':
        this._drawVowelPlot(canvasId);
        break;
      case 'attack':
        this._drawOrb(canvasId, this._attackOrb.solidity, '#2ec4b6');
        break;
      case 'weight':
        this._drawOrb(canvasId, this.analyzer.metrics.weight, '#e06c9f');
        break;
      case 'voicemap':
        this._drawVoiceMap(canvasId);
        break;
    }
  }
}

// Initialize if in main UI, export for testing harness
export const game = document.getElementById('app') ? new VoxBallGame() : null;

// Expose the live instance for host integrations (e.g. the Wear OS watch
// shell, which seeds vibration rules and reads alert state). Additive only —
// has no effect on the standalone web app.
if (typeof window !== 'undefined' && game) window.voxGame = game;
if (typeof window !== 'undefined') registerPwa();
