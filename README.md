# Vox Ball 🎙

A gamified voice training game — train pitch, resonance, articulation, and prosody through real-time voice control of a bouncing ball. **Vox Ball** (aka the Prosody Bowl) teaches the 5 rules of expressive prosody:

1. **Bounciness** — Pitch variation controls bounce height
2. **Tempo Variance** — Speech rate changes control ball speed
3. **Vowel Elongation** — Sustained sounds create glowing trails
4. **Articulation** — Crisp consonants create sparkle effects
5. **Syllable Separation** — Distinct syllables trigger individual bounces

## How It Works

- 100% client-side — all audio processing happens locally in your browser
- No data is sent to any server
- Uses Web Audio API for real-time voice analysis
- Worker-backed YIN pitch detection with a main-thread fallback
- Spectral analysis for articulation detection
- Energy envelope tracking for syllable and tempo analysis

## Usage

Click **Start Speaking** and allow microphone access. Then speak expressively — Vox Ball responds to your voice in real time!

## Improvement backlog

See [`IMPROVEMENT_SUGGESTIONS.md`](./IMPROVEMENT_SUGGESTIONS.md) for a prioritized list of UX, signal-accuracy, and product iteration ideas.

## Technical Details

- Pitch detection via YIN analysis on time-domain audio data
- High-frequency bandpass filtering (3kHz+) for consonant/articulation detection
- RMS energy tracking with history buffer for tempo variance analysis
- Energy envelope zero-crossing detection for syllable segmentation
- Sustained voicing duration tracking for vowel elongation measurement

## Analyzer architecture notes

- Shared analyzer normalization and reliability gating helpers now live in `voice-analyzer-core.js`.
- Internal analyzer/UI contract is documented in [`docs/ANALYZER_API.md`](./docs/ANALYZER_API.md).

## Regression harness

- Run `npm run test:audio-fixtures` to validate reference analyzer frame fixtures.
- Run `npm run test:all` for unit tests + fixture drift checks.
- `npm run test:eval-pipeline` runs the full audio→features pipeline over the Rainbow Passage
  at **two frame rates**: the historical 93 ms chunked walk and the app's real
  requestAnimationFrame hop. They are different operating points — every EMA rate and
  steady-state tolerance in the analyzer is per frame — so both are asserted.

### Resonance validity and reliability

`resonance-reliability.test.mjs` drives the real analyzer over **synthesized** vowels whose
F1/F2/F3 are known by construction, so the resonance score has a ground truth rather than a
frozen previous output to be checked against. It pins:

- **Validity** — resonance rises monotonically with vocal-tract shortening; measured ΔF
  recovers the synthesized tract length within 15%; each estimator lands within its recorded
  bias of the hand-computed true score; changing F0 does not move the score (resonance is a
  filter property, which is the whole reason it outranks pitch in the gender blend).
- **Reliability** — the four estimators agree within 0.20 of the 0–1 scale (0.12 for the three
  the SNR ladder can auto-select); every estimator clears the confidence gates that admit a
  frame to the readout; identical input gives byte-identical output; a held vowel reads steady.

See [`docs/DSP_CONTRACT.md`](./docs/DSP_CONTRACT.md) for the measured per-estimator accuracy
table and the cross-port golden-vector status.


## Accessibility and device ergonomics

- Added a **Motion** toggle (Auto / Low / Full) to support reduced-animation sessions.
- Added keyboard focus-visible styling improvements for controls.
- Added voice profile presets (Auto / Deeper / Lighter / Expressive) to reduce false negatives across voice ranges.

## Test and release confidence

- `npm run test:unit` covers utility/reliability/calibration unit tests.
- `npm run test:audio-fixtures` validates analyzer fixture drift checks.
- `npm run test:browser-matrix` runs smoke checks across real Chrome + Firefox engine runs.
- CI workflow in `.github/workflows/ci.yml` runs quality + fixture + browser smoke jobs on push/PR.


## Reliability accessibility follow-ups

- Added a dedicated **Recover Mic** HUD control (keyboard-accessible) for stream-end and permission-change recovery.
- Added an `aria-live` status region so dynamic calibration/error updates are announced to assistive technologies.
