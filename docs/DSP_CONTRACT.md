# Cross-Platform DSP Feature Contract (DRAFT)

**Status: proposal / not implemented.** Nothing here changes runtime behavior. This is
the design contract that must be ratified *before* anyone writes `dsp-constants.json`,
adds per-frame SNR, or touches DSP code. It exists so the **canonical-vs-presentation
boundary** is settled first — otherwise the "shared" packet ends up with a platform-
divergent score baked in, and the golden tests can't assert on it.

Decisions **D1–D4 are resolved** (see [Decisions](#decisions-resolved-2026-06-22)) on the
product's goals/users/hardware; they remain open to override.

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
- **Steady-state weighting** (web-first; `steadyStateWeight` in `dsp-utils.js`): within a
  voiced segment, each frame's live resonance update is scaled by a `[STEADY_WEIGHT_FLOOR..1]`
  weight derived from short-window pitch deviation (`STEADY_PITCH_ST`) and frame-to-frame
  `|dF1|/F1 + |dF2|/F2` (`STEADY_FORMANT_REL_DELTA`). Held-vowel targets dominate the score
  over onset/offset/coarticulation frames. The constants are in the shared spec so the Kotlin/
  C++ ports can adopt it; the wiring is web-only today.
- **SNR-driven method selection** (web-first; `selectResonanceMethod`): the `'auto'` resonance
  method resolves per-frame to `lpc` (≥`SNR_GREEN_DB`), `cepstral` (≥`SNR_YELLOW_DB`), or
  `centroid` (below) from the smoothed SNR, since the four extractors degrade differently in
  noise. Which extractor is canonical for `f1Hz/f2Hz/f3Hz` cross-port is still open (**D2**);
  `'auto'` is a web-side selection over web's four methods, not a change to that decision.

### Layer B — Platform presentation (intentionally divergent, tested per-platform)

These are allowed to differ by platform and UX. Golden tests assert them **per platform**,
not across platforms.

| field | web | Wear OS | hardware |
|---|---|---|---|
| `resonanceScore` | VTL/dispersion-primary | VTL/dispersion (unified per **D1**); brightness = optional display only | VTL/dispersion-primary |
| `mode` | private / public | `DISCREET` / `PRACTICE` (`HapticMode`) | (single mode) |
| output channel | ball hue + opacity, Hue bulb | haptic pattern + intensity | vibration motor + LED |
| norm ranges (Hz→0..1) | UX-tuned | UX-tuned | UX-tuned |

## Per-platform `resonanceScore` today (for reference)

- **Web** (`app.js:1080-1089`): `aVTL` from formant dispersion → `vtlScore`, then
  `vtlScore*0.55 + f1Score*0.25 + f2Score*0.20`.
- **C++** (`hardware/*/dsp.h`, `VoxResult.resonance`): dispersion/VTL-based.
- **Kotlin** (`ResonanceEstimator.kt:142`): `0.65*formantScore + 0.35*brightness`,
  `brightness = 0.55*tilt + 0.45*centroidScore`.

## Decisions (resolved 2026-06-22)

Resolved on the app's goals (gender-perception + prosody voice training; privacy- and
discretion-first), its users (people building muscle memory toward a target voice, often
practicing discreetly in public), and the per-platform hardware. Open to override, but
these are the working calls.

**D1 — Resonance meaning: UNIFY on VTL/dispersion. (was: unify or diverge?)**
The brightness-vs-VTL split is **drift, not design**: `ResonanceEstimator.kt`'s own
docstring calls it "a compact Kotlin port of the canonical web DSP's resonance stage,"
and `MicEngine.kt:12` is the "no-WebView" native re-port — it was *trying* to mirror web's
VTL stage and diverged. Three product reasons to unify on VTL/dispersion:
1. It's the metric the app is actually teaching. The code itself treats resonance
   (formants/VTL) as "the harder-to-fake gender cue" and weights it above pitch in the
   gender score. VTL is the physical correlate of the vocal-tract change feminization/
   masculinization training targets; centroid-brightness is a downstream proxy more
   confounded by mic, loudness (Lombard), and noise.
2. Cross-surface consistency is load-bearing *for this product*. A user learns a target
   on desktop (ball + bulb) then practices on the watch/necklace. If "resonance 50%" means
   VTL on desktop but brightness on the watch, the haptics fire at a different vocal target
   than the ball taught — actively miscoaching. The necklace default "resonance 30–70%"
   range is meaningless if the scale differs per device.
3. It makes `resonanceScore` golden-testable cross-platform instead of divergent-by-design.

Brightness stays available only as an optional *secondary display*, never as the gate that
fires haptics. The low-SNR body-worn case (necklace in a car) is handled by the SNR/
confidence gate suppressing feedback — **not** by silently switching to a brightness number
that's computable from noise but wrong (the exact trap the trust-aware design avoids).

**D2 — Canonical formant extractor: downsampled LPC, defined by band ceiling + pole
density (not a hard 11 kHz).** Web's root-solved, bandwidth-rejected downsampled LPC
(`app.js:1535`) is the reference. Canonical quantities = **analysis ceiling ≈5–5.5 kHz**
and **pole-pairs-per-kHz**; each platform reaches them by an integer decimation natural to
its rate (web 48k÷4≈12k; watch 16k÷2=8k with order trimmed) — don't force an awkward 16→11k
resample on an MCU/watch. The watch native port currently runs full-band 16 kHz LPC order
14, wasting ~1 pole pair on the 5.5–8 kHz junk band (the spurious-pole-in-noise risk);
band-limiting fixes that. The ESP32 necklace uses harmonic-envelope today; it stays a
**documented approximation tier with wider golden tolerance** (it drives haptics/LED, not a
numeric readout, so wider tolerance is acceptable) until the LPC port lands ("on the
roadmap" per its README).

**D3 — `tiltDb` canonical = raw fixed-band ratio; calibrated tilt is the weight axis.**
Canonical `tiltDb` = `10·log10(E_high/E_low)` over fixed bands (proposed low `[80,1200]`,
high `[2500,5000]` Hz), no A-weighting, no mic-baseline — device-neutral and golden-
testable on synthetic tones. Web's A-weighted, baseline-subtracted, pitch-adaptive tilt
stays platform-side feeding the **weight/heaviness** axis (the bulb's "Weight Body" byte,
H1–H2), which legitimately wants per-device calibration. Low disruption because, post-D1,
tilt is off the gender-resonance critical path.

**D4 — One named confidence gate; reconcile the existing split.** There are already two
near-duplicate magic numbers for "voiced/confident enough": `MicEngine.kt:177`
(`pitch.confidence > 0.4f`, gates the resonance *update*) and `MainActivity.kt:155,182,192`
(`> 0.45f`, gates *firing a haptic*), plus web's `reliableFrame`. Promote to **two named
constants** — `UPDATE_CONF_GATE` and `ALERT_CONF_GATE` (the fire gate can stay stricter) —
shared across platforms and, once SNR exists (D1), fed by the SNR-inclusive confidence so
the same threshold drives web ball vividness and watch haptic tiers.

## Golden-test contract

**Status: both JS legs landed.** (1) `dsp-golden.test.mjs` — frozen input→output vectors
for the pure canonical-feature functions (dispersion/VTL, centroid, femininity cues, gender
score, cepstrum/CPP). (2) `tools/run-eval-harness.mjs` — the full audio→packet pipeline run
through the real `VoiceAnalyzer` over the Rainbow Passage, using a real-FFT mock Web Audio
context so the frequency-domain features get real data; asserts golden ranges on aggregate
pitch/F1/F2/SNR/resonance (catches e.g. formants collapsing to defaults). Both run in
`test:all`/CI. Still to do: the Kotlin/C++ legs that run the same vectors through those ports
(needs the native toolchains), and per-field tolerance tiers for them.

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

## Constants that graduate to `dsp-constants.json`

**Status: scaffolded.** `dsp-constants.json` + `tools/gen-dsp-constants.mjs` now codegen
`dsp-constants.generated.js`, `wear/.../DspConstants.kt`, and
`hardware/dsp_constants_generated.h`. `npm run check:constants` (in `test:all`/CI) fails on
drift. `dsp-utils.js` consumes the generated JS. v1 covers the SNR/noise/confidence/tilt/
centroid constants + the D4 gates; the JS consumer is wired, Kotlin/C++ adoption (replacing
hand-maintained values; removing the colliding `#define`s first) is the mechanical follow-up.

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
5. Wearable: **done (review-only; no Android toolchain here to compile).** `MicEngine`
   now computes a per-frame broadband SNR vs the calibrated floor; the `MainActivity`
   alert loop gates on the SNR tier (red → silent, don't miscoach) and steps the haptic
   intensity down one notch in yellow, using `DspConstants` (`ALERT_CONF_GATE`, SNR edges).
   Composed with the existing `DISCREET`/`PRACTICE` mode. Follow-ups: band-limited SNR
   (today it's broadband rms/floor, the web's fallback formula) and a screen tier indicator.
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
