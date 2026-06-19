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

## Confidence contract

Consumers should treat the following analyzer fields as quality indicators:

- `pitchConfidence`
- `formantConfidence`
- `spectralTiltConfidence`

Frame reliability is computed with `computeFrameReliability()` in `dsp-utils.js`.

## UI integration rules

- UI/game logic should read metrics only through `analyzer.metrics`.
- Do not re-normalize metrics in mode-specific renderers.
- Feature additions that need raw DSP values should be introduced via explicit analyzer fields and documented here.

## Module boundary

`dsp-utils.js` owns the shared, pure normalization/reliability/gender math
(`computeFrameReliability`, `normalizeAgainstPercentiles`, `computeGenderScore`,
etc.) and is unit-tested directly (`dsp-utils.test.mjs`,
`voice-analyzer-core.test.mjs`). The live `VoiceAnalyzer` (WebAudio capture,
frame extraction, profile learning, and state) currently lives in `app.js` and
consumes those helpers.

A future refactor could extract the analyzer out of `app.js` into dedicated
modules, continuing the split:

1. `dsp-utils.js`: pure math + gating helpers (exists today).
2. `voice-analyzer-engine.js`: WebAudio capture + frame extraction.
3. `voice-analyzer-state.js`: profile learning and state transitions.
4. UI/game modes consume only the stable contract above.
