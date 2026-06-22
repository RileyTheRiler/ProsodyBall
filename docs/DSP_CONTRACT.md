# Cross-Platform DSP Feature Contract (DRAFT)

**Status: proposal / not implemented.** Nothing here changes runtime behavior. This is
the design contract that must be ratified *before* anyone writes `dsp-constants.json`,
adds per-frame SNR, or touches DSP code. It exists so the **canonical-vs-presentation
boundary** is settled first — otherwise the "shared" packet ends up with a platform-
divergent score baked in, and the golden tests can't assert on it.

Platforms in scope:

- **Web** — `app.js` / `dsp-utils.js` (desktop **and** mobile; `phone.html` is just a
  PeerJS mic relay, same engine).
- **Wear OS** — `wear/app/.../*.kt` (Kotlin).
- **Hardware** — `hardware/prosody_necklace/` and `hardware/twatch_voxball/` (C++).

## Why this exists

The three ports already diverge in two different ways, and they need different fixes:

1. **Numeric drift** (constants that should match but might not). Fixed by a single
   source of truth + codegen. `check-conflicts.mjs` only finds git merge markers, and
   the C++ headers pin values with comments like `// app.js:20` (`hardware/.../dsp.h`)
   that rot on any edit.
2. **Semantic drift** (the *same field computed by a different formula*). **Codegen of
   constants does not catch this.** Only golden-value cross-port tests do. Today:
   - Resonance: web (`app.js:1089`) and C++ are VTL/dispersion-primary; Kotlin
     (`ResonanceEstimator.kt:142`) is brightness-primary — a different formula.
   - Formants: web uses downsampled LPC (`app.js:1535`), Kotlin uses full-band LPC
     (`ResonanceEstimator.kt`, 16 kHz, no downsample), C++ uses harmonic-envelope
     peak-picking (no LPC at all).
   - Tilt: web is A-weighted + mic-baseline-subtracted over pitch-adaptive bands
     (`app.js:886-907`); Kotlin is a plain high/low band ratio (`ResonanceEstimator.kt:107`).

A flat "canonical packet with `resonanceScore` in it" cannot resolve #2, because the
score is *meant* to differ on the watch. The fix is two layers.

## The two layers

### Layer A — Canonical feature packet (identical math, golden-tested)

One struct per analysis frame. For the **same input samples**, every platform must
produce the **same values within a documented per-field tolerance**. This is the only
thing golden cross-port tests assert on. Raw, device/UX-neutral.

| field | unit | canonical definition (proposed) | current state → reconciliation |
|---|---|---|---|
| `t` | s | frame start time | n/a |
| `f0Hz` | Hz | YIN, `YIN_THRESHOLD=0.15`, 0 when unvoiced | already shared (C++ `config.h`, web `app.js`) |
| `voicingConfidence` | 0..1 | YIN CMND → conf, `PITCH_CONFIDENCE_FACTOR=3.0` | shared |
| `f1Hz`,`f2Hz`,`f3Hz` | Hz | from the **canonical extractor** — see **D2** | web/Kotlin/C++ use 3 different extractors today |
| `centroidHz` | Hz | magnitude-weighted spectral centroid over **[120, 5000] Hz** | web/Kotlin/C++ all compute it; band edges agree (C++ `VOX_BRIGHT_LO/HI_HZ`) — confirm web matches |
| `tiltDb` | dB | `10·log10(E_high / E_low)`, **fixed** bands, **raw** (no A-weight, no mic baseline) — see **D3** | web uses A-weighted, baseline-subtracted, pitch-adaptive bands |
| `snrDb` | dB | `10·log10(E_band / E_noiseProfile)`, a-posteriori, against the *slowly-updated* noise profile | **does not exist anywhere yet** |
| `noiseFloor` | RMS | scalar gated-RMS floor | exists (`app.js:186`); C++ `_noiseFloor` |
| `confidence` | 0..1 | `combine(voicingConf, formantConf, tiltConf, voicedStrength, snrTerm)` | exists *without* the snr term (`dsp-utils.js:101`); **add snr** |

Notes:

- `centroidHz` is canonical in **Hz**. The 0..1 *normalization range* that maps it for
  display (Kotlin 700–2200, C++ 400–2200) is **presentation** (Layer B), not canonical.
- `snrDb` is the keystone new field. It must read the noise profile *after* the
  pause-based update lands, so the contract and the noise-stage work ship together.

### Layer B — Platform presentation (intentionally divergent, tested per-platform)

These are allowed to differ by platform and UX. Golden tests assert them **per platform**,
not across platforms.

| field | web | Wear OS | hardware |
|---|---|---|---|
| `resonanceScore` | VTL/dispersion-primary (see **D1**) | brightness-primary *or* unified (see **D1**) | VTL/dispersion-primary |
| `mode` | private / public | `DISCREET` / `PRACTICE` (`HapticMode`) | (single mode) |
| output channel | ball hue + opacity, Hue bulb | haptic pattern + intensity | vibration motor + LED |
| norm ranges (Hz→0..1) | UX-tuned | UX-tuned | UX-tuned |

## Per-platform `resonanceScore` today (for reference)

- **Web** (`app.js:1080-1089`): `aVTL` from formant dispersion → `vtlScore`, then
  `vtlScore*0.55 + f1Score*0.25 + f2Score*0.20`.
- **C++** (`hardware/*/dsp.h`, `VoxResult.resonance`): dispersion/VTL-based.
- **Kotlin** (`ResonanceEstimator.kt:142`): `0.65*formantScore + 0.35*brightness`,
  `brightness = 0.55*tilt + 0.45*centroidScore`.

## Open decisions (need your ratification — recommendations included)

**D1 — Resonance *meaning*: unify, or diverge on purpose?** This is a product/UX call,
not a code call, which is why it's yours.
*Recommendation:* make **VTL/dispersion the canonical resonance meaning** (it's the
physical correlate of vocal-tract length, the original design guide argued for it, and
2 of 3 platforms already use it — Kotlin is the lone outlier). Keep Kotlin's
brightness formula available only as an optional *display* alternative, not the default.
This makes `resonanceScore` golden-testable cross-platform instead of divergent-by-design.

**D2 — Canonical formant extractor.**
*Recommendation:* **downsampled LPC** (web's Praat-style path, `app.js:1535`) is canonical.
Kotlin downsamples to the same band to match. C++ harmonic-envelope is documented as an
**approximation tier with a wider golden tolerance** until/unless it gets an LPC port
(the necklace README already calls full formant tracking "on the roadmap").

**D3 — `tiltDb` definition.**
*Recommendation:* canonical `tiltDb` = **raw fixed-band ratio** (proposed low `[80,1200]`,
high `[2500,5000]` Hz), no A-weighting, no mic-baseline. A-weighting and mic-baseline are
per-device *calibration*; web's pitch-adaptive, baseline-subtracted tilt stays as a
separate **presentation** signal feeding the *weight/heaviness* axis (which is what it
already drives), not the canonical feature.

**D4 — Confidence gate threshold(s).** The `0.45` haptic gate is duplicated three times in
one file (`MainActivity.kt:155, 182, 192`) and there's an analogous gate on web.
*Recommendation:* promote to a single named constant in the spec; same value drives web
ball vividness tiers and watch haptic tiers.

## Golden-test contract

The existing fixture (`fixtures/audio-eval/reference-frames.json`) feeds **pre-computed
confidence scalars** and asserts **gating** outputs — it does *not* go from audio to
features. Extending it is genuinely new work:

1. Input = committed audio vectors (synthetic vowels + the Rainbow Passage clip already in
   `fixtures/audio-eval/`).
2. Expected = the full **Layer A** packet per frame.
3. Run the same vectors through web (existing harness), Kotlin, and C++; assert each field
   within tolerance.
4. **Tolerance tiers:** tight for web↔Kotlin (both float, both LPC once D2 lands); **wider
   for C++** (harmonic-envelope approximation; possible fixed-point on ESP32). Record the
   intended tolerance per field in the spec.

This is the mechanism that actually fences semantic drift. Constant codegen alone does not.

## Constants that graduate to `dsp-constants.json` (only after this is ratified)

Per-platform table, not a flat file (sample rate and LPC order legitimately differ):

- analysis sample rate (per platform), LPC order + downsample target band
- formant band edges + bandwidth-rejection cutoff
- `tiltDb` bands; `centroidHz` band
- SNR tier thresholds (green/yellow/red), noise-profile update rate + pause threshold
- confidence combination weights + the `0.45` gate (D4)
- resonance normalization ranges (Layer B, per platform)

Generate: web constants, Kotlin `object DspConstants`, C++ `constexpr` header. CI diffs the
generated outputs.

## Sequencing this unblocks

1. Ratify D1–D4 (this doc).
2. Thin spec slice: just the Layer A packet shape + the constants touched in step 3 —
   co-evolved with the prototype, not a big upfront freeze.
3. Web noise slice, all in one pass on the same code: per-frame `snrDb` +
   pause-based noise-profile refresh + **SNR-adaptive oversubtraction** (replaces the
   hardcoded `1.5` at `app.js:869, 1024`). Fallback for the no-pause case (continuous
   speech / a never-silent car): minimum-statistics tracking, documented as v2.
4. Feed `snrDb` into `confidence`; surface as green/yellow/red.
5. Wearable: the haptic gate already exists (`MainActivity.kt:182,192`) — make it
   **SNR-fed and graded** (high→clear, medium→soft, low→suppress + optional neutral
   "uncertain" tap), composed with the existing `DISCREET`/`PRACTICE` mode. Not a new gate.
6. Align Kotlin/C++ extractor bands to the canonical one (D2).
7. Golden-value cross-port tests (extend the fixture above).

## Known drift to clean up (tracked here, not fixed yet)

- `docs/ANALYZER_API.md` references `voice-analyzer-core.js` (does not exist);
  `computeFrameReliability()` actually lives in `dsp-utils.js:101`.
- `0.45` confidence gate duplicated (`MainActivity.kt:155, 182, 192`).
- Oversubtraction `1.5` hardcoded (`app.js:869, 1024`).
- `start()` capture fallback defaults browser processing **on**
  (`inputOptions.echoCancellation !== false`, `app.js:246-248`) — contradicts the
  constructor default of off.
- Centroid normalization ranges differ (Kotlin 700–2200 vs C++ 400–2200) — fine as
  presentation, but should be explicit in the spec.
