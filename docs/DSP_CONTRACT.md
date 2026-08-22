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
   - Resonance: web (`app.js:1089`) and C++ are VTL/dispersion-primary; the Kotlin value
     (`SpectralBrightnessEstimator.kt`) is brightness-primary — a different formula, and
     since Phase 0 it is named `spectralBrightness` rather than resonance so the divergence
     is visible in the code instead of hidden behind a shared word.
   - Formants: web uses downsampled LPC (`app.js:1535`), Kotlin uses full-band LPC
     (`SpectralBrightnessEstimator.kt`, 16 kHz, no downsample), C++ uses harmonic-envelope
     peak-picking (no LPC at all).
   - Tilt: web is A-weighted + mic-baseline-subtracted over pitch-adaptive bands
     (`app.js:886-907`); Kotlin is a plain high/low band ratio
     (`SpectralBrightnessEstimator.kt`).

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
| `resonanceScore` | VTL/dispersion-primary | **not produced** — the native watch engine publishes `spectralBrightness` instead (see below) | VTL/dispersion-primary |
| `mode` | private / public | `DISCREET` / `PRACTICE` (`HapticMode`) | (single mode) |
| output channel | ball hue + opacity, Hue bulb | haptic pattern + intensity | vibration motor + LED |
| norm ranges (Hz→0..1) | UX-tuned | UX-tuned | UX-tuned |

## Per-platform `resonanceScore` today (for reference)

- **Web** (`app.js`, `VoiceAnalyzer.update`): `aVTL` from the uniform-tube ΔF fit →
  `vtlScore`, then `vtlScore*0.55 + f1Score*0.25 + f2Score*0.20`. ΔF is now computed *before*
  the score each frame (it used to lag one frame behind) and seeds on its first usable fit
  rather than climbing from 0, which used to clamp `vtlScore` — the 55% term — to a constant 0
  for the opening seconds of a session. Formants that the estimator has stopped finding are
  aged out (`FORMANT_STALE_FRAMES`) and withheld from the fit rather than passed in frozen at
  their initialisation defaults.
- **C++** (`hardware/*/dsp.h`, `VoxResult.resonance`): same uniform-tube ΔF fit
  (`voxFitFormantDispersion`), golden-tested against the web vectors.
- **Kotlin** (`SpectralBrightnessEstimator.kt`): `0.65*formantScore + 0.35*brightness`,
  `brightness = 0.55*tilt + 0.45*centroidScore` — the pre-D1 brightness-primary formula.
  **It is no longer called resonance.** The value, its flows, its readout, its alert band
  and its haptic vocabulary were all renamed to `spectralBrightness` / `brightness_*`,
  because that is what the formula measures: no ΔF is fitted anywhere on this port. The
  arithmetic is untouched — same inputs, same numbers — so this is a labelling change, not a
  metric change. Two rules follow from it:
  1. Nothing on the watch's native path may be labelled "resonance" while this formula
     stands.
  2. `spectralBrightness` must **not** be pooled with web/firmware `resonanceScore` in
     shared or cross-device session statistics. A session begun on the watch and continued
     on the phone would otherwise average two different measurements and present the
     instrumentation change as a change in the user's voice. No such sharing exists today;
     the constraint is recorded so none is added by accident.
  Adopting D1 here (making the watch actually compute resonance) is Phase 6 of
  `RESONANCE_REDESIGN.md` and still needs the Android toolchain. The persisted DataStore
  keys (`res_low`, `res_high`, `res_display`, `res_method`) deliberately keep their old
  names: they are a storage contract, and renaming them would reset every existing user's
  settings for no gain.

## Decisions (resolved 2026-06-22)

Resolved on the app's goals (gender-perception + prosody voice training; privacy- and
discretion-first), its users (people building muscle memory toward a target voice, often
practicing discreetly in public), and the per-platform hardware. Open to override, but
these are the working calls.

**D1 — Resonance meaning: UNIFY on VTL/dispersion. (was: unify or diverge?)**
The brightness-vs-VTL split is **drift, not design**: the Kotlin estimator's own docstring
used to call it "a compact Kotlin port of the canonical web DSP's resonance stage," and
`MicEngine.kt` is the "no-WebView" native re-port — it was *trying* to mirror web's VTL
stage and diverged. (Phase 0 renamed that file to `SpectralBrightnessEstimator.kt` and
corrected the docstring; the divergence D1 resolves is unchanged.) Three product reasons to unify on VTL/dispersion:
1. It's the metric the app is actually teaching. VTL is the physical correlate of the
   vocal-tract change feminization/masculinization training targets; centroid-brightness is
   a downstream proxy more confounded by mic, loudness (Lombard), and noise.
   *(Amended: this bullet originally justified the choice by saying the code treats
   resonance as "the harder-to-fake gender cue" and weights it above pitch. Both halves are
   unsupported — nothing in the app measures effort or fakery, and F0 is the strongest
   single predictor of perceived gender in the literature, so weighting a formant cue above
   it is not an argument for anything. The remaining reason — VTL is the trained physical
   change, brightness is a confounded proxy — stands on its own. Weights are provisional;
   see `RESONANCE_REDESIGN.md` §2.11 and §3.3.)*
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

**Status: both JS legs landed; the C++ ΔF leg landed.** (1) `dsp-golden.test.mjs` — frozen
input→output vectors for the pure canonical-feature functions (dispersion/VTL, centroid,
femininity cues, gender score, cepstrum/CPP). (2) `tools/run-eval-harness.mjs` — the full
audio→packet pipeline run through the real `VoiceAnalyzer` over the Rainbow Passage, using a
real-FFT mock Web Audio context so the frequency-domain features get real data; asserts golden
ranges on aggregate pitch/F1/F2/SNR/resonance (catches e.g. formants collapsing to defaults).
(3) `hardware/twatch_voxball/test/dsp_host_test.cpp` — the **first cross-port leg**: it asserts
`voxFitFormantDispersion()` against the same five ΔF vectors `dsp-golden.test.mjs` pins on the
JS side, and both now return identical values (1000, 1174.286, 1000, 1000, 0). It compiles the
same translation unit the watch flashes, and already runs in `.github/workflows/twatch-build.yml`.
(4) `resonance-reliability.test.mjs` — drives the real `VoiceAnalyzer` over **synthesized**
vowels whose F1/F2/F3 are known by construction, so the resonance score has a ground truth to
be right or wrong about, at the live frame rate.

**This is the mechanism that caught the semantic drift the doc predicted it would.** The web
and C++ ports were both computing ΔF as the endpoint difference over a *compacted* formant list
(`(last - first) / (count - 1)`), with C++ additionally substituting `F2 - F1` whenever F3 went
missing. Both are the same class of bug: array position was being read as adjacency rather than
as formant number, so a dropped F2 doubled ΔF (halving apparent tract length, pinning resonance
at the feminine rail off one bad frame) and a dropped F3 silently swapped in one of the most
vowel-dependent quantities in the spectrum (F2−F1 is ~2200 Hz on /i/, ~700 Hz on /u/) as a
"vocal-tract length". Constant codegen could not have caught either. Both ports now fit the
uniform-tube series `F_i = (2i-1)·ΔF/2` by least squares through the origin over whichever
formants are present, which agrees with mean-adjacent-spacing on ideal data, degrades correctly
on a dropout, and carries ~4.4× less variance against per-formant error (measured: aVTL standard
error ±1.38 cm → ±0.68 cm at σ=120 Hz per formant).

Still to do: the Kotlin leg (needs the Android toolchain, and D1's VTL unification has not
landed there yet — `SpectralBrightnessEstimator.kt` is still brightness-primary), the
remaining C++ fields beyond ΔF, and per-field tolerance tiers.

### Frame-rate fidelity

The harness now runs **two passes** over the same fixture: the historical non-overlapping
4096-sample walk (93 ms hop) and a `LIVE_GOLDEN` pass at the app's real requestAnimationFrame
hop (~16.7 ms), each with its own ranges. They are different operating points, not a rescaling —
every EMA rate, steady-state tolerance and profile-learning duration in the analyzer is
expressed *per frame*, so at 93 ms they all run 5.6× slower than any user ever sees. Measured
differences on the same audio: formant-gated frames 20% of the pass vs 64%; F1 428 Hz vs 507 Hz;
F2 2107 Hz vs 1764 Hz. At the 93 ms rate the steady-state weight sat pinned at its
`STEADY_WEIGHT_FLOOR`, making it a constant rather than a weighting, the personal
resonance-range learner could never reach its `formantSteadiness > 0.5` gate, and the four
estimators disagreed by 0.63 of the 0–1 scale instead of 0.11. A single-rate harness could not
see any of that.

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

## Measured per-estimator accuracy (web)

Against a synthesized vowel with F1/F2/F3 = 570/1710/2850 Hz (ΔF 1140 Hz, apparent tract
15.35 cm, true resonance score 0.516), at the live frame rate. Recorded and enforced by
`resonance-reliability.test.mjs`:

| estimator | ΔF error | resonance error | note |
|---|---|---|---|
| `lpc` | −0% | −0.3 pts | root-solved; the reference |
| `cepstral` | −1% | −1.7 pts | |
| `centroid` | +2% | +5.0 pts | F1/F2 only — it cannot resolve F3 |
| `harmonic` | −4% | −11.9 pts | envelope sampled at F0 spacing; quantises F2/F3 to the nearest harmonic |

Two things follow. First, `vtlScore` is a **very high-gain** mapping: it spans its whole 0–1
range over ΔF ∈ [1029, 1250] Hz — a 21% band — so a 1% error in ΔF moves the reported score by
about 5 points. Small formant disagreements are amplified into large score disagreements, which
is why the estimators need explicit agreement bounds rather than an assumption of equivalence.
Second, the UI offers all four from one dropdown as if they were interchangeable, and the
`auto` ladder switches between three of them mid-session on room noise. The ladder now has
2 dB of hysteresis so an SNR resting on a tier edge stops re-selecting every frame, and the
four estimators' confidences are calibrated onto one scale (`formantEstimateConfidence`) so
switching estimator no longer silently changes how much the app trusts itself.

## Resonance construct redesign

The measurement *method* documented above (adaptive-ceiling LPC → uniform-tube ΔF fit) is
sound and matches the published recommendation. The *construct* — collapsing one frame's
F1–F3 into a single 0–1 number — is not: measured against Peterson & Barney norms with
ground-truth formants, vowel identity moves the score ~3x more than speaker sex does, and the
nominal 55/25/20 weighting double-counts F1 and F2. See
[`RESONANCE_REDESIGN.md`](./RESONANCE_REDESIGN.md) for the evidence, the target architecture
(tract scale + tract shape, kept separate), and the phased plan. That document supersedes this
one on what `resonanceScore` should mean; this one remains the cross-port contract for how it
is computed and kept in step.

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
- **Kotlin has not adopted D1.** `SpectralBrightnessEstimator.kt` is still brightness-primary
  while web and C++ are both on the uniform-tube ΔF fit, so the watch's 50% is a different
  vocal target from the ball's 50%. The value is now *named* for what it measures rather than
  for what the app wishes it measured, which removes the silent miscoaching but not the
  divergence. Unifying the measurement is the highest-value remaining port item; it needs the
  Android toolchain to verify.
- **`harmonic` carries a −11.9 point bias** (see the accuracy table above) and the UI offers it
  in the same dropdown as `lpc`, which is accurate to −0.3 points. Either the dropdown should
  say so or `harmonic` should stop being offered as a peer. It is not reachable from `auto`.
- **The personal resonance-range learner is method-dependent.** Its conjunction of four gates
  (`conf > 0.4`, `formantSteadiness > 0.5`, `vowelLikelihood > 0.4`, non-zero ΔF) is reached
  under `lpc`/`cepstral`/`centroid` but not under `harmonic` on the Rainbow Passage, so whether
  a user ever gets a personal 0–100% span depends on which estimator the room's SNR selected.
  It also changes what the score *means* mid-session (population anchors → the speaker's own
  span) without recording which scale a stored reading was taken on, so session summaries can
  average across two different scales.
- **`vtlScore` is a high-gain mapping**: full 0–1 travel over ΔF ∈ [1029, 1250] Hz, ~5 score
  points per 1% of ΔF error. That is a deliberate consequence of the 17 cm → 14 cm apparent
  tract-length anchors (**longer/darker → shorter/brighter**, not male → female: F0 and
  formants overlap substantially between gender groups, and ASHA is explicit that there is no
  single acoustic definition of voice feminization), but it means pre-calibration readings
  carry a wide confidence interval that the meter does not currently draw.
