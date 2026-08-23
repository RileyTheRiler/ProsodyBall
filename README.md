# Vox Ball 🎙

A gamified voice training game — train pitch, resonance, articulation, and prosody through real-time voice control of a bouncing ball. **Vox Ball** (aka the Prosody Bowl) teaches the 5 rules of expressive prosody:

1. **Bounciness** — Pitch variation controls bounce height
2. **Tempo Variance** — Speech rate changes control ball speed
3. **Vowel Elongation** — Sustained sounds create glowing trails
4. **Articulation** — Crisp consonants create sparkle effects
5. **Syllable Separation** — Distinct syllables trigger individual bounces

## How It Works

- Voice analysis happens locally in your browser; microphone recordings are not uploaded for analysis
- Recording clips stay in memory for the current tab: 10 minutes per clip, up to 20 clips or
  256 MiB total. Download a clip before deleting it or closing/reloading the tab.
- Optional phone relay sends audio peer-to-peer and uses PeerJS signaling; third-party fonts and scripts make normal asset requests
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

- Shared analyzer normalization and reliability gating helpers live in `dsp-utils.js`.
- Internal analyzer/UI contract is documented in [`docs/ANALYZER_API.md`](./docs/ANALYZER_API.md).
- Recording ownership, limits, and cleanup are documented in
  [`docs/RECORDING_LIFECYCLE.md`](./docs/RECORDING_LIFECYCLE.md).

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
  bias of the hand-computed true score; under controlled F0 manipulation on these synthetic
  vowels, changing F0 does not move the score.
- **Reliability** — the four estimators agree within 0.20 of the 0–1 scale (0.12 for the three
  the SNR ladder can auto-select); every estimator clears the confidence gates that admit a
  frame to the readout; identical input gives byte-identical output; a held vowel reads steady.

**What the F0 result does and does not say.** The score is *designed* to measure the filter
independently of the source, and on synthetic vowels with a fixed tract it is close to
invariant across 110–220 Hz. That is not the same as F0-independence in real speech: LPC
formant estimation carries a known F0-dependent error — with sparse harmonic sampling the
poles are drawn toward individual harmonics rather than the underlying resonance ("harmonic
attraction"), and the error grows as F0 rises, which is worst exactly in the range
transfeminine users train into. F0 belongs in the confidence model rather than being claimed
away.

**What the resonance score is not.** It is a 0–1 position between a longer/darker and a
shorter/brighter vocal tract, not a measure of effort or strain — nothing in the signal chain
measures phonatory effort — and not a verdict about gender: F0 and formants overlap
substantially between gender groups, and ASHA is explicit that there is no single acoustic
definition of voice feminization. Vowel identity also moves the current score about three
times more than speaker sex does; see
[`docs/RESONANCE_REDESIGN.md`](./docs/RESONANCE_REDESIGN.md) for the evidence and the plan.

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
