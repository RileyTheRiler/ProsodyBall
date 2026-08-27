# Resonance: measurement redesign

**Status: Phases 0-4 landed; Phase 6's C++ leg landed; Phase 5 and Phase 6's Kotlin leg are plan.** `resonanceControl` (v2) is the displayed
metric; `resonanceScoreV1` remains computable and is displayed nowhere. Extends `DSP_CONTRACT.md`, which stays the cross-port
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

**Corrected in Phase 4, against a grep rather than an assumption, and the correction cuts both
ways.** Two of the four do not exist: nothing persists a session history, and the "learned
personal range" is in-session only — it is reset in the constructor, in `stop()` and by the
settings reset, no `localStorage` key ever holds it, and it dies with the tab. The necklace
controller reads no resonance at all. What *is* persisted is the phone's vibration rules
(`vox:vibration:v1`) and the Wear overlay's own copy (`voxWatch.settings`), both defaulting to
"resonance below 30 / above 70". So the migration surface is **two threshold stores**, and the
real work was the persistence that did not exist — versioned from its first write. See §5's
Phase 4 entry for the table and for the measured mis-fire the versioning prevents.

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

**Measured in Phase 3, and the frame-level answer is partly yes.** The gates Phase 3 added do
reject frames that are worse than the ones they admit — 93.6% precision at 12 dB against an 82.3%
base rate — and they removed a fabricated F1 the classifier had been consuming on ~5% of frames.
What they do **not** do is close the specific hole this table describes: at 6 dB they stop
discriminating entirely (82.7% precision against 82.6% base), and a residual thrown squarely onto
a neighbouring vowel is still not a frame the gates can see. The nucleus rule remains what
satisfies §6.

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

### Phase 3 — Estimator discipline — **LANDED** *(instrumented only; v1 still displayed)*

- **One estimator defines the measurement.** Root-solved downsampled LPC runs every frame and
  everything the v2 stream reports is built from it, whatever `resonanceMethod` says. The
  canonical path has its own Kalman filters, its own steadiness and its own confidence, so
  nothing downstream can be reached by the estimator the room's noise selected.
- **Cepstral/harmonic are cross-checks at reduced rate**, feeding confidence and never the
  value. **Centroid is demoted** to `spectralBrightness`.
- **Per-user LPC ceiling** by a FormantPath-style multi-ceiling search (`calibrateLpcCeiling`),
  with a low-rate background re-check. Live frames use the one selected ceiling.
- **Frame validity gates**: ordering, bandwidth, trajectory continuity, LPC model residual,
  formant swap. Rejection is per formant where the evidence is per formant.
- **F0 enters the Kalman measurement noise** as (F0/100 Hz)², and enters nothing else.
- **v1 unchanged.** avgResonance 0.370 / 0.422, golden ranges and dsp-golden vectors untouched.

#### Estimator identity no longer reaches the value

Measured on the reference synthesized vowel, each estimator forced, against the same code on
`main`:

| | v1 (displayed) | v2 (canonical) |
|---|---|---|
| spread over all four estimators | 0.1691 → **0.1691** | 0.0224 → **0.0000** |
| spread over the three `auto` can select | 0.0663 → **0.0663** | 0.0020 → **0.0000** |

v1's spread is unchanged **by the same rule that froze it through Phases 1 and 2** — it is the
displayed metric and its output must stay byte-identical until Phase 4 retires it. (§5's Phase 1
entry quotes 0.111 for the ladder; measured on today's `main` it is 0.0663. The 0.111 predates
the Phase 0 confidence-gain calibration. The comparison above is against `main` as it stands, so
both columns are one measurement.)

v2 is **exactly zero, not small**: there is no branch for the estimator identity to take. It is
asserted as an equality, frame by frame, in `resonance-estimator-discipline.test.mjs`.

#### Budget (§3.4 — measured, not assumed)

3 s of held vowel at 60 fps. The frame budget is 16.67 ms; the ms column is the **whole**
`update()`, not the LPC alone.

| case | LPC solves/frame | ms/frame | % of budget |
|---|---|---|---|
| `lpc`, default ceiling — every user today | **0.994** | 4.73 | 28.4% |
| `lpc`, per-user ceiling (post-calibration) | 1.989 | 4.63 | 27.8% |
| v1 forced onto `harmonic` or `centroid` | 0.994 | 4.6 | 27.6% |

The common case pays **nothing**: v1's `lpc` branch and the canonical path want the same ceiling
and share one solve through a per-frame cache. The second solve appears only where v1 is pinned
to a different ceiling than the canonical path — and it exists *solely* because v1 must not move
while it is displayed. Phase 4 retires v1 and takes it with it. §3.4's three solves per frame is
never reached at any setting. The cross-checks add no solve at all (both work off the FFT
magnitudes the frame already has) and run at 10 Hz on alternating slots.

#### Below the floor the app shows nothing

Rainbow Passage under `auto`, at both rates the repo calls live — the 735-sample hop every
Phase 1/2 yield number is measured at (33 ms on this 22.05 kHz fixture) and the rAF loop's true
60 fps:

| condition | 30 fps suppressed | 60 fps suppressed | what collapsed |
|---|---|---|---|
| clean | 11.4% | 4.5% | pool warm-up, brief pauses, 4 low-SNR frames |
| +noise, 12 dB | 37.7% | 45.6% | fit quality, then pool |
| +noise, 3 dB | **100%** | **100%** | nothing left to pool |

**What the user sees is nothing.** A suppressed frame *clears* `resonanceAbsoluteV2`, the pooled
scale, the apparent tract length, the vowel and `f2Position`; it does not freeze them, and it
never substitutes a brightness number computable from noise but wrong — the trap D1 names. It
also closes any open vowel nucleus. Past a real pause (all four formants stale, ~0.2 s of
non-phonation) the same clearing happens without the resonance stage running at all, so a value
from before a pause can never be read as a live one.

Two things are deliberately **not** able to suppress. The cross-estimator agreement is one; see
below. `spectralBrightness` is the other — it is computed and exposed and nothing downstream of
resonance reads it.

#### Frame validity gates: precision, recall, and cost

Labelled on synthesized vowels (5 vowels × 3 tract scales × 4 F0s per condition); a frame is BAD
when its raw-formant ΔF is more than 5% from the synthesized truth — a quarter of v1's meter, per
DSP_CONTRACT's ~5 points per 1% of ΔF. Precision = of what it rejected, how much was bad.

| condition | bad-frame base rate | gate | reject % | precision | recall |
|---|---|---|---|---|---|
| clean | 9.7% | bandwidth | 3.4% | **100%** | 35.3% |
| | | continuity | 0.9% | 0% | 0% |
| 20 dB | 80.5% | swap | 0.2% | 88.9% | 0.3% |
| | | bandwidth | 8.1% | 77.4% | 7.8% |
| | | frame-level, all | 1.4% | **90.6%** | 1.6% |
| 12 dB | 82.3% | residual | 40.5% | **93.5%** | 46.1% |
| | | bandwidth | 8.0% | 90.7% | 8.8% |
| | | frame-level, all | 40.8% | **93.6%** | 46.4% |
| 6 dB | 82.6% | frame-level, all | 85.7% | 82.7% | 85.8% |

**At 6 dB the gates stop discriminating** — 82.7% precision against an 82.6% base rate is
rejecting at random. That is not a gate failure, it is the SNR floor's job instead, and it is
why the committed check asserts down to 12 dB and reports 6 dB without asserting it. A
knife-edge assertion dressed as a claim is worse than a stated limit.

**That detector-only check was insufficient.** It could pass while frame-level recall was 0%
on clean audio and 1.6% at 20 dB, because it asserted precision only when at least ten whole
frames were rejected. The current acceptance report follows each target frame through the
per-formant gates, pooling, and suppression. It separately reports emitted-value precision,
accurate-frame recall, wrong-output rate, abstention, and every vowel/F0 subgroup. At 20 dB the
live output is only 37.4% precise with 48.7% wrong frames; at 12 dB it is 44.6% precise, with
`/i/` and `/u/` at 0% accurate recall. The strict check now fails those conditions. CI names the
temporary quarantine and runs the strict command as a visible non-blocking step; removing the
quarantine requires every aggregate and subgroup to meet the thresholds documented in the tool.

**The continuity gate's benefit is not measurable on the corpus that can label frames, and this
is stated rather than papered over.** Sustained synthetic vowels contain no formant transitions,
so a continuity gate has nothing to catch there, and its 0% precision on clean audio is the
corpus's limitation rather than the gate's. On connected speech, where it fires, there is no
ground truth — but its effect is measurable: on the Rainbow Passage, **turning it off costs 6.0
points of vowel yield** (85.3% → 79.3%). It does not cost yield, it buys it, by withholding a
pole that jumped so the rest of the formant set stays coherent. What it catches is real: measured
per-frame steps on that passage reach 1210 Hz on F2, 1565 on F3 and 1266 on F4 in 16.7 ms, while
F1 never exceeds 345 — those are pole reassignments, not articulation.

**The swap gate costs and buys nothing measurable on connected speech** (identical yield with it
on and off, fires on 0% of passage frames once rejection is per formant), and earns its place
only on the labelled corpus, at 88.9–100% precision. It is kept as a zero-cost invariant check
and reported as exactly that. The **order** gate never fires at all, because the LPC assignment
loop enforces ordering by construction; it is kept for the same reason.

**Three gate thresholds were wrong on the first pass and were corrected against measurement, not
against a benchmark.** Recorded because each was a mis-stated expectation rather than a tuning
choice:

| gate | first value | why it was wrong | corrected to |
|---|---|---|---|
| continuity | 25% of the formant's own frequency | a proportional bound is far too loose at F1 and too tight at F2; formant velocity is a rate, not a proportion. Rejected 74% of ordinary read speech | 30 Hz/ms, above the fastest published glide transitions (10–25 Hz/ms), **expressed in Hz/s and multiplied by the caller's own frame interval** |
| bandwidth | `0.25·f + 150` | tighter than Praat's published flat 400 Hz at F1 — stricter than the established rule with no evidence behind it | `max(400, 0.25·f + 150)`: Praat's rule as a floor, loosened only above 1 kHz where F3/F4 bandwidths measurably run wider |
| LPC residual | 0.35, on the claim that clean vowels sit "well below 0.1" | false. Measured median on the Rainbow Passage is 0.161, p90 0.337 | 0.5 — the point where the model fails to predict *more than half* the frame's energy |

#### The confidence model is a geometric mean, and the cross-check does not suppress

§4's diagram reads as a product and the first implementation took it literally. Measured on the
Rainbow Passage the six terms sit at 0.93 / 0.71 / 0.65 / 0.73 / 0.44 / 1.00 and their product is
**0.137** — nothing has failed and the app would have suppressed 48% of a clean recording of read
speech. They are not independent failure probabilities; they are six correlated views of one
frame's quality. The geometric mean is the right aggregator and keeps the property the product
was chosen for: **any term at zero takes the whole thing to zero**, so "below the SNR floor the
app shows no resonance" is exact rather than approximate (`snrToConfidence` returns exactly 0
below the red threshold).

**Cross-estimator agreement feeds the reported confidence and not the suppression decision**, and
that is a measured call, not a compromise. On the Rainbow Passage the cepstral estimator's F3
differs from the canonical LPC's by a **median 25.6%** (F1 and F2 by ~8%), and the weighted scale
fit puts leverage 1.00 on F3 against 0.06 and 0.04 on F1 and F2 — so essentially all of the
between-estimator ΔF disagreement is the *checker's* own F3 imprecision. Letting it suppress the
primary is backwards, and it costs: with agreement in the suppression decision the app declined
26% of clean read speech and vowel yield fell from 87.0% to 71.2%. §5's rule applies —
seventeen points of yield for a term mostly reporting a known property of the checker is more
than it buys. It is kept where it belongs: `tools/frame-validity.mjs` measures that on clean
synthetic frames its lowest agreement quartile is **23.2% bad against 0.2%** for its highest.

Two further corrections along the way, both worth recording because both were mis-scaled
statistics rather than bad ideas:

- **The comparison must be like for like.** Comparing a Kalman-smoothed multi-frame canonical ΔF
  against a raw single-frame check measures the smoothing; comparing a 3-formant fit against a
  2-formant one compares different constraint surfaces — the same error that cost Phase 2 47
  points of yield when F4 reached the classifier. Unmasked and unsmoothed, the "disagreement"
  between LPC and cepstral is a median 28%, almost all of it the comparison's own construction.
- **The tolerance is one formant number, not one estimator's precision.** DSP_CONTRACT's 4%
  spread is measured on a sustained synthetic vowel. Two estimators that have slipped a formant
  number relative to each other disagree by ~1/n of ΔF — about a third — and that is the failure
  worth suppressing for. The evidence for the term is unaffected by the rescaling: a quartile
  split is rank-based.
- **And the cadence must be in seconds.** A 16-reading pool at one check per 6 frames covers
  3.2 s at 30 fps and 1.6 s at 60. Same recording, same estimators, pooled ratio 1.057 against
  1.275 and 10% suppressed against 33%. Exactly the defect DSP_CONTRACT's frame-rate fidelity
  section documents, reproduced in new code.

#### Per-user ceiling vs a fixed one, on a high-F0 test set

The existing fixtures cannot answer this: one speaker at 96–104 Hz with a pooled ΔF near
1000 Hz is the speaker the published default was chosen for. The ceiling is a per-**speaker**
parameter, so the set has to vary the speaker. `tools/lpc-ceiling.mjs` builds it — four tract
scales (0.90–1.30 of P&B's adult male, i.e. ~19.5 cm down to ~13.4 cm apparent tract) × six F0s
(**100 to 300 Hz**) × three SNRs, calibrated on /i ɑ u/ and scored on **held-out** /ɛ ʌ/.

| SNR | mean \|ΔF error\| fixed | chosen | median fixed | median chosen | worst fixed | worst chosen | points improved |
|---|---|---|---|---|---|---|---|
| clean | 1.82% | **1.33%** | 0.62% | 0.61% | 5.11% | 1.67% | 48% |
| 24 dB | 2.47% | **2.42%** | — | — | — | — | 43% |
| 16 dB | 5.36% | **4.99%** | 5.14% | 5.04% | 10.44% | **8.87%** | 43% |

At the two ends of the F0 range, clean: **100 Hz** fixed 0.52% / chosen 1.03%; **300 Hz** fixed
7.57% / chosen 7.65%. At 260 Hz, where the effect is largest, 3.65% → **1.40%**.

**The win is real and it is concentrated, and reporting it as a general improvement would be
overselling it.** Most speaker/F0 points tie or move by under a tenth of a point, which is why
the median barely moves while the mean drops. What the search buys is the minority where a fixed
ceiling is badly wrong: clean, short tract, high F0, where the default cuts into the band F4 is
in, it recovers 4.5 and 5.7 points. The direction *reverses* with noise exactly as the mechanism
predicts — at 16 dB it selects **lower** ceilings for long tracts, because the band above F4 now
carries noise for a spare pole pair to lock onto, which is D2's spurious-pole risk. That is a
per-user parameter behaving like one. It is insurance against the bad cases.

Two things this does **not** establish. The set is synthesized — a Klatt cascade with no
breathiness, nasality, room or coarticulation — so it shows the search picks a better ceiling
when the ceiling is the only thing that differs, not that a real high-F0 speaker gets the same
benefit. That is Phase 5's ladder. And the set had to be run **with noise** to exercise half the
mechanism at all: on a noiseless cascade there is nothing above F4 for a spare pole to find, so
every ceiling above F4 performs identically. Run clean-only, the search "beat" the default by
0.22 points, which is not a measurement of anything.

**A separate limit, named rather than averaged in.** Above F0 220, where F1 and F2 are close
(/ʌ/ at 640/1190 Hz), the model places **one** pole across both and every formant lands a slot
low — ΔF errors of 22–54%. No ceiling touches it; the harmonics needed to separate the two
resonances are not in the signal at any analysis bandwidth. Three of 24 points are excluded from
the comparison for it and reported here instead. Catching it live is what the swap gate is for,
and the swap gate needs a good frame to compare against — a *sustained* merged vowel has none.
That is an open gap.

#### ρ and /ɝ/: the answer is no, and the blocker was never ρ

Phase 2 handed this over as the thing Phase 3 would "either do properly or establish that it
can't be done and say why". Both halves were measured.

**ρ does everything Phase 2 said it would, on the norms.** /ɝ/'s ρ is 0.7212 against 0.9053–1.1882
for every other vowel — and it is *speaker-independent where it matters*: 0.7255 (male) against
0.7169 (female), a 1.2% difference across a 16.5% gap in pooled tract scale, against a 25% gap to
the nearest non-rhotic. Because window composition scales every vowel's ρ by a **common** factor,
dividing by the window's running median removes it. Held out across P&B's two populations, that
takes the classifier from **95% to 100% correct at 0% abstention**, removes the /ɝ/→/æ/ confusion
without introducing another, improves at every noise level to 150 Hz per formant, and survives
window composition down to **three distinct vowels** — breaking at two, where 32 false positives
appear because a median over two points is whichever is larger. The threshold, √(0.7212·0.9053) =
0.8080, is the geometric midpoint of two published norms and sits on a broad plateau (85.0%
against 84.9% at 0.75 and 84.6% at 0.85, swept in `tools/rho-rhotic.mjs`).

**It does not survive the live path, and the failure is not marginal.** Driven over synthesized
vowels whose identity is known by construction, the shipped classifier identifies `/ɝ/` on 0%
of frames at F0 110, 130, and 180. The instrumented detector reaches 0%, 3%, and 11.9% recall,
while false positives on non-rhotics are 4.3%, 4.1%, and 12.6%. At F0 180, `/ɛ/` and `/ɑ/` also
have zero correct frames, so the failure is not isolated to the rhotic. Two causes, neither a
threshold that could be moved:

1. The live pooling window is ~1.7 s and rarely holds enough **distinct** vowels for its running
   median ρ to mean anything. A window holding two vowels has a median that is one of them.
2. **The extractor cannot see the excursion ρ is meant to read.** The LPC assignment admits a
   pole as F3 only above 2000 Hz, and P&B's adult-male /ɝ/ has F3 = **1690 Hz**. Measured on
   `main`, the live path names a synthesized /ɝ/ correctly on **0.0%** of frames — it reads as
   /ʊ/ on 63 of 67 — and the lowest F3 the canonical path ever reported on the Rainbow Passage
   was 2091 Hz. Widening the slot (`F3_RHOTIC_FLOOR_HZ`, a second assignment over the poles the
   same solve already produced, so no extra solve) makes /ɝ/ reachable — **92.5% correct at F0
   110** — but at F0 180 the sparse pole set puts something in the widened slot on most frames
   and manufactures rhotics: /ɔ/ → /ɝ/ on 47 frames in 67.

So the answer to "is ρ now usable for /ɝ/" is **no**, and the binding constraint is not ρ. It is
that the formant assignment has one policy, shared with v1, that cannot admit a rhotic F3 without
admitting spurious ones. Fixing it needs an assignment v1 no longer constrains — **Phase 4**,
when v1 retires — validated against real rhotic recordings rather than a Klatt cascade, which is
**Phase 5**. Everything needed is measured and exposed (`rhoticDetected`, `rhoRelative`,
`rhoReason`, `windowHomogeneityCv`, `measuredRhotic`); **none of it is switched on**. The strict
live check requires at least 50% `/ɝ/` recall at each tested F0, at most 5% detector false
positives, and no vowel with zero correct frames. CI's quarantine is explicit and its completion
condition is those criteria, so turning the detector on later requires evidence rather than a
green norms-only check.

**Phase 2's classification numbers are therefore unchanged**, and the d′ benchmark including its
Phase 2 additions is untouched.

#### A fabricated formant, removed

`_resonanceLPC` substitutes F1 = 500 Hz and F2 = 1500 Hz when it finds none — v1's behaviour,
still unchanged. Phases 1 and 2 fed those substitutes **straight into the v2 stream**, because
v1's age counters reset on the defaulted value, so a fabricated F1 looked freshly measured. The
LPC finds no F1 on **4.9%** of Rainbow Passage estimator frames and **10.0%** of a synthesized
vowel set at F0 180. The canonical path reads the pre-default vector and abstains instead.

This is most of why live-path classification at F0 180 reads lower than `main`'s (64.5% against
76.9%): `main`'s /ɛ/ was named using an F1 the microphone never produced, which happened to sit
30 Hz from /ɛ/'s true F1. The Phase 3 path declines on those frames — 55 of 67 abstentions — which
is what §6 asks for. At F0 110 and 130 the two are within half a point (86.7% and 86.6% against
87.2%).

#### Frame yield, against Phase 2's

| | Phase 2 | Phase 3 | change |
|---|---|---|---|
| `formantScale` fit under `lpc` | 98.4% | **98.4%** | — |
| F4 under `lpc` | 92.4% | **92.4%** | — |
| pooled scale | 92.4% | 88.6% | −3.8 |
| vowel named / `f2Position` | 88.0% | 85.3% | **−2.7** |

**The floor §5 states is met on `formantScale` and missed by 2.7 points on `f2Position`, and the
trade is this.** The whole of the loss is frames the app now declines to read: SNR-floor
suppression, and clearing the reading past a real pause instead of holding the last one. The
validity gates cost nothing net — per-formant rejection recovers what whole-frame rejection took,
and the continuity gate is worth +6.0 points on its own. Against that, the v2 stream's
across-clip swing falls from 5.6 to **4.3 points** on the same passage, and it is now identical
under all four estimator settings instead of varying by 0.0224. Declining 2.7% more frames to
stop the number depending on which estimator the room selected is the trade Phase 3 exists to
make; the alternative on those frames was a reading built on a fabricated formant or on noise.

*Done when:* estimator identity no longer moves the displayed value; below the SNR floor the app
shows no resonance rather than a substitute; per-user ceiling measurably beats a fixed ceiling on
a high-F0 test set. **Met, with one criterion met on the value Phase 3 is making valid rather
than on the one still displayed.** Estimator identity is removed from the canonical value exactly
(0.0000) and is deliberately *unchanged* for v1, which is frozen by the same rule as in Phases 1
and 2. Suppression is exact at the SNR floor and clears rather than freezes. The ceiling beats a
fixed one on the mean at all three SNRs on held-out vowels, and does not move the median — both
reported.

### Phase 4 — Two scales and real calibration — **LANDED** *(v2 displayed; v1 computable, not shown)*

The first phase where the displayed number is allowed to move, and it moved.

- **`resonanceAbsolute` / `resonanceControl` split throughout.** One measurement, two views. The
  perception model and every cross-speaker or cross-device comparison read `resonanceAbsolute`;
  the ball, the HUD, the meter, the bulb and the haptics read `resonanceControl`. Both are
  **`null`** on a frame that produced no reading, never 0 — 0 is a real position on either axis
  and a suppressed frame is not that.
- **The session card is the one place §4 and §6 pull opposite ways, and the resolution is
  recorded rather than fudged.** §4 puts "cross-session progress" on absolute, correctly: control
  moves whenever the span does, so a user who recalibrates between Tuesday and Friday would
  otherwise see progress that is entirely the new span. §6 says the user sees one ring, and the
  end-of-session card is the same surface. So the session accumulates **both** — the statistic is
  absolute, versioned and scale-tagged; the number on the card is the plain mean of **control**,
  the scale the ring showed while they were speaking. Showing an absolute number would put an
  axis the user has never seen on screen with nothing to compare it to, because *this app does
  not persist a session history to compare against*. When it does, the absolute accumulator and
  `resonanceV2Summary()`'s speech mode are what it reads.
- **Control is defined on frame one.** Before calibration it normalises against a
  **population span** built entirely from published numbers: P&B's adult-male and adult-female
  *pooled* dispersions on the absolute axis (0.4607 and 0.5482) each extended outward by half the
  mean within-speaker across-vowel excursion (0.0680), giving **[0.3927, 0.6162]**. By
  construction each published mean lands half an excursion inside its end, so an adult male at
  his pooled mean reads **30.4%** and an adult female at hers **69.6%** — the app's two shipped
  default haptic thresholds are 30 and 70, which is arithmetic rather than a fit: the span comes
  from the norms and the defaults predate it. `resonance-metric.test.mjs` recomputes both ends
  from the committed fixture.
- **Guided vowel-set calibration**, replacing the two-step darkest/brightest flow. Five held
  vowels (ə i u æ ɑ) captured as **five separate segments** drive `calibrateLpcCeiling()` — the
  input that method was built for, and the reason it takes segments rather than a flat frame
  list — then three postures (habitual / comfortably brighter / comfortably darker) on the
  Rainbow Passage's opening sentence produce the personal span, **measured after the ceiling is
  applied**. The order is the design: postures measured first would build a span out of readings
  the next frame invalidates.
- **Metric versioning + migration**, versioned from the first write.
- **v1 retired from the display, kept computable.** `resonanceScoreV1` is untouched, its golden
  vectors are untouched, and the eval-harness aggregates are still **0.370 / 0.422** at the two
  operating points.

#### §3.5 was wrong about what exists, and the correction shrinks the migration and grows the build

§3.5 says existing users have "session histories, learned personal ranges, necklace thresholds
and vibration rules". Grepped on `main` before a line of migrator was written:

| §3.5 claims | actually persisted |
|---|---|
| session histories | **nothing.** `this.session` is rebuilt per session and never written to storage |
| learned personal ranges | **nothing.** `analyzer.resonanceProfile` is in-session only — reset in the constructor, in `stop()`, and by the settings reset — and no `localStorage` key ever holds it. It dies with the tab |
| necklace thresholds | the necklace controller reads no resonance at all |
| vibration rules | **yes** — `vox:vibration:v1`, `resonance` defaults "below 30" / "above 70", whitelisted for export in `settings-transfer.js` |
| — | **and one §3.5 misses:** the Wear overlay's own `voxWatch.settings`, same two defaults |

So the migration surface is **two threshold stores**, and the real work is the persistence that
did not exist: `vox:resonance:profile:v1`, carrying the span, the chosen ceiling, the posture
sample counts and a **metric version**, refused rather than coerced when the version does not
match. A returning user's "learned personal range" was not at risk from the metric change — it
was already being thrown away on every reload.

#### Migration: suspend, never rescale

There is no honest function from a v1 threshold to a v2 one. A stored "below 30" was set against
a 17 cm → 14 cm axis *optionally renormalised against a range learned in that session and then
discarded*; version 2's 30 is a position inside a published population span or the speaker's own.
The v1 number depended on state that no longer exists, so rescaling would be inventing the user's
intent. Resonance rules are therefore **suspended**: the threshold is preserved exactly as typed,
the rule stops firing, and the settings panel offers one button to confirm it against the live
number. Every other metric is untouched — none of them changed.

The same rule covers a **span change**: a control threshold is a position inside a span, so a
recalibration that moves the span suspends the rules set against the old one. Spans carry an id
derived from their own numbers, so a recalibration that lands in the same place re-prompts for
nothing.

**The mis-fire, measured** (`npm run report:resonance-two-scale`). Two synthesized speakers, each
sweeping the same published posture excursion, **uncalibrated** — which is the state every user
is in on every reload, because v1's learned range was never persisted. Each shipped default rule
replayed frame by frame against v1 and against control:

| speaker | rule | frames | v1 median | control median | fires on v1 | fires on control | **verdicts differ** | fires now |
|---|---|---|---|---|---|---|---|---|
| LONG | below 30 | 555 | 52.1 | 12.7 | 65 | 539 | **474 (85.4%)** | **0** |
| LONG | above 70 | 555 | 52.1 | 12.7 | 53 | 0 | 53 (9.5%) | **0** |
| SHORT | below 30 | 527 | 49.8 | 65.3 | 46 | 0 | 46 (8.7%) | **0** |
| SHORT | above 70 | 527 | 49.8 | 65.3 | 67 | 182 | 147 (27.9%) | **0** |

On 85.4% of frames in the worst case, the same stored rule buzzes on one metric and stays silent
on the other. After migration it fires **0** times on any of them, and every threshold comes
through unaltered (30 and 70).

#### Two speakers with different absolute ranges

Built rather than found, because the claim is about vocal tract length and the fixtures contain
one speaker. Both numbers are published: the tracts are P&B's adult-male formant set scaled in
frequency (k = 0.92, a tract ~9% longer; k = 1.18, ~15% shorter), and both sweep the **same**
excursion — §1.5's GAVT outcome, F2 1847 → 1961 Hz (+6.2%), applied in each direction — so the
only thing that differs between them is size.

| | absolute range over all postures | v1 at darkest → brightest | control | absolute |
|---|---|---|---|---|
| LONG | **0.387 – 0.474** | 29.7% → 73.0% | 4.5% → 95.5% | 39.7% → 44.8% |
| SHORT | **0.507 – 0.578** | 27.7% → 74.8% | 4.5% → 95.5% | 51.4% → 57.3% |

**The two ranges are disjoint.** The "BEFORE" column is v1 after the app's *own* guided resonance
calibration — the flow this phase replaces, which takes the medians of the two deliberate
postures as the ends and pads 5%, so a speaker reads at or near the top of the meter at their own
brightest whatever their tract is. The two speakers land **1.8 points apart** there.

Read the criterion carefully, because the obvious reading of it is wrong. Control puts both
speakers at 95.5% at their own brightest, and *that is what control is for* — it is not the
defect §2.7 names. The defect is that a personally-normalised number was **also feeding the
perception model**, so two different vocal tracts produced the same score:

| gap between the two speakers at their own brightest | before | after |
|---|---|---|
| the displayed number | 1.8 pts (v1) | 0.0 pts (control) — by design |
| the number the perception model reads | 1.8 pts (v1) | **12.5 pts (absolute)** |
| the perceived-gender score itself | **0.008** | **0.069** |

#### What the user sees when there is no reading — and the premise was wrong

v1 always had a number; v2 can be absent, and 11.4% of clean read speech is suppressed. The brief
for this phase called that "a ring that blinks out for one frame in nine". **Measured, it is not.**
Those frames are not scattered:

| condition | suppressed | runs | run lengths (frames) | singletons | median run | longest |
|---|---|---|---|---|---|---|
| clean, 30 fps | 11.4% | **3** | 14, 4, 3 | **0** | 133 ms | 467 ms |
| clean, 60 fps | 4.5% | 2 | 13, 1 | 1 | 217 ms | 217 ms |
| +noise, 12 dB | 36.9% | 5 | 34, 13, 6, 3, 3 | 0 | 200 ms | 1133 ms |

The app does not flicker. It declines in contiguous stretches of 100 ms to 1.1 s — pool warm-up
and the pauses between phrases, exactly what §5's Phase 3 entry said collapsed. That measurement
is what sets the design:

- **The number blanks immediately.** The windowed average stops being fed on the first suppressed
  frame, so the HUD readout goes to "—" with no ramp at all. Nothing numeric is ever shown stale.
- **The meter's position indicator fades out** rather than parking. A greyed marker still sitting
  at 62% is a position claim and there is no position to claim.
- **The ring relaxes into a neutral listening ring** — fixed radius, no hue travel, no width
  travel, encoding nothing — over 90 ms, which is shorter than the shortest measured decline, so
  every real one completes the transition. For at most those 90 ms the ring is still partly where
  the last reading put it. That is stated rather than hidden: it is the difference between a ring
  that relaxes and one that cuts out, and a cut reads as a fault in the app rather than as an
  absence of signal. Both ramps are in seconds and integrated against the real frame interval,
  not per-frame coefficients.

#### What displaying v2 costs, on the same fixture

| condition | yield v1 | yield v2 | across-clip swing v1 | v2 | p05–p95 v1 | v2 | median frame-to-frame step v1 | v2 |
|---|---|---|---|---|---|---|---|---|
| clean, 30 fps | 100% | **88.6%** | 0.387 | 0.194 | 0.294 | 0.142 | 0.0013 | **0.0000** |
| clean, 60 fps | 100% | **95.5%** | 0.497 | 0.289 | 0.473 | 0.239 | 0.0016 | **0.0000** |
| +noise, 12 dB | 100% | **63.1%** | 0.273 | 0.062 | 0.260 | 0.062 | 0.0025 | **0.0000** |

v1's yield is 100% by construction — it is an EMA that cannot be absent, which is precisely the
property that let it show a number built on a fabricated formant. **The cost is 11.4 points of
yield on clean read speech and 36.9 at 12 dB.** What it buys is on the other three columns:
across-clip swing roughly halves, the p05–p95 band halves, and the median frame-to-frame step is
**zero** — the displayed number is pooled over a rolling window and does not move at all between
most adjacent frames, where v1 moved on every one. *Displaying v2 does not cost stability. It
costs availability, and it buys stability.*

#### The budget after v1 retires (§3.4)

The second LPC solve existed only because v1's displayed output had to stay byte-identical while
the canonical path used a per-user ceiling. v1 is no longer displayed, so its `lpc` branch reads
the canonical solve and the duplication is gone. Measured on 3 s of held vowel:

| case | Phase 3 | Phase 4 |
|---|---|---|
| `lpc`, default ceiling — every uncalibrated user | 0.994 | **1.000** |
| `lpc`, per-user ceiling (post-calibration) | **1.989** | **1.000** |
| v1 forced onto `harmonic` | 0.994 | **1.000** |
| `harmonic` + per-user ceiling | 1.989 | **1.000** |

ms/frame for the whole `update()`: 2.5–2.6 ms, **15–16% of the 16.67 ms frame budget**, against
Phase 3's 4.6–4.7 ms / 28%. (The absolute ms are not comparable across phases — different
machine, different day — but the *ratio between the calibrated and uncalibrated cases* is, and it
has gone from 2× the solves to 1×.)

#### The formant assignment, and /ɝ/ — the answer is not what Phase 3 predicted

Phase 3 handed this over: "the binding constraint is not ρ. It is that the formant assignment has
one policy, shared with v1, that cannot admit a rhotic F3 without admitting spurious ones. Fixing
it needs an assignment v1 no longer constrains — Phase 4." v1 has retired, so it is a measurement
(`npm run report:resonance-assignment`):

| F0 | assignment | /ɝ/ correct | /ɔ/ → /ɝ/ | /ɪ/ → /ɝ/ | all non-rhotic → /ɝ/ | overall correct |
|---|---|---|---|---|---|---|
| 110 | standard | 0% | 0% | 0% | 0% | 86.7% |
| 110 | **rhotic** | **92.5%** | **0%** | **0%** | 0.2% | **96.0%** |
| 130 | standard | 0% | 0% | 0% | 0% | 86.6% |
| 130 | **rhotic** | **25.4%** | **0%** | **0%** | 0.3% | **89.1%** |
| 180 | standard | 0% | 0% | 0% | 0% | 64.5% |
| 180 | **rhotic** | **31.3%** | **0%** | **0%** | 0.2% | **67.5%** |

**It does not manufacture rhotics.** Phase 3 recorded that widening the slot reads "/ɔ/ → /ɝ/ on
47 frames in 67" at F0 180. Used as the *measurement* rather than as Phase 3's ρ-corroborated
detector, false positives are **0%** on both named vowels at every tested F0 and 0.2–0.3% across
all non-rhotic frames, and overall correctness **rises** at every F0. The manufacturing was a
property of the detector, not of the slot.

**It still ships off**, for three reasons, none of which is "it fabricates rhotics":

1. It misses the ≥50% recall criterion at F0 130 (25.4%) and 180 (31.3%). Above 110 the rhotic
   reads as /æ/ rather than /ʊ/ — a different wrong answer, not a right one — so §6's
   confidently-wrong-vowel failure is reduced, not removed.
2. It is not free on ordinary speech: **3.8 points of vowel yield** (85.3% → 81.5%) and **2.1
   points of movement in the mean displayed value** (0.4718 → 0.4507) on the Rainbow Passage.
3. Decisively: every number above is from a Klatt cascade whose /ɝ/ F3 is placed by construction.
   Phase 3's own condition was an assignment v1 no longer constrains — now provided and measured
   — "validated against real rhotic recordings rather than a Klatt cascade, which is Phase 5".
   The remaining blocker is that validation, and half-building Phase 5 to reach it would be worse
   than leaving a measured, exposed, unused option in place.

A fourth variant was considered and abandoned, recorded because the reason is a limit rather than
a preference: restricting the widened slot to poles corroborated by F4 is a physical claim (a
rhotic lowers F3 and leaves F4) and cannot be evaluated here, because the synthesized corpus
places every vowel's F4 at 3.5·ΔF of *that vowel's own* fit — so the synthetic /ɝ/'s F4 has
already been dragged down with its F3 and shows a gap of 1.09·ΔF against the uniform tube's 1.00.
Fixing the fixture is defensible on its own; doing it in order to make a candidate pass is not.

#### Phase 2's d′ recommendation, accepted — and applied asymmetrically

Phase 2 recommended restating the acceptance criterion "against a within-speaker contrast, since
an absolute tract-size axis and a trainable-posture axis should not both be scored on how well
they separate two populations by tract length." Accepted. The split is **not symmetric**:

- **`resonanceAbsolute` keeps the male-vs-female criterion.** It is a tract-size axis, separating
  two populations that differ in tract size is exactly what it claims to do, and d′ 1.73 against
  v1's 0.86 is the claim. Nothing about it is restated, and a test now pins that it still clears
  Phase 1's 1.5 — so the restatement cannot be used to lower a bar.
- **`f2Position` moves to the within-speaker contrast** (§1.5's published GAVT shift), where it
  scores d′ 2.09 / 2.21 against raw F2's 0.16, a margin of 13×. The male-vs-female number
  (0.105 against raw F2's 0.476) is still measured and still asserted, as a **descriptive figure
  with a bound rather than an acceptance gate** — deleting it would hide the axis on which the
  feature is weak, and promoting it back to a gate would require putting tract length back in at
  r = 0.95 with `formantScale`.

#### The span floor, and two wrong values before it

`resonanceControl` normalises against a span, and a span narrower than the measurement's own noise
is not a span — it is a calibration that failed, and normalising against it turns estimator jitter
into display travel. The floor is derived from measurement noise and nothing else. Measured on a
sustained synthesized vowel where the true value is constant by construction, through the live
analyzer:

| SNR | 40 dB | 30 dB | 24 dB | 20 dB | 16 dB | 12 dB |
|---|---|---|---|---|---|---|
| SD of pooled `resonanceAbsolute` | 0.0001 | 0.0085 | 0.0019 | **0.0055** | 0.0158 | 0.0177 |

**Five** of the 20 dB SD — five SD between the two posture medians is a demonstrated difference,
not a coin flip — gives **0.0275**, and the two synthesized speakers' actual posture sweeps
measure 0.051 and 0.059, so it does not bind on a genuine calibration. Both bounds are asserted.

Two earlier values were wrong and both are recorded, because each was a mis-stated expectation
rather than a tuning choice:

| value | why it was wrong |
|---|---|
| 0.127 — one population's across-vowel excursion | the argument was that a deliberate posture change should move a speaker at least as far as changing vowel does. It does not: measured, a posture change moves them **two to four times less**. This floor sat above every real posture excursion and would have bound for every user |
| 0.089 — ten times the pooled scale's scatter on the Rainbow Passage (19.3 Hz) | that number is not measurement noise. The passage is connected speech, so most of its scatter is the speaker genuinely changing vowel. Measured where the true value is *constant*, the noise is three to forty times smaller |

*Done when:* two speakers with different absolute ranges no longer both read 100%; stored readings
carry a version; no hardware threshold fires against a value from a different version. **Met, with
the first criterion met on the axis that compares speakers rather than on the one that shows a
person their own range** — the two speakers' absolute ranges are disjoint (0.387–0.474 against
0.507–0.578) and the perceived-gender score separates them by 0.069 against 0.008 before, while
`resonanceControl` deliberately puts both at 95.5% at their own brightest because that is what it
is for. Stored readings carry a metric version, a scale and a span id; aggregates refuse to mix
them and report how many they refused. No hardware threshold fires against a value from a
different version: measured, the mis-fire reached 85.4% of frames and is now 0. `npm run
test:resonance-two-scale` is the standing check.

### Phase 5 — Validation ladder

| level | establishes | status |
|---|---|---|
| synthetic vowels | algorithmic accuracy | **done** |
| real sustained vowels vs manually checked Praat F1–F4 | formant accuracy | **the next real gap** |
| connected speech | in-use robustness | not started |
| listener ratings | construct validity for perceived gender | research programme, §3.3 |

Stratify by F0, vowel, SNR, device/microphone, breathiness, nasality, loudness, speaker.

### Phase 6 — Port alignment — **C++ LANDED; Kotlin still open**

- **C++ extended from ΔF-only to the scale/pattern split.** `voxFitFormantScale`,
  `voxFormantPatternResiduals`, `voxResidualScaleFactor`, `voxResonanceAbsolute` and
  `voxPoolFormantScale` ported to `hardware/twatch_voxball/` from `dsp-utils.js`, with the
  pooled scale wired into the frame loop and exposed on `VoxResult`.
- **Cross-port golden vectors extended past ΔF to the full feature set.** The same vectors are
  now asserted on all three legs — `dsp-golden.test.mjs`, the T-Watch host test, and the
  necklace host test — including the `Σ L_i·r_i ≡ 1` identity, which is what catches a port
  whose weights are subtly wrong: such a port still reproduces every residual vector and fails
  only there.
- **A third port was found outside the contract entirely.** `hardware/prosody_necklace/` was
  still computing ΔF as `(F3−F1)/2` with an `F2−F1` fallback — the exact bug the contract
  records as fixed — because it had **no host test and no CI job**, so no golden vector ever
  reached it. Fixed, given both, and folded into the shared vectors. Worst measured case: /i/
  with F3 missing returned an apparent tract of **8.7 cm**, pinned at the bright rail, against
  12.3 cm from the fit on the same two formants.

*Still open:* the **Kotlin leg**. `SpectralBrightnessEstimator.kt` remains brightness-primary
(`0.65·formantScore + 0.35·brightness`), fits no ΔF anywhere, and so has no scale to split.
Moving it onto the decomposed model is the D1 debt and needs the Android toolchain to verify —
writing a formant tracker that has never been compiled, let alone run against the golden
vectors, would put the watch in exactly the position the necklace was just found in. It is
named `spectralBrightness` rather than resonance and is excluded from shared statistics, so the
divergence is visible rather than silently miscoaching; that is containment, not a fix.

**What the C++ port does NOT yet do, and why it is not a shortfall to be quietly closed.** The
split is computed on every frame and displayed nowhere: `r.resonance` (v1) still drives the LED,
the haptics and the gender blend on both firmware ports. Two things gate the display switch, and
neither is a porting detail:

1. **The formants underneath it are unmeasured on this path.** Both firmware ports use
   harmonic-envelope peak-picking — a documented approximation tier, no LPC, no F4. The scale
   fit is F3-dominated by design, so its accuracy here is bounded by an F3 nobody has measured
   on this path. Moving the displayed value onto that is the "more valid, less available" trap
   §6 warns about, and Phase 5's validation ladder is what would answer it.
2. **The web app displays `resonanceControl`, not `resonanceAbsolute`.** The absolute axis is
   deliberately shallow — a speaker's whole across-vowel excursion occupies ~14 points — and
   neither firmware port has the personal calibration that restores display travel. Whether the
   watch/necklace haptic threshold belongs on absolute or control is **open question #3**, a
   product call.

So Phase 6 lands the canonical computation and the shared vectors — the part with a contract to
break — and leaves the Layer B display switch to whichever phase answers those two.

---

## 6. Risks

**The measure gets harder to estimate as it gets more valid.** F3/F4 are lower-amplitude and
missed more often than F1/F2 — construct validity and measurement reliability pull opposite ways.
Phase 1's acceptance criteria must include a frame-yield floor, not just d′.

**Measured through Phase 3, and the risk is real but it is not F3/F4.** `formantScale`'s fit
yield has stayed at 98.4% and F4's at 92.4% through three phases. What has fallen is the yield of
the things built *on top* of the formants — the pooled scale 92.4% → 88.6%, `f2Position`
88.0% → 85.3% — and every point of that is the app declining to read a frame rather than failing
to find a formant in it. The trade is stated with its numbers in §5's Phase 3 entry: 2.7 points
of frame yield for a value that no longer depends on which estimator the room's noise selected,
and that clears rather than freezes when there is nothing to measure.

**And now it reaches the user, which is what Phase 4 changed.** Through Phases 1–3 that yield loss
was invisible: v1 was displayed and v1 cannot be absent. With v2 displayed, the risk stops being
an internal statistic and becomes 11.4% of clean read speech with nothing on the ring — and the
number that matters for a UI turned out not to be the percentage. Measured (§5's Phase 4 entry),
those frames are **three contiguous runs of 100–467 ms, with zero singletons**, not a flicker.
The other half of the trade is the same table's right-hand columns: across-clip swing halves and
the median frame-to-frame step of the displayed value is **zero**, against v1's 0.0013. Displaying
v2 costs availability and buys stability.

**Decomposition can leak into the UI.** The user should still see one ring. Five internal
variables is an implementation detail; if it reaches the interface the redesign has failed.

**Held through Phase 4, which is where it was most at risk.** The split is two views of one
measurement, not two meters: the ball, the meter, the bulb and the haptics all read
`resonanceControl` and nothing else, and `formantScale`, `apparentVTL`, `formantPattern`,
`f2Position` and `resonanceConfidence` are still computed, still exposed and still undrawn. The
one interface change is a **third state** on the same ring — a reading, no reading, and the
transition — which is not a second variable but the honest rendering of a metric that can be
absent. The resonance status line, which used to print v1's learned F1 range, now says only
whether the span is the population's or the user's own and how wide it is; it does not print a
tract length, a vowel or an f2Position.

**Existing users' numbers change.** Unavoidable — the current numbers are wrong. Handled by
versioning, not by pretending continuity.

**Done in Phase 4, and §3.5's inventory of what changes was itself wrong.** Two of the four
things it lists as at risk were never persisted at all (§3.5's correction). The one real risk —
a stored haptic threshold reinterpreted against a new metric — is measured rather than asserted:
the same stored rule disagrees with itself across the two metrics on up to **85.4% of frames**,
and after migration it fires **0** times until the user confirms it, with the threshold they
typed preserved verbatim.

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

**Phase 4 decided 1 and 3, because the split makes them unavoidable rather than theoretical.
2 and 4 stay open, with what is now known about each.**

### 1. Should `resonanceControl` remain the default display? — **DECIDED: yes, control.**

Control is the displayed number, and absolute is what the perception model, the session summary
and every cross-speaker or cross-device comparison read. Three reasons, in order of weight:

1. **Absolute cannot be a display axis without a dishonest gain.** It puts a whole adult
   population inside about 22 points (P&B's two pooled means are 46.1 and 54.8) and one speaker's
   entire across-vowel excursion occupies 14.5 of them. A meter on that axis barely moves when
   the user does the thing they are practising. Steepening it is exactly what §5's Phase 1 entry
   refused — an absolute scale steep enough to put /i/ and /u/ from one mouth at opposite ends is
   v1's defect rebuilt.
2. **The two speakers make the alternative concrete.** Measured (§5's Phase 4 entry): sweeping
   the same published posture excursion, the LONG speaker travels 39.7% → 44.8% on absolute and
   4.5% → 95.5% on control. A five-point ball is not a biofeedback instrument.
3. **"Once the calibration is good enough to trust" turns out not to be the axis of the
   question.** Control is not less trustworthy than absolute; it is the *same* measurement
   expressed against a span. What calibration buys is that the span is the user's own instead of
   the population's — and until it is, control is still defined, on published ends, so the ball
   works out of the box.

The cost, stated: control is not comparable between people or across a recalibration. That is
why absolute exists, why stored readings carry a span id, and why §3.5's machinery treats a span
change exactly as it treats a version change.

### 2. Is F4 worth its miss rate? — **still open, and Phase 4 did not move it.**

Unchanged since Phase 2: F4's yield is 92.4% against F1–F3's 98.4%, it sharpens `formantScale`
and it does not reach the vowel classifier (`VOWEL_TEMPLATE_FORMANTS` pins that at three, because
P&B published no F4 and normalising a 4-element residual against 3-formant templates cost 47
points of yield when it was live). The question needs a *measured* r₄, which is Phase 5's to
provide. Phase 4 adds one datum against dropping it: the F3–F4 gap is the natural discriminator
for a rhotic F3, and it could not be evaluated here only because the synthesized corpus places F4
from each vowel's own fit rather than the speaker's.

### 3. Does the haptic threshold belong on absolute or control? — **DECIDED: control.**

Both halves of the original framing are true; the tie is broken by what a haptic *is* — an
instruction to move, fired while the user is speaking and cannot look at a screen.

1. **On absolute the shipped defaults are unreachable for most people.** "Buzz below 30" on an
   axis where a whole adult population sits inside 22 points would never fire for a great many
   speakers and would fire permanently for the rest. A threshold that cannot be crossed is not a
   coaching signal.
2. **D1's cross-surface argument is satisfied by the span, not by the axis.** D1 objects to
   "resonance 50%" meaning VTL on the desktop and brightness on the watch — a different
   *quantity* per device. Control is the same quantity everywhere; what it needs in order to
   travel identically is the same *span* everywhere, which is why the calibrated profile is
   persisted and whitelisted for export alongside the rules that depend on it. A rule and the
   span it was set against travel together or neither does.
3. **Control is defined on frame one**, so a fresh install has working haptics with defensible
   ends rather than an inert feature and a nag screen.

The cost, stated: a control threshold means something different after a recalibration. That is
§3.5's machinery doing its job — the span has an id, a stored reading records which span it was
taken on, and a rule set against a superseded span is re-prompted rather than reinterpreted.

### 4. What replaces the five-tier descriptor? — **still open, and deliberately untouched.**

Phase 4 changed *what* the one ring shows and not *how many* things it shows. §6's risk is
explicit — "if the decomposition reaches the interface the redesign has failed" — and a two-scale
metric is not permission for two meters, so `formantScale`, `apparentVTL`, `formantPattern`,
`f2Position` and `resonanceConfidence` remain internal and undrawn. The one interface change is
that the ring now has a **third state**: a reading, no reading, and the transition between them
(§5's Phase 4 entry). Answering this question properly needs the Phase 5 validation to say which
of the internals is trustworthy enough to earn a place, and inventing a 2D map before that would
be drawing a picture of numbers nobody has validated on a real voice.
