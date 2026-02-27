---
title: Vox Arcade — Voice Training Game
emoji: 🎙
colorFrom: red
colorTo: purple
sdk: static
app_file: index.html
pinned: false
license: mit
short_description: Control a ball with your voice!
---

# Vox Arcade 🎙

A gamified voice training suite — control a rolling ball with your voice! Practice the 5 rules of expressive prosody:

1. **Bounciness** — Pitch variation controls bounce height
2. **Tempo Variance** — Speech rate changes control ball speed
3. **Vowel Elongation** — Sustained sounds create glowing trails
4. **Articulation** — Crisp consonants create sparkle effects
5. **Syllable Separation** — Distinct syllables trigger individual bounces

## How It Works

- 100% client-side — all audio processing happens locally in your browser
- No data is sent to any server
- Uses Web Audio API for real-time voice analysis
- Autocorrelation-based pitch detection
- Spectral analysis for articulation detection
- Energy envelope tracking for syllable and tempo analysis

## Usage

Click **Start Speaking** and allow microphone access. Then speak expressively — the ball (Vox Ball) responds to your voice in real time!

## Improvement backlog

See [`IMPROVEMENT_SUGGESTIONS.md`](./IMPROVEMENT_SUGGESTIONS.md) for a prioritized list of UX, signal-accuracy, and product iteration ideas.

**Note:** If microphone access is blocked when viewing the Space on huggingface.co, click the expand button (↗) in the top-right corner of the Space to open it in a full browser tab. The app will also detect this automatically and show an "Open in new tab" link.


## Hugging Face Spaces file/folder setup

For a **Static** Hugging Face Space (`sdk: static`), a flat structure works fine:

- Keep `index.html` at the repo root.
- Keep your JS files at the repo root too (for example: `app.js`, `dsp-utils.js`).
- Use relative paths from `index.html` (example: `./app.js` or `app.js`).
- After pushing changes, the Space rebuilds automatically.

## Technical Details

- Pitch detection via autocorrelation on time-domain audio data
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


## Accessibility and device ergonomics

- Added a **Motion** toggle (Auto / Low / Full) to support reduced-animation sessions.
- Added keyboard focus-visible styling improvements for controls and mode cards.
- Added voice profile presets (Auto / Deeper / Lighter / Expressive) to reduce false negatives across voice ranges.

## Test and release confidence

- `npm run test:unit` covers utility/reliability/calibration unit tests.
- `npm run test:audio-fixtures` validates analyzer fixture drift checks.
- `npm run test:browser-matrix` runs smoke checks across real Chrome + Firefox engine runs.
- CI workflow in `.github/workflows/ci.yml` runs quality + fixture + browser smoke jobs on push/PR.


## Reliability accessibility follow-ups

- Added a dedicated **Recover Mic** HUD control (keyboard-accessible) for stream-end and permission-change recovery.
- Added an `aria-live` status region so dynamic calibration/error updates are announced to assistive technologies.
