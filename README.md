---
title: Prosody Ball — Voice Training Game
emoji: 🎙
colorFrom: red
colorTo: purple
sdk: static
pinned: false
license: mit
short_description: Control a ball with your voice prosody!
---

# Prosody Ball 🎙

A gamified voice prosody trainer — control a rolling ball with your voice! Practice the 5 rules of expressive prosody:

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

Click **Start Speaking** and allow microphone access. Then speak expressively — the ball responds to your prosody in real time!

**Note:** If microphone access is blocked when viewing the Space on huggingface.co, click the expand button (↗) in the top-right corner of the Space to open it in a full browser tab. The app will also detect this automatically and show an "Open in new tab" link.

## Technical Details

- Pitch detection via autocorrelation on time-domain audio data
- High-frequency bandpass filtering (3kHz+) for consonant/articulation detection
- RMS energy tracking with history buffer for tempo variance analysis
- Energy envelope zero-crossing detection for syllable segmentation
- Sustained voicing duration tracking for vowel elongation measurement
