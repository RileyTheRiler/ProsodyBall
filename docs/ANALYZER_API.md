# Voice Analyzer Internal API Contract

This document defines the stable interface between the DSP analyzer and UI/game modes.

## Analyzer output contract

`VoiceAnalyzer.metrics` emits normalized values in `[0, 1]`:

- `bounce`: pitch-variance expressiveness.
- `tempo`: transition-rate/tempo variation.
- `vowel`: sustained voiced-vowel continuity.
- `articulation`: high-frequency consonant clarity (noise-floor normalized).
- `syllable`: onset impulse for separated syllables.
- `pitch`: user-adaptive pitch position.
- `energy`: adaptive energy position (P50/P90 normalized).
- `resonance`: smoothed resonance/formant-derived signal.
- `snrDb`: smoothed per-frame a-posteriori SNR over the voice band (300–3500 Hz), in dB.
- `snrTier`: coarse noise-trust tier — `'green'` (≥20 dB), `'yellow'` (10–20 dB), `'red'` (<10 dB).
- `snrConfidence`: `[0,1]` trust derived from SNR; drives reliability and (later) UI vividness / haptic gating.

## Confidence contract

Consumers should treat the following analyzer fields as quality indicators:

- `pitchConfidence`
- `formantConfidence`
- `spectralTiltConfidence`
- `snrConfidence` (noise-relative trust; folds into the frame reliability gate)

Frame reliability is computed with `computeFrameReliability()` in `dsp-utils.js`, which now
accepts an optional `snrConfidence` (defaults to `1` = no-op for callers without an SNR
estimate). See `docs/DSP_CONTRACT.md` for the canonical feature-packet definition.

## UI integration rules

- UI/game logic should read metrics only through `analyzer.metrics`.
- Do not re-normalize metrics in mode-specific renderers.
- Feature additions that need raw DSP values should be introduced via explicit analyzer fields and documented here.

## Module boundary (phase 1)

`voice-analyzer-core.js` now owns shared normalization/reliability math.
Future extractions should continue this split:

1. `voice-analyzer-core.js`: pure math + gating helpers.
2. `voice-analyzer-engine.js`: WebAudio capture + frame extraction.
3. `voice-analyzer-state.js`: profile learning and state transitions.
4. UI/game modes consume only the stable contract above.
