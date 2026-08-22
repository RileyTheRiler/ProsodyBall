# Resonance: measurement redesign

**Status: Phases 0-2 landed; Phases 3-6 are plan.** Extends `DSP_CONTRACT.md`, which stays the cross-port
contract. This document covers one question: what `smoothResonance` should *be*.

The short version: the acoustic model is right and the arithmetic is right, but the construct
is wrong. One frame's F1–F3 collapsed into a single 0–1 number fuses three separable things —
how large the tract is, what shape it's currently in, and how badly the estimator is doing.
The redesign separates them.

---

## 1. The evidence

### 1.1 Vowel identity dominates the reading

Peterson & Barney (1952) adult-male mean formants. One population, one nominal vocal tract.
Fed as **ground truth** — no estimator, no noise, no smoothing:

| vowel | ΔF | apparent VTL | resonance score |
|---|---|---|---|
| /i/ "heed" | 1268 Hz | 13.8 cm | **0.73** |
| /ɪ/ "hid" | 1092 Hz | 16.0 cm | 0.36 |
| /ɛ/ "head" | 1054 Hz | 16.6 cm | 0.29 |
| /æ/ "had" | 1021 Hz | 17.1 cm | 0.25 |
| /ɑ/ "hod" | 926 Hz | 18.9 cm | 0.19 |
| /ʊ/ "hood" | 840 Hz | 20.8 cm | 0.06 |
| /u/ "who'd" | 806 Hz | 21.7 cm | **0.00** |

One speaker's apparent tract length ranges 13.8–21.7 cm and the meter swings **73 points**.
Moving from the male to the female norms moves it **23 points**. Vowel identity affects the
resonance readout roughly **three times more than speaker sex does**. At /i/, /ɔ/, /ʊ/ and /u/
the male→female separation is 1–3 points: nothing.

Praat's documentation states the same thing independently — apparent VTL differences between
front and back vowels *within one speaker* can exceed the average difference between male and
female speakers.

### 1.2 Only F3 is more speaker-determined than vowel-determined

| | variation across vowels (CV) | male→female shift | ratio |
|---|---|---|---|
| F1 | 32% | +16% | 0.50 |
| F2 | 38% | +19% | 0.51 |
| **F3** | **8%** | +17% | **2.12** |

F1 and F2 *define the vowel*. That is their job. Using them as the primary carriers of a
tract-size estimate in uncontrolled connected speech asks them to do the opposite of what they do.

### 1.3 Discriminability of candidate measures

d′ = (female mean − male mean) ÷ pooled within-sex across-vowel SD, over the P&B vowel set.
Below 1.0 means the measure separates two vowels in one mouth more reliably than it separates
two speakers.

| measure | d′ |
|---|---|
| F3 normalised (2200–3300 Hz) | **1.98** |
| **`resonanceAbsolute` v2 (Phase 1)** | **1.73** |
| ΔF from F3 alone | 1.67 |
| mean(F1,F2,F3) normalised | 0.96 |
| **current app score (v1)** | **0.85** |
| ΔF(F1,F2,F3) alone | 0.81 |
| ΔF(F2,F3) | 0.73 |
| F2 normalised (1000–2400 Hz) | 0.38 |

The benchmark is now committed code, not a table: `resonance-dprime.test.mjs` asserts it and
`node tools/resonance-benchmark.mjs` prints it, both from one implementation in
`tools/resonance-benchmark.mjs`. Re-measured there, v1 is 0.858 and the per-vowel scores in
§1.1 reproduce exactly; the 0.85 above is this document's rounding, not a second measurement.

### 1.4 The nominal weights are not the real weights

`vtlScore·0.55 + f1Score·0.25 + f2Score·0.20`, where `vtlScore` is itself computed from
F1/F2/F3. Numerically differentiating the actual scoring function:

| | score points per kHz | share of total formant sensitivity |
|---|---|---|
| F1 | 0.558 | 30% |
| F2 | 0.566 | 31% |
| F3 | 0.705 | 39% |

F1 and F2 enter twice — once through the ΔF regression, once directly. The published 55/25/20
split describes nothing that exists.

### 1.5 Literature anchors

- The zero-intercept regression of formants on formant index (Reby & McComb) is the recommended
  ΔF estimator. **The current implementation is correct on this point.**
- "F1 and F2 alone produce highly unstable eVTL estimates"; "F3 and F4 produce VTL estimates
  correlated with estimates from F1–F4 at *r* = .97." Upper formants carry the scale.
- eVTL comparison is "most meaningful in vocalizations that have either schwa-like or at least
  the same vowel quality." The app compares across every vowel in running speech.
- The guide describes **normalised residuals around the ΔF regression as tract-shape
  information, separate from tract scale**. That is the decomposition this plan adopts.
- F0 remains the strongest single predictor of perceived gender across the 2018 meta-analysis
  and the 2025 review. Hillenbrand & Clark: shifting F0 *or* formants alone was usually
  ineffective; both together ~82%. Neither cue is sufficient alone.
- F2 is well supported as a *trainable articulatory target* — visual-acoustic F2 biofeedback
  work, and GAVT outcome studies showing F2 rising 1847→1961 Hz with training.
- LPC/Burg is Praat's own formant method, and the TruVox real-time LPC resonance biofeedback
  system is direct precedent for this app's approach.

### 1.6 Feasibility check

On the Rainbow Passage fixture at the live frame rate, F3 is returned on **100%** of estimator
frames under `lpc` and `cepstral`, 78% under `harmonic`. The upper-formant-weighted architecture
below is buildable today. F4 sits inside the current analysis band (LPC runs to ~4961 Hz after
4× downsampling, 6.5 pole pairs) but no estimator extracted it — that was new work.

**Measured after Phase 1.** The downsampled-LPC path now assigns F4 and returns it on **92.4%**
of estimator frames on the same fixture, against 98.4% for F1/F2/F3. The other three estimators
return none, so v2 runs its F1–F3 fallback there; its scale-fit yield is 98.4% under all four —
identical to v1's ΔF-fit yield. `npm run test:resonance-yield` is the standing check.

---

## 2. Accepted without reservation

From the review, corroborated by the measurements above:

1. **Resonance is not aVTL.** Don't equate them.
2. **Don't compute aVTL per frame and compare across vowels.**
3. **Stop double-counting F1/F2** (§1.4 quantifies it).
4. **Don't switch estimators on one displayed scale.** Measured between-method spread is 0.111
   — over half a tier on a five-tier display. Room noise must not move a resonance reading.
5. **Drop centroid as a low-SNR substitute.** It contradicts the app's own ratified D1
   principle: suppress feedback rather than substitute a different quantity.
6. **Weaken the F0-independence claim.** LPC formant estimation has known F0-dependent error
   (harmonic attraction), worst exactly where transfeminine users operate. The current test
   bounds F0-induced movement at 0.20 of scale, which is not a tight bound. F0 belongs in the
   confidence model.
7. **Split `resonanceAbsolute` from `resonanceControl`.** Personal calibration currently
   destroys cross-speaker comparability *and* feeds the gender score.
8. **Six seconds cannot establish a person's range.** Guided sampling across vowels and
   deliberate postures instead.
9. **Two aggregation modes** — exercise (rewards held targets) vs speech (ecological).
10. **Don't label the anchors male→female.** Longer/darker ↔ shorter/brighter.
11. **Gender weights are provisional heuristics.** Say so in the code.
12. **Rename `strainGuard`.** Acoustic incongruence is not strain; strain is a phonatory
    construct that isn't measured here.
13. **Fix the Wear OS metric before its values enter shared statistics.**
14. **Correct the prose** — including my own summary in this conversation. "You can't fake it by
    straining" and "it's what transfers to speaking naturally all day" are both unsupported and
    should go.

---

## 3. Four refinements to the review

### 3.1 Raw F2 cannot be a live feature — vowel conditioning is load-bearing

The review is right that F2 deserves its own treatment and is the best-evidenced *trainable*
target. But raw F2 in connected speech is the **worst** measure tested (d′ = 0.38, §1.3), because
it is mostly reporting which vowel was spoken.

The review's own formula says "vowel-conditioned F2 shift" — the conditioning is the entire
value of the feature, not a qualifier on it. Shipping an "F2 position" meter without it would
make the app worse than it is today.

**Consequence for sequencing:** vowel identification is a *prerequisite* for the F2 feature, not
a parallel workstream. Phase 2 cannot start before Phase 1 produces the residuals that classify
the vowel.

**Measured after Phase 2.** The conditioning does what this section says it does: it removes
**11.4×** of the across-vowel variance that makes raw F2 the worst measure in §1.3 (35.5% of the
mean → 3.10%). What it does *not* do is beat raw F2 on §1.3's male-vs-female contrast, because
that contrast is almost entirely tract size and the conditioned feature has tract size divided
out — see §5's Phase 2 entry for the numbers and for why putting it back was refused.

### 3.2 The scale component should be upper-formant-weighted

The review leaves the ΔF input set open. §1.2 and the r = .97 finding both say the same thing:
**restrict or weight the scale regression toward F3 (and F4 when available).** Equal-leverage
F1–F3 regression is what produces d′ = 0.81.

This is cheap — it's a weight vector on the existing fit — and it is the single largest
validity gain available.

### 3.3 "Fit the weights against listener ratings" is not reachable from here

The app is 100% client-side, privacy-first, with no server and no data collection. Fitting a
perception model against listener ratings requires recorded voices, rated stimuli, and IRB-shaped
process. That is a research programme, not a sprint.

**Revised position:** label the current weights provisional (agreed), but v1 must earn its
validity from *published norms and stratified acoustic testing*, not from a study the app's
architecture forbids. An opt-in research mode could come later; nothing in this plan blocks on it.

### 3.4 Median-of-estimators is the wrong ensemble here

The review cites high-F0 phonetics work that takes the median of three formant algorithms, while
its own recommendation ("use one primary definition; use the others for confidence") points the
other way. The recommendation is right and the median is wrong for this app, for two reasons:

- The estimators carry **systematic bias, not just noise** — measured against a known vowel:
  lpc −0.3, cepstral −1.7, centroid +5.0, harmonic −11.9 points. A median of biased estimators
  is still biased, and *which* estimator the median selects can change frame to frame,
  reintroducing exactly the step-changes the review objects to in §9.
- Three LPC solves per frame at 60 fps on a phone, a watch and an ESP32 is not affordable.

**Resolution:** one primary estimator defines the measurement. The others run at reduced rate as
validity checks that gate confidence and reject corrupt frames. They never redefine the scale.

### 3.5 (Addition) Migration is a real constraint

Not addressed in the review, but it blocks shipping. Existing users have session histories,
learned personal ranges, necklace thresholds ("resonance 30–70%"), and vibration rules
("resonance below 40"). Changing the metric silently invalidates all of it and mis-fires
hardware against the old numbers.

**Requirement:** the metric carries a version. Stored readings record which version produced
them. Aggregates never mix versions. Threshold-based rules and hardware calibration are migrated
or re-prompted, never silently reinterpreted.

---

## 4. Target architecture

```
                         MIC
                          │
          ┌───────────────┼───────────────┐
      SNR / noise      F0 + voicing   speech / vowel likelihood
          └───────────────┼───────────────┘
                          │  frame admitted
                          ▼
              adaptive-ceiling LPC  (primary)
                          │
              continuity / path selection
                          │
                    F1  F2  F3 [F4]
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        FORMANT SCALE            FORMANT PATTERN
   ΔF regression, upper-      scale-normalised residuals
   formant weighted,            r_i = F_i / (i-0.5)ΔF
   pooled over a window                │
              │                        ├── vowel identity
        apparentVTL                    └── f2Position
              │                            (vowel-conditioned)
              └───────────┬───────────┘
                          │
                 CONFIDENCE MODEL
        F0 · SNR · path quality · fit residual
        · cross-estimator agreement
                          │
                          ▼
                 resonanceAbsolute ──────► perception model
                          │                (F0 + resonance + …)
                 personal calibration
                          │
                          ▼
                 resonanceControl ───────► ball / HUD / haptics
```

**Three values, never collapsed:**

| value | question it answers | used by |
|---|---|---|
| `resonanceAbsolute` | What acoustic configuration is being produced? | perception model, cross-session progress, cross-device |
| `resonanceControl` | Where is this inside *your own* demonstrated range? | ball, HUD, haptics, exercise feedback |
| `genderAlignment` | How close are several features to the user's chosen target? | gender colour mode, voice map tinting |

Exposed internals: `formantScale`, `apparentVTL`, `formantPattern`, `f2Position`,
`resonanceConfidence`, plus the two resonance values.

---

## 5. Phases

Each phase ships independently and is gated on measurable criteria. The d′ benchmark from §1.3
is the primary regression net; it becomes a committed test.

### Phase 0 — Truth in labelling *(no metric change, no migration)*

- Wear OS value renamed `spectralBrightness`; excluded from anything labelled resonance and from
  shared session statistics.
- `strainGuard` → `incongruencePenalty`, marked provisional.
- Gender cue weights annotated as provisional heuristics with the F0-primacy evidence cited.
- F0-independence claim weakened in `resonance-reliability.test.mjs` and the docs to "designed to
  be independent; synthetic testing shows invariance under controlled F0 manipulation; real-speech
  estimation exhibits F0-dependent error."
- README / UI copy corrected per §2.14.
- Anchors relabelled longer/darker ↔ shorter/brighter.

*Done when:* no user-facing or in-code text asserts something the evidence doesn't support.
Zero behaviour change; existing tests unchanged.

### Phase 1 — Decompose the construct — **LANDED** *(both metrics computed, v1 displayed)*

- **F4 extracted.** The downsampled-LPC root→formant assignment gained a fourth slot
  (`F4_CEILING_HZ` 4800, tighter bandwidth bound than F1–F3, admitted only after F3). Purely
  additive: it reads poles the F1–F3 loop had already discarded, so F1/F2/F3 and the confidence
  built from them are unchanged. **Measured yield: 92.4%** of estimator frames under `lpc`
  (F1/F2/F3: 98.4%), 0% under the other three estimators, which do not produce one. F4 stayed
  optional: the scale falls back to F1–F3 and is still defined.
- **`formantScale`** = weighted zero-intercept fit of `F_i = (2i−1)·ΔF/2`, **pooled over a
  rolling 100-frame (~1.7 s) window** by weighted median. The weights are not hand-picked
  toward the benchmark: they are ordinary weighted least squares, `w_i = 1/σ_i²` with
  `σ_i = CV_i · F̄_i` and the CVs taken from §1.2. Effective per-formant leverage
  (`w_i·x_i²`, normalised): F1 0.06, F2 0.04, F3 1.00, F4 1.00. Pooling is doing real work —
  per-frame ΔF scatters with SD 80.9 Hz on the Rainbow Passage, the pooled value 19.3 Hz.
- **`formantPattern`** = `r_i = F_i / ((i − 0.5)·ΔF)`, kept as a vector. Measured over P&B:
  r₁ travels 0.46 → 1.47 across vowels and 0.02–0.12 between the male and female norms for the
  same vowel. Vowel identity is nearly all of the signal, speaker sex nearly none — the
  inverse of what the scale carries, which is what makes a Phase-2 classifier built on it
  speaker-independent.
- **Double-counting removed.** `resonanceAbsolute` v2 takes ΔF_scale and nothing else, so every
  formant reaches it through the regression and nowhere else.
- **v1 unchanged and still displayed.** Its arithmetic moved into `resonanceScoreV1()` so the
  benchmark scores through the same function users see; the eval-harness golden ranges and the
  dsp-golden vectors pass untouched, and the fixture aggregates are identical to the pre-change
  run (avgResonance 0.370 / 0.422 at the two operating points).
- **Divergence instrumented.** `npm run report:resonance-divergence`.

*Done when:* v2 reaches **d′ ≥ 1.5** on the P&B benchmark (from 0.85), across-vowel swing for a
single speaker **< 25 points** (from 73), and the per-formant sensitivity table shows no formant
entering twice. **Measured** (`node tools/resonance-benchmark.mjs`, seven-vowel §1.1 set):

| | d′ | across-vowel swing (M / F) | M→F shift |
|---|---|---|---|
| v1 | 0.858 | 73.4 / 84.0 pts | 26.8 pts |
| **v2** | **1.734** | **14.5 / 12.7 pts** | 8.0 pts |

Per-formant sensitivity, differentiated at the same operating point §1.4 used
(F1/F2/F3 = 570/1710/2850 Hz, ΔF 1140; score points per kHz):

| | v1 ∂ | share | via ΔF | **second path** | v2 ∂ | share |
|---|---|---|---|---|---|---|
| F1 | 0.558 | 30% | 0.141 | **0.417** | 0.052 | 23% |
| F2 | 0.566 | 31% | 0.423 | **0.143** | 0.012 | 5% |
| F3 | 0.705 | 39% | 0.705 | 0.000 | 0.168 | 72% |

"Second path" is the sensitivity that survives freezing the ΔF route — nonzero means the
formant enters the score twice. v2 is zero on every row, asserted numerically rather than by
reading the source. With F4 present (3990 Hz) v2's shares are F1 15%, F2 4%, F3 48%, F4 34%.

**Two things Phase 1 did not achieve, recorded rather than smoothed over.**

1. On the **full ten-vowel** P&B set v2 reaches d′ 1.22, not 1.50 (v1: 0.76). One vowel is
   responsible: /ɝ/, whose rhotic constriction drops male F3 to 1690 Hz. An upper-formant-
   weighted tract-*length* estimate has no defence against that — a rhotic's F3 is not a
   statement about tract length, and it reads as an apparent tract 24.9 cm long. Dropping /ɝ/
   alone restores d′ to 1.84. The fix is Phase 2 (vowel conditioning) and Phase 3 (frame
   validity gates), not a different weight vector; both are asserted in the benchmark test so
   the limitation cannot be quietly forgotten. Note the residuals do **not** flag /ɝ/ —
   F3 carries the scale, so the rhotic is absorbed into the scale rather than left in the shape.
2. v2's male→female separation on the absolute axis is **8 points**, against v1's 27. That is
   a deliberate consequence of an axis wide enough that a speaker's across-vowel excursion
   occupies 14.5 points instead of 73, and it is not a loss of discriminability — d′ doubles.
   Restoring display travel is `resonanceControl`'s job (Phase 4), not an absolute scale steep
   enough to put /i/ and /u/ from one mouth at opposite ends.

### Phase 2 — Vowel conditioning — **LANDED** *(instrumented only; v1 still displayed)*

- **Vowel classified from the Phase-1 residuals.** Nearest of ten Peterson & Barney templates in
  a residual space normalised by each dimension's across-vowel SD, softened into a posterior at
  the measured across-speaker scatter (0.195). Speaker-independence is **demonstrated, not
  asserted**: templates built from one sex classify the other, across a 16.5% difference in
  pooled tract scale. **95% correct, 0% abstention, 0 errors outside /ɝ/** over all ten vowels
  in both directions; 100% on the seven-vowel §1.1 set.
- **`f2Position`** = `F2 / (r₂_template(vowel) · 1.5 · ΔF_frame)`. 1.0 is exactly where the
  published norms put that vowel for a tract of that size.
- **Two aggregation modes.** `aggregateExercise` (steady-state weighted, current behaviour) and
  `aggregateSpeech` (one value per vowel nucleus, nuclei weighted equally), plus a streaming
  `ResonanceAggregator` for live sessions that produces identical numbers. Session statistics
  read speech mode, the ball reads exercise mode — for the **v2** stream. v1's displayed
  "Avg Resonance" is untouched; switching the *displayed* statistic is Phase 4's job, since
  there is nothing to switch it to until v2 is displayed at all.
- **v1 unchanged.** avgResonance 0.370 / 0.422 at the two operating points, golden ranges and
  dsp-golden vectors untouched.

#### Two structural results that changed the design

**1. The residual vector has exactly *n*−1 free dimensions.** Not "r₃ is nearly
uninformative" — an identity. The weighted fit forces

```
Σ L_i · r_i ≡ 1,     L_i = w_i x_i² / Σ(w_j x_j²)
```

verified to 1.1e-16 on all ten vowels. F1–F3 therefore carries **two** dimensions, and r₃ is
r₁ and r₂ rearranged. Phase 1's guess that the classifier is "effectively running on (r₁, r₂)"
is exactly right, and now provable rather than effective.

**2. What a residual means depends on what the pooling window contained.** ΔF is pooled over a
rolling window, so in connected speech ρ = Σ L_i r_i ranges 0.73–1.22 across the P&B vowels —
the identity is broken and a third dimension opens. But a **sustained hold** collapses the
window onto one vowel, ΔF converges on that vowel's own fit, and ρ → 1 exactly. Both are
first-class: a held vowel *is* the exercise mode the ball runs. A classifier calibrated to the
pooled frame abstains through an entire sustained vowel — measured, a held /i/ sits 1.011 from
its own pooled-frame template against a 0.585 gate.

The classifier therefore matches in the **scale-invariant frame** (`r′ = r/ρ`), which is what
both operating points have in common. Measured effect: the vowel is named on **93.9%** of a
4-second held /i/ (unanimously /i/) and 91.2% of the running speech beside it.

#### /ɝ/: separable in principle, not by what Phase 2 ships

Phase 1 handed this over as the vowel where Phase 2 "either earns its keep or doesn't". Both
halves of the answer are recorded because either alone is misleading.

| frame | /ɝ/ distance to its nearest neighbour | rest of the set |
|---|---|---|
| pooled window (connected speech) | **1.18 — the most isolated vowel in the set** | 0.35–0.81 |
| scale-invariant (what ships) | **0.40 — tied with the closest pairs**, nearest is /æ/ | 0.38–0.63 |

Against a pooled scale the rhotic cannot be absorbed — the scale comes from the speaker's
*other* vowels — so it lands in r₃ at 0.697 against 0.94–1.24 for everything else. But **the
dimension that isolates /ɝ/ (ρ) is the same dimension a pooling-window mismatch moves.** They
are literally the same number. Using it requires knowing what the window contained, which is a
frame-validity and estimator-discipline question — **Phase 3** — and it is left there rather
than smuggled in. The cost is one confusion in twenty held-out classifications: /ɝ/ → /æ/,
exactly the confusion Phase 1 predicted.

#### f2Position vs raw F2 — the acceptance criterion as written is MISSED

Stated plainly, with the number:

| contrast | raw F2 d′ | f2Position d′ |
|---|---|---|
| **female vs male (§5's criterion), seven-vowel set** | **0.476** | **0.105** |
| female vs male, all ten | 0.459 | 0.242 |
| published GAVT training shift, seven-vowel set | 0.158 | **2.085** |
| published GAVT training shift, all ten | 0.156 | **2.211** |

**f2Position does not beat raw F2 on the male-vs-female contrast, and the reason is
structural.** P&B's two populations differ in tract *size* and barely in vowel *posture*, and
f2Position has size divided out by construction. Sweeping the one parameter that controls this
makes it unarguable — `α` is how much of the speaker's own scale the denominator keeps:

| α | d′ (F vs M) | r with `resonanceAbsoluteV2` |
|---|---|---|
| 0.00 (population-relative) | 5.866 | **0.954** |
| 0.50 | 2.942 | 0.846 |
| **1.00 (shipped)** | **0.105** | **0.057** |

α = 0 would clear the criterion at d′ 5.9 — by re-measuring tract length through F2, correlating
**r = 0.95** with the scale `formantScale` already publishes. That is §1.4's double count rebuilt
through a different door, and it is the whole thing Phase 1 existed to remove. **The knob was
not turned.**

What the conditioning *did* achieve is §3.1's actual claim, and the benchmark's own d′
denominator is the thing it measures: across-vowel SD of raw F2 is **35.5%** of its mean;
of f2Position, **3.10%**. **Vowel variance removed: 11.4×.** And on the contrast the feature is
for — §1.5's published GAVT outcome (F2 1847 → 1961 Hz, a *within-speaker* change at fixed
tract length, which is what an F2 biofeedback target trains) — f2Position beats raw F2 by
**13×**, using the classifier's own decisions rather than oracle labels. Raw F2 detects the very
shift it is promoted as a training target for at d′ 0.16, *worse* than it separates the two P&B
populations, because a 6% F2 change is small against a 35% across-vowel spread.

#### Abstention: the frame-level gates are not sufficient; the nucleus rule is

§6 requires degrading to "no vowel this frame" rather than guessing. Frame by frame it does
**not**: below ~0.5 SD of residual noise the classifier misclassifies more often than it
abstains, because the two gates catch a frame thrown away from every template or landing between
two, but not one thrown squarely onto a neighbour. What meets §6 is the nucleus rule — three
consecutive frames must agree before any nucleus exists — which is why `f2Position` is
aggregated and never read off one frame:

| residual noise SD | per frame: correct / wrong / abstain | per nucleus: correct / wrong / abstain |
|---|---|---|
| 0.0 | 95.0 / 5.0 / 0.0 | 95.0 / 5.0 / 0.0 |
| 0.2 | 84.9 / 13.5 / 1.6 | **92.8 / 4.4 / 2.8** |
| 0.3 | 71.1 / 23.3 / 5.7 | **87.8 / 6.0 / 6.3** |
| 0.5 | 47.9 / 36.1 / 16.0 | 51.6 / **10.5** / 37.9 |
| 1.0 | 14.9 / 44.9 / 40.2 | 4.7 / **2.9** / 92.4 |

Misclassification drops roughly fourfold and abstention overtakes it. Reducing the remainder is
Phase 3's frame-validity work, not a threshold to move here.

#### F4, and frame yield

F4 **does not degrade** classification (identical within sampling error at 0–100 Hz of formant
noise) and does not improve it either. The reason is structural: the classifier's frame is
pinned to F1–F3 because the templates are F1–F3 — P&B published no F4, so there is no measured
r₄ and inventing one is the fabrication §6 forbids. Normalising a 4-element residual against
3-formant templates compares vectors on two different constraint surfaces; when that was live it
cost **47 points of frame yield** under `lpc`. F4 keeps its Phase 1 job of sharpening
`formantScale`. A measured r₄ is Phase 5's to provide.

Frame yield on the Rainbow Passage, against Phase 1's numbers:

| | `lpc` | `cepstral` | `harmonic` | `centroid` |
|---|---|---|---|---|
| `formantScale` fit (Phase 1) | 98.4% | 98.4% | 98.4% | 98.4% |
| F4 (Phase 1) | 92.4% | 0% | 0% | 0% |
| **vowel named / `f2Position`** | **88.0%** | 81.5% | 74.5% | **0%** |

`centroid` resolves no F3, so it yields one residual dimension and the classifier declines
outright rather than naming a vowel from a scale it cannot fit — the §6 discipline reaching the
right answer without a special case.

#### Aggregation modes, on a hold-plus-speech clip

`tools/resonance-aggregation.mjs` builds the fixture in source (a synthesized 4 s held /i/ —
P&B's male /i/ rescaled to the passage speaker, F2 raised by the GAVT increment — concatenated
with the Rainbow Passage) and reports both modes:

| | exercise | speech | hold-only | passage-only |
|---|---|---|---|---|
| `f2Position` | 0.9993 | 0.9873 | 1.0049 | 0.9873 |
| `resonanceAbsoluteV2` | 0.5584 | 0.5216 | 0.5760 | 0.5242 |

The hold commands **68.1% of exercise-mode weight and 4.2% of speech-mode nuclei** (1 of 24) —
a 16× asymmetry, and the whole difference between the modes. f2Position shows the smaller gap
(1.2%) because this hold happens to sit near the passage's own mean f2Position; resonanceV2
shows 7.1%. The hold is fixed by publication rather than chosen, and requiring both gaps to be
large would be satisfied by shopping for a flattering fixture.

*Done when:* `f2Position` beats raw F2 (d′ 0.38) by a clear margin on the benchmark, and the two
aggregation modes measurably differ on a clip containing one long hold plus running speech.
**Half met.** The aggregation criterion is met and asserted (`npm run test:resonance-aggregation`).
The d′ criterion is **not met on the contrast as written** (0.105 vs 0.476) and is met by 13× on
the contrast the feature is for. Closing it as written would require putting tract length back
into f2Position, which duplicates `formantScale` at r = 0.95. Recommendation for Phase 4: state
the criterion against a within-speaker contrast, since an absolute tract-size axis
(`resonanceAbsolute`) and a trainable-posture axis (`f2Position`) should not both be scored on
how well they separate two populations by tract length.

### Phase 3 — Estimator discipline

- LPC becomes the single scale-defining estimator. `selectResonanceMethod` no longer swaps the
  measurement.
- Cepstral/harmonic run at reduced rate as cross-checks feeding `resonanceConfidence`; centroid
  demoted to a `spectralBrightness` secondary feature, never a resonance substitute.
- Per-user LPC ceiling chosen during calibration by a multi-ceiling search (FormantPath-style),
  with a low-rate background re-check during use. **Live frames use the one selected ceiling** —
  the real-time budget does not allow per-frame multi-solve.
- Frame validity gates added: F1 < F2 < F3 < F4, bandwidth limits, trajectory continuity, LPC
  residual/model-fit, formant-swap detection.
- F0 enters the Kalman measurement noise: as F0 rises and harmonic sampling thins, measurement
  variance rises.

*Done when:* estimator identity no longer moves the displayed value; below the SNR floor the app
shows no resonance rather than a substitute; per-user ceiling measurably beats a fixed ceiling on
a high-F0 test set.

### Phase 4 — Two scales and real calibration

- `resonanceAbsolute` / `resonanceControl` split throughout; perception model consumes absolute
  only; ball/HUD/haptics consume control.
- Guided calibration extended to a vowel set (ə i u æ ɑ) plus a standard phrase, sampling three
  postures: habitual, comfortably brighter, comfortably darker.
- Metric versioning + migration per §3.5.

*Done when:* two speakers with different absolute ranges no longer both read 100%; stored
readings carry a version; no hardware threshold fires against a value from a different version.

### Phase 5 — Validation ladder

| level | establishes | status |
|---|---|---|
| synthetic vowels | algorithmic accuracy | **done** |
| real sustained vowels vs manually checked Praat F1–F4 | formant accuracy | **the next real gap** |
| connected speech | in-use robustness | not started |
| listener ratings | construct validity for perceived gender | research programme, §3.3 |

Stratify by F0, vowel, SNR, device/microphone, breathiness, nasality, loudness, speaker.

### Phase 6 — Port alignment

- Kotlin `ResonanceEstimator` moved onto the decomposed model (D1 debt, still open).
- C++ extended from ΔF-only to the scale/pattern split.
- Cross-port golden vectors extended past ΔF to the full feature set.

---

## 6. Risks

**The measure gets harder to estimate as it gets more valid.** F3/F4 are lower-amplitude and
missed more often than F1/F2 — construct validity and measurement reliability pull opposite ways.
Phase 1's acceptance criteria must include a frame-yield floor, not just d′.

**Decomposition can leak into the UI.** The user should still see one ring. Five internal
variables is an implementation detail; if it reaches the interface the redesign has failed.

**Existing users' numbers change.** Unavoidable — the current numbers are wrong. Handled by
versioning, not by pretending continuity.

**Vowel classification is a new failure mode.** A misclassified vowel produces a confidently
wrong `f2Position`. It must degrade to "no F2 feature this frame" rather than guess — the same
discipline applied to the centroid's fabricated F3.

**Measured after Phase 2, and the answer has two parts.** Two abstention gates (distance to the
nearest template beyond three across-speaker scatters; posterior below 0.5) are *not* sufficient
on their own: frame by frame, below ~0.5 SD of residual noise, the classifier misclassifies more
often than it declines, because neither gate catches a residual thrown squarely onto a
neighbouring vowel. What satisfies this risk is that `f2Position` is never read off one frame —
a vowel nucleus requires three consecutive frames to agree, which cuts misclassification roughly
fourfold and puts abstention above it. The per-frame and per-nucleus rates are tabulated in §5's
Phase 2 entry and asserted in `resonance-dprime.test.mjs`. Tightening the frame-level gates
further is Phase 3.

---

## 7. Open questions

1. Should `resonanceControl` remain the default display, or should absolute be default once the
   calibration is good enough to trust? (Product call — control is better for motor learning,
   absolute is better for knowing where you actually are.)
2. Is F4 worth its miss rate, or is F3 + a tighter confidence model sufficient?
3. Does the necklace/watch haptic threshold belong on absolute or control? Absolute is
   cross-device consistent; control is what the user is training against.
4. What replaces the five-tier descriptor once the metric is two-dimensional — a tier plus a
   shape cue, or a position on a 2D map?
