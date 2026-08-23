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
  C++ ports can adopt it; the wiring is web-only today. Since Phase 2 of
  `RESONANCE_REDESIGN.md` this is one of **two** aggregation modes rather than the only one:
  it is *exercise* mode, where duration is the point, and it is what the ball reads. *Speech*
  mode (`aggregateSpeech`) takes one value per vowel nucleus with nuclei weighted equally, so a
  four-second hold counts once, like the 80 ms /ɪ/ in "the rain"; session statistics read that.
  Both are Layer B presentation choices over the same Layer A frames, not two measurements —
  which is why they are computed from one stream by one `ResonanceAggregator` and asserted to
  agree with the array forms.
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
be right or wrong about, at the live frame rate. (5) `resonance-dprime.test.mjs` +
`fixtures/peterson-barney-1952.json` — the construct-validity net, added with Phase 1 of
`RESONANCE_REDESIGN.md`: Peterson & Barney adult male and female mean formants fed straight
into the scoring functions (no estimator, no noise, no smoothing) and reduced to
d′ = (female mean − male mean) / pooled within-sex across-vowel SD. It pins v1 at both ends —
the §1.1 per-vowel table *and* d′ = 0.858 — so "the displayed metric did not move" is asserted
rather than asserted-about, and states v2's criteria as inequalities against the redesign's
thresholds. `npm run test:resonance-yield` is its companion reliability net: v2's formant
yield on the Rainbow Passage must not fall below v1's under any of the four estimators, and
since Phase 2 it also reports how often the vowel is named and `f2Position` therefore exists
(88.0% of estimator frames under `lpc`, 81.5% cepstral, 74.5% harmonic, 0% centroid — which
resolves no F3 and so cannot reach the two residual dimensions a classification needs).
(6) `tools/resonance-aggregation.mjs` (`npm run test:resonance-aggregation`) — the Phase 2
aggregation-mode net. It builds a hold-plus-speech clip in source (a synthesized sustained vowel
from `tools/synth-vowel.mjs` concatenated with the Rainbow Passage) and asserts that **exercise**
and **speech** aggregation weight the hold differently by at least 5× and land on measurably
different numbers. It also asserts the vowel is named on ≥80% of the sustained hold's frames,
which guards the specific regression that was there: a classifier calibrated to connected speech
abstains through an entire held vowel, and a held vowel is the mode the ball runs in.
(7) `resonance-aggregation.test.mjs` — the same two modes as pure arithmetic, including that the
streaming aggregator a live session uses and the array functions a fixture report uses produce
identical numbers on the same stream.
(8) `resonance-estimator-discipline.test.mjs` + four reporting tools, added with Phase 3. The
test pins the things that must hold exactly: the canonical v2 value is **frame-by-frame
identical under all four `resonanceMethod` settings** (an equality, not a tolerance — the
canonical path has no branch for the estimator identity to take); the ceiling-parameterised LPC
is byte-identical to the pre-Phase-3 decimation at the default 5512.5 Hz, which is what lets a
per-user ceiling exist without moving v1; a calibrated ceiling does not reach v1 at all; and
below the floor every v2 output is *cleared* rather than frozen. The tools produce numbers that
have to be read and enforce explicit criteria. `estimator-discipline` and `lpc-ceiling` run
strictly in `test:all`; frame validity and live rhotic handling currently run through named
quarantines, while their raw `--check` commands fail and CI runs those strict commands as
visible non-blocking steps:
`tools/estimator-discipline.mjs` (between-estimator spread, LPC solves per frame against §3.4's
budget, suppression rate at both of the repo's "live" hop sizes),
`tools/frame-validity.mjs` (per-gate detection plus post-gate and live-output precision, accurate
recall, wrong-output rate, abstention, gate false-positive rate, and every vowel/F0 subgroup on
labelled synthetic frames;
the Rainbow Passage still has no labels and is therefore cost-only), `tools/lpc-ceiling.mjs`
(per-user ceiling vs the fixed default over four tract scales ×
F0 100–300 Hz × three SNRs, calibrated and scored on disjoint vowel sets), and
`tools/rho-rhotic.mjs` (whether ρ is usable for /ɝ/ — on the norms and through the live path,
which give opposite answers).

**A frame-rate caution these tools made concrete.** `fixtures/audio-eval/rainbow_passage.wav` is
**22.05 kHz**, so the 735-sample hop the reporting tools call "the live rate" — correct at
44.1 kHz — is 33 ms on it, i.e. 30 fps rather than 60. Every Phase 1 and Phase 2 yield number on
that fixture is at 30 fps. Phase 3's suppression figures are reported at both rates for
comparability, and the frame validity gates take the caller's own frame interval rather than
assuming one, so a bound stated as a velocity means the same thing at either.

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

**These are measured on a SUSTAINED SYNTHETIC VOWEL with clean, well-separated formants, and
they understate the disagreement on real material by several times.** Measured on the Rainbow
Passage at the live frame rate, with the biases above already divided out and the comparison
masked to the formants both estimators produced: the cepstral estimator's **F3 differs from
root-solved LPC's by a median 25.6%** (F1 and F2 by ~8%), and the pooled ΔF by 6–38% depending on
the stretch. Since the upper-formant-weighted scale fit puts leverage 1.00 on F3 against 0.06 and
0.04 on F1 and F2, essentially all of the between-estimator ΔF disagreement on connected speech
is F3. That is why Phase 3's cross-estimator check feeds the reported confidence but is not
allowed to suppress a reading: a coarse second opinion's own F3 imprecision cannot establish that
the primary measurement failed. See `RESONANCE_REDESIGN.md` §5, Phase 3.

Two things follow. First, `vtlScore` is a **very high-gain** mapping: it spans its whole 0–1
range over ΔF ∈ [1029, 1250] Hz — a 21% band — so a 1% error in ΔF moves the reported score by
about 5 points. Small formant disagreements are amplified into large score disagreements, which
is why the estimators need explicit agreement bounds rather than an assumption of equivalence.
Second, the UI offers all four from one dropdown as if they were interchangeable, and the
`auto` ladder switches between three of them mid-session on room noise. The ladder now has
2 dB of hysteresis so an SNR resting on a tier edge stops re-selecting every frame, and the
four estimators' confidences are calibrated onto one scale (`formantEstimateConfidence`) so
switching estimator no longer silently changes how much the app trusts itself.

**Phase 3 removes the problem from the v2 stream entirely and leaves it on v1 by design.**
`selectResonanceMethod` no longer reaches the canonical measurement: root-solved LPC runs every
frame with its own continuity filters and its own confidence, so the between-estimator spread on
`resonanceAbsoluteV2` is **exactly 0.0000** across all four settings (it was 0.0224). v1's spread
is **unchanged at 0.1691 over the four and 0.0663 over the three `auto` can select**, because v1
is still the displayed metric and its output must stay byte-identical until Phase 4 retires it.
The ladder and the hysteresis therefore still matter, and will until then.

## Resonance construct redesign

The measurement *method* documented above (adaptive-ceiling LPC → uniform-tube ΔF fit) is
sound and matches the published recommendation. The *construct* — collapsing one frame's
F1–F3 into a single 0–1 number — is not: measured against Peterson & Barney norms with
ground-truth formants, vowel identity moves the score ~3x more than speaker sex does, and the
nominal 55/25/20 weighting double-counts F1 and F2. Phases 0–3 have landed: the score is
decomposed into tract scale and tract shape, the shape now names the vowel, F2 is reported
relative to that vowel's own norm, and the measurement is defined by one estimator rather than by
whichever one the room's noise selected. All of it is instrumented and none of it is displayed —
`smoothResonance` (v1) is still the only resonance number any user, port or piece of hardware
sees, and its output is byte-identical. See
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
  *(Still true of v1's dropdown. Post-Phase-3 the choice no longer reaches the v2 stream at all,
  and the bias is now divided out before any cross-check reads it —
  `ESTIMATOR_DELTA_F_BIAS` — because a published bias is not a disagreement.)*
- **The canonical LPC path and v1 now disagree by design, and the divergence is bounded and
  tested.** Post-Phase-3, `_resonanceLPC` is parameterised by analysis ceiling and returns two
  formant assignments plus bandwidths and the model residual. v1 reads the assignment and the
  default ceiling it always had, byte-identically; the canonical v2 path reads the pre-default
  vector (so a fabricated F1 = 500 Hz never reaches it — the LPC finds no F1 on 4.9% of Rainbow
  Passage frames and 10.0% of a synthesized vowel set at F0 180) at the per-user ceiling. Two
  LPC solves per frame occur only when those two ceilings differ; the shared case is one, and
  §3.4's three is never reached. This whole duplication exists because v1 must not move while it
  is displayed and is retired with v1 in Phase 4.

- **`spectralBrightness` replaces the centroid as a resonance estimator on web only.** D1's
  "brightness stays available only as an optional secondary display" is now true of the v2
  stream: the centroid is a 0–1 brightness feature there and nothing downstream of resonance
  reads it. v1's `centroid` estimator option is unchanged, and the Kotlin port's
  `SpectralBrightnessEstimator` is still brightness-primary (see D1 above).

- **The personal resonance-range learner is method-dependent.** Its conjunction of four gates
  (`conf > 0.4`, `formantSteadiness > 0.5`, `vowelLikelihood > 0.4`, non-zero ΔF) is reached
  under `lpc`/`cepstral`/`centroid` but not under `harmonic` on the Rainbow Passage, so whether
  a user ever gets a personal 0–100% span depends on which estimator the room's SNR selected.
  It also changes what the score *means* mid-session (population anchors → the speaker's own
  span) without recording which scale a stored reading was taken on, so session summaries can
  average across two different scales.
- **F4 is web-only and LPC-only.** The downsampled-LPC path returns F4 (92.4% of estimator
  frames on the Rainbow Passage); the cepstral, harmonic and centroid estimators do not, and
  neither port does. It feeds only the Phase-1 `formantScale`/`formantPattern` pair, which is
  instrumented and not displayed, so no cross-port contract depends on it yet. Extending the
  golden vectors past ΔF to the scale/pattern split is Phase 6. Phase 2's vowel classifier
  deliberately does **not** consume F4: its templates are Peterson & Barney's F1–F3 and there is
  no published r₄ to build a fourth column from, so `VOWEL_TEMPLATE_FORMANTS` pins the
  classifier's frame at three. This is load-bearing, not incidental — the residual identity
  `Σ L_i r_i ≡ 1` describes a *different* surface for four formants than for three, so
  normalising a 4-element residual and matching it against 3-formant templates compares vectors
  that do not live in the same space. Measured cost when that was live: vowel yield under `lpc`
  fell from 88.0% to 40.8%.
- **Rhotic F3 is unreachable by v1's formant assignment, and that is the real /ɝ/ blocker.**
  The LPC assignment loop admits a pole as F3 only above 2000 Hz; Peterson & Barney's adult-male
  /ɝ/ has F3 = 1690 Hz. Measured on the live path before Phase 3, a synthesized /ɝ/ was named
  correctly on **0.0%** of frames (it read as /ʊ/ on 63 of 67), and the lowest F3 the canonical
  path ever reported on the Rainbow Passage was 2091 Hz. Phase 3 computes a second, rhotic-capable
  assignment over the poles the same solve already produced (`F3_RHOTIC_FLOOR_HZ`, no extra LPC),
  which makes /ɝ/ reachable — 92.5% correct at F0 110 — but at F0 180 the sparse pole set fills
  the widened slot on most frames and manufactures rhotics (/ɔ/ → /ɝ/ on 47 frames in 67). It is
  therefore **computed and exposed, and not used**. On the current live classifier `/ɝ/` remains
  0% correct at F0 110, 130, and 180. The instrumented detector reaches 0%, 3%, and 11.9% recall,
  while non-rhotic false positives rise from 4.3% to 12.6%. The strict check requires at least
  50% `/ɝ/` recall at every F0, no zero-accuracy vowel subgroup, and at most 5% rhotic false
  positives. Fixing it needs an assignment policy v1 no longer constrains, which is Phase 4,
  validated on real rhotic recordings, which is Phase 5.

- **The vowel classifier's meaning depends on the pooling window, and that is only half solved.**
  `formantPattern` is taken against the ΔF pooled over a rolling window, so what a residual means
  depends on what that window held: several vowels (connected speech) or one (a sustained hold).
  Phase 2 normalises the two onto a common scale-invariant frame, which makes the classifier work
  in both — but the component it divides out (ρ) is exactly the component a rhotic /ɝ/ shows up
  in. **Phase 3 answered this and the answer is no.** ρ does what Phase 2 predicted on the
  published norms — held out across P&B's two populations it takes the classifier from 95% to
  100% correct at 0% abstention and removes the /ɝ/→/æ/ confusion — but the current live path
  still has 0% `/ɝ/` accuracy, because the standard assignment cannot supply its low F3 and the
  widened assignment is not safe to act on. The ~1.7 s pooling window also rarely holds enough
  distinct vowels for its running median ρ to mean anything. It is
  instrumented (`rhoticDetected`, `rhoRelative`, `rhoReason`, `windowHomogeneityCv`) and not
  acted on, with a test pinning that. The classifier's one systematic error remains /ɝ/ → /æ/.
- **Phase 2's features are web-only and unversioned.** `vowelId`, `f2Position`, and the two
  aggregation modes exist on the web analyzer only, are not in the Layer A packet, and are not
  displayed. Nothing on any port reads them. When they do become displayable (Phase 4), §3.5's
  versioning applies to them the same as to `resonanceAbsolute`.
- **`vtlScore` is a high-gain mapping**: full 0–1 travel over ΔF ∈ [1029, 1250] Hz, ~5 score
  points per 1% of ΔF error. That is a deliberate consequence of the 17 cm → 14 cm apparent
  tract-length anchors (**longer/darker → shorter/brighter**, not male → female: F0 and
  formants overlap substantially between gender groups, and ASHA is explicit that there is no
  single acoustic definition of voice feminization), but it means pre-calibration readings
  carry a wide confidence interval that the meter does not currently draw.
