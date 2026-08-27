// Two scales, one ring, and a version on every stored number.
//
// docs/RESONANCE_REDESIGN.md §4 ("Three values, never collapsed"), §3.5 (migration) and §5's
// Phase 4 entry. This module owns the three things Phase 4 adds that are not DSP:
//
//   1. `resonanceControl` — where a reading sits inside a SPAN. Pure arithmetic, no state.
//   2. The versioned persistence §3.5 requires, which as of Phase 3 did not exist at all
//      (see the header comment on RESONANCE_PROFILE_KEY).
//   3. The migration rule for threshold-based hardware: a stored threshold set against one
//      metric version never fires against another.
//
// It is deliberately separate from dsp-utils.js. Nothing here is a measurement — it is the
// bookkeeping around one, and mixing the two is how a storage schema ends up inside a golden
// vector.

// --- The metric version -----------------------------------------------------------------
//
// v1 = `smoothResonance`: vtlScore·0.55 + f1Score·0.25 + f2Score·0.20 over 17 cm → 14 cm
//      anchors, optionally renormalised against an in-session learned personal range.
// v2 = `resonanceAbsolute` (ΔF_scale / 2ΔF_ref) and `resonanceControl` (that value inside a
//      calibrated personal span). Both are version 2: they are two VIEWS of one measurement,
//      not two metrics, so a reading records which SCALE it is on separately from which
//      version produced it.
//
// The version is bumped when the arithmetic that produces the number changes in a way that
// makes an old stored number mean something different. It is NOT bumped when a user
// recalibrates — that changes the span, which is tracked by `spanId` below, because the two
// have different remedies: a version change needs a re-prompt, a span change needs a rescale.
export const RESONANCE_METRIC_VERSION = 2;
export const RESONANCE_METRIC_VERSION_V1 = 1;

// The two scales a version-2 reading can be on. A stored reading carries both, because
// "resonance 62%" is meaningless without knowing which axis it is 62% of.
export const RESONANCE_SCALE_ABSOLUTE = 'absolute';
export const RESONANCE_SCALE_CONTROL = 'control';

// --- The population span ------------------------------------------------------------------
//
// What `resonanceControl` normalises against BEFORE the user has calibrated. §7's question 1
// is answered in the docs; the arithmetic consequence is here: control has to be defined on
// frame one, because the ball, the HUD and the haptics all read it and a fresh install has no
// personal span.
//
// Every number in it is a published one. The ends are Peterson & Barney's adult-male and
// adult-female POOLED upper-formant-weighted dispersions expressed on the absolute axis
// (0.4607 and 0.5482 — ΔF 993.3 and 1181.8 Hz over the §1.1 seven-vowel set), each extended
// outward by HALF the mean within-speaker across-vowel excursion on the same axis (0.0680), so
// that a speaker sitting exactly at one population's mean does not rail when they produce that
// population's most extreme vowel.
//
// Two consequences worth stating rather than discovering later:
//
//   - By construction each published mean lands exactly half an excursion inside its end, so an
//     adult male at his pooled mean reads 30.4% and an adult female at hers reads 69.6%. The
//     app's shipped default haptic rules are "below 30" and "above 70". That is arithmetic, not
//     a coincidence and not a fit: the span was built from the norms and the defaults were
//     picked years earlier. Nothing here was moved to meet them.
//   - This is a POPULATION axis, so a speaker whose apparent tract is longer than any adult in
//     P&B reads 0 and stays there. That is the correct behaviour for "where are you among adult
//     speakers" and the wrong behaviour for "where are you inside your own range", which is
//     exactly why calibration exists and why the UI says so.
//
// resonance-metric.test.mjs recomputes both ends from the committed P&B fixture, so they cannot
// drift away from the norms they claim to come from.
export const RESONANCE_POPULATION_SPAN = Object.freeze({
  min: 0.3927,
  max: 0.6162,
  source: 'population',
  metricVersion: RESONANCE_METRIC_VERSION,
  spanId: 'population/pb1952',
});

// --- The floor on a calibrated span -----------------------------------------------------------
//
// The floor exists for exactly one failure: a user who produced the SAME posture twice and now
// has a "range" made of measurement noise. Normalising against that turns estimator jitter into
// display travel. So the floor is derived from the measurement's own noise, and from nothing
// else — it is not a statement about vocal tracts.
//
// MEASURED, on a sustained synthesized vowel where the true value is constant by construction,
// through the live analyzer (tools/resonance-two-scale.mjs re-measures all of it):
//
//   SNR      40 dB    30 dB    24 dB    20 dB    16 dB    12 dB
//   SD       0.0001   0.0085   0.0019   0.0055   0.0158   0.0177
//
// 20 dB is the operating point the floor is set at: it is a realistic quiet-room calibration
// rather than an ideal one, and the app's SNR gate already suppresses the reading well before
// the noise reaches the 16 dB column. FIVE of those SDs separate the two posture medians —
// unambiguously a real difference, not a coin flip — which gives 0.0275.
//
// The other half of the check is that the floor must NOT bind on a genuine calibration. A
// synthesized speaker sweeping the published GAVT training shift in each direction moves
// 0.05-0.07 on this axis, roughly twice the floor. Both bounds are asserted.
//
// THE FIRST TWO VALUES WERE WRONG AND BOTH CORRECTIONS ARE RECORDED, because each was a
// mis-stated expectation rather than a tuning choice:
//
//   0.127 — one published population's across-vowel excursion, on the argument that a
//     deliberate posture change should move a speaker at least as far as changing vowel does.
//     Measured, it does not: a posture change moves them two to four times LESS. This floor sat
//     above every real posture excursion, so it would have bound for every user and compressed
//     the ball's travel for all of them — the opposite of what the floor is for.
//   0.089 — ten times the pooled scale's scatter on the Rainbow Passage (19.3 Hz, Phase 1).
//     That number is not measurement noise: the passage is connected speech, so most of its
//     scatter is the speaker genuinely changing vowel. Measuring the noise where the true value
//     is CONSTANT gives a figure three to forty times smaller depending on SNR.
export const RESONANCE_POOLED_SCALE_SD_20DB = 0.0055;
export const RESONANCE_CONTROL_MIN_SPAN = 5 * RESONANCE_POOLED_SCALE_SD_20DB;   // 0.0275

// --- The across-vowel allowance -------------------------------------------------------------
//
// Half the mean within-speaker across-vowel excursion on the absolute axis. RESONANCE_POPULATION_SPAN
// above is built by extending each published mean outward by exactly this, and its comment gives
// the reason: "so that a speaker sitting exactly at one population's mean does not rail when they
// produce that population's most extreme vowel."
//
// THE PERSONAL SPAN DID NOT HAVE IT, AND THAT WAS A BUG. Found by a user, immediately after they
// took this app's own advice to calibrate: the voice-map firefly began slamming into the left and
// right edges. spanFromPostures sized the span from the POSTURE excursion alone and padded it by
// 5% of that — about 0.3 points — while the value poured through it moves far more than that from
// vowel identity alone. Measured on the live analyzer, one speaker holding four vowels in turn:
//
//   /i/ 0.5470   /ɛ/ 0.4667   /ɑ/ 0.4555   /u/ 0.4015     -> 14.5 points of travel
//
// Pooling does not save it, because a SUSTAINED hold collapses the pooling window onto the one
// vowel being held (the Phase 2 finding), and holding a vowel is exactly what the voice map
// invites. Against spans of each width, how many of those four rail:
//
//   floored span      3.0 pts   3 of 4 rail
//   typical span      6.6 pts   2 of 4 rail      <- what calibration produced
//   population span  22.3 pts   0 of 4 rail      <- what they had BEFORE calibrating
//
// So calibrating made the display worse, which is the opposite of what calibration is for.
export const RESONANCE_ACROSS_VOWEL_HALF_EXCURSION = 0.0680;

// --- resonanceControl ---------------------------------------------------------------------
//
// Returns null, not 0, when there is nothing to report. A suppressed frame has no absolute
// value; 0 is a real position on this axis and means "as dark as the span goes", which is a
// completely different statement. Everything downstream (ring, meter, haptics) tests for null.
export function resonanceControl(absolute, span = RESONANCE_POPULATION_SPAN) {
  if (absolute == null || !Number.isFinite(absolute)) return null;
  if (!span || !Number.isFinite(span.min) || !Number.isFinite(span.max)) return null;
  const width = span.max - span.min;
  if (!(width > 0)) return null;
  const t = (absolute - span.min) / width;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Build a personal span from the guided calibration's posture samples. `postures` is
// { habitual: [...absolute readings], brighter: [...], darker: [...] } — the medians of the two
// DELIBERATE extremes are the ends, exactly as rangeFromExtremeSamples treats the old two-step
// flow, because the user produced them on purpose. `habitual` does not set an end; it is
// recorded so a later session can tell "the user's range moved" from "the user is having a
// dark day", and so the span can be sanity-checked (a habitual posture outside the two extremes
// means the extremes were not extremes).
// `vowelExcursion` is THIS SPEAKER's measured across-vowel travel on the absolute axis, from the
// vowel-set holds the calibration already captures for the ceiling search. Passing it makes the
// allowance personal rather than published, which matters because the excursion is a property of
// the speaker's own vowel space: a 14.5-point speaker and a 22-point speaker need different room.
// It falls back to the published half-excursion when the measurement is unavailable — that is
// still the population span's own construction, and still far better than the 5% pad this
// replaced.
export function spanFromPostures(postures, {
  minSpread = RESONANCE_CONTROL_MIN_SPAN, pad = 0.05, vowelExcursion = null,
} = {}) {
  const med = (xs) => {
    const s = (Array.isArray(xs) ? xs : []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!s.length) return null;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  let lo = med(postures && postures.darker);
  let hi = med(postures && postures.brighter);
  const habitual = med(postures && postures.habitual);
  if (lo == null || hi == null) return null;
  // Swap-guard: the labels are the user's intent, the numbers are the measurement, and a
  // speaker who produces a brighter "darker" posture is telling us about their control, not
  // about the axis. Ordering by measurement keeps the span monotone either way.
  const swapped = lo > hi;
  if (swapped) { const t = lo; lo = hi; hi = t; }
  const observed = hi - lo;
  const spread = Math.max(minSpread, observed);
  const mid = (lo + hi) / 2;
  const half = spread / 2;
  // The span has to hold two different things at once: the posture range the user demonstrated,
  // and the vowel-driven movement that will pour through it while they simply speak. `spread`
  // covers the first. `allowance` covers the second, and without it the meter rails on ordinary
  // vowels — see RESONANCE_ACROSS_VOWEL_HALF_EXCURSION for the measurement that caused it.
  // A measured excursion is max-minus-min over a handful of held vowels, which is robust within
  // each vowel (its own median) but NOT robust to one vowel whose formants were mis-tracked
  // outright. An inflated excursion does not rail the meter — it does the opposite, flattening
  // the axis until nothing moves — so it is capped rather than trusted without limit. Twice the
  // published excursion is the bound: wider than any speaker measured here, and narrow enough
  // that one bad vowel cannot take the ball's travel away.
  const measured = Number.isFinite(vowelExcursion) && vowelExcursion > 0;
  const allowance = measured
    ? Math.min(vowelExcursion, 4 * RESONANCE_ACROSS_VOWEL_HALF_EXCURSION) / 2
    : RESONANCE_ACROSS_VOWEL_HALF_EXCURSION;
  // The 5% pad stays on top of the allowance. It is a different job: a hair of headroom so a
  // posture reproduced slightly harder than it was calibrated does not sit exactly on the rail.
  return {
    min: Math.max(0, mid - half - allowance - spread * pad),
    max: Math.min(1, mid + half + allowance + spread * pad),
    habitual,
    observedSpread: observed,
    vowelExcursion: measured ? vowelExcursion : null,
    vowelAllowance: allowance,
    vowelAllowanceSource: measured ? 'measured' : 'published',
    // True when the floor did the work rather than the speaker — the span is real but it is the
    // minimum one, and the UI should say the postures were close together rather than pretend
    // a wide range was demonstrated.
    spreadFloored: observed < minSpread,
    postureOrderSwapped: swapped,
    source: 'calibrated',
    metricVersion: RESONANCE_METRIC_VERSION,
  };
}

// --- Versioned persistence ------------------------------------------------------------------
//
// §3.5 says existing users have "session histories, learned personal ranges, necklace thresholds
// and vibration rules" and that changing the metric silently invalidates all of it. Two of those
// four do not exist. Grepped on main before this module was written:
//
//   - No persisted session history. `this.session` is rebuilt per session and never written to
//     storage; `sess.resonanceSum` dies with the tab.
//   - No persisted resonance profile. `analyzer.resonanceProfile` is in-session only — it is
//     reset in the constructor, in stop(), and by the settings "reset" button, and no
//     localStorage key ever holds it. The learned personal range is gone on reload.
//   - Vibration rules ARE persisted, at `vox:vibration:v1`, and include a `resonance` metric
//     with defaults "below 30" / "above 70". They are also whitelisted for export in
//     settings-transfer.js, so they travel between devices.
//   - The Wear overlay persists its own rules at `voxWatch.settings`, same two defaults.
//
// So the migration surface is the two threshold stores, and the real work is the persistence
// that does not exist yet — which is this. It is versioned from the first write rather than
// retrofitted, which is the whole lesson of §3.5.
export const RESONANCE_PROFILE_KEY = 'vox:resonance:profile:v1';   // v1 = STORAGE SCHEMA, not metric

// A stored profile is what a reading needs to be interpretable later: which metric version
// produced it, which span it was normalised against, and enough provenance to re-prompt
// intelligently rather than just discarding it.
export function makeResonanceProfile({
  span = null, ceilingHz = null, calibratedAt = null, postureSamples = null, phraseAbsolute = null,
} = {}) {
  const id = spanIdFor(span, calibratedAt);
  return {
    schema: 1,
    metricVersion: RESONANCE_METRIC_VERSION,
    spanId: id,
    span: span ? { min: span.min, max: span.max } : null,
    spanSource: span ? (span.source || 'calibrated') : null,
    spreadFloored: span ? span.spreadFloored === true : false,
    habitualAbsolute: span && Number.isFinite(span.habitual) ? span.habitual : null,
    observedSpread: span && Number.isFinite(span.observedSpread) ? span.observedSpread : null,
    // Kept for the same reason observedSpread is: a later calibration can tell "this speaker's
    // vowel space widened" from "the measurement failed and we used the published figure".
    vowelExcursion: span && Number.isFinite(span.vowelExcursion) ? span.vowelExcursion : null,
    vowelAllowanceSource: span ? (span.vowelAllowanceSource || null) : null,
    ceilingHz: Number.isFinite(ceilingHz) ? ceilingHz : null,
    calibratedAt: calibratedAt || null,
    postureSamples: postureSamples || null,
    phraseAbsolute: Number.isFinite(phraseAbsolute) ? phraseAbsolute : null,
  };
}

// The span's identity, so a threshold set against one calibration can tell that a LATER
// calibration moved the ground under it. Deliberately derived from the span's own numbers
// rather than from a counter: two calibrations that produced the same span are the same span,
// and re-prompting for a recalibration that changed nothing is noise.
export function spanIdFor(span, calibratedAt = null) {
  if (!span || !Number.isFinite(span.min) || !Number.isFinite(span.max)) return null;
  return `${span.source || 'calibrated'}/${span.min.toFixed(4)}-${span.max.toFixed(4)}`
    + (calibratedAt ? `@${String(calibratedAt).slice(0, 10)}` : '');
}

export function serializeResonanceProfile(profile) {
  return JSON.stringify(makeResonanceProfile({
    span: profile && profile.span
      ? { ...profile.span, source: profile.spanSource, spreadFloored: profile.spreadFloored,
          habitual: profile.habitualAbsolute, observedSpread: profile.observedSpread,
          vowelExcursion: profile.vowelExcursion, vowelAllowanceSource: profile.vowelAllowanceSource }
      : null,
    ceilingHz: profile && profile.ceilingHz,
    calibratedAt: profile && profile.calibratedAt,
    postureSamples: profile && profile.postureSamples,
    phraseAbsolute: profile && profile.phraseAbsolute,
  }));
}

// Parsing is where the version is enforced, not at read time by whoever happens to remember.
// A profile from a FUTURE metric version is refused rather than coerced: this build cannot know
// what its span means, and normalising against it would be the silent reinterpretation §3.5
// forbids. A profile from an OLDER metric version is also refused, for the same reason, and
// reported so the caller can re-prompt.
export function parseResonanceProfile(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return { profile: null, reason: 'unparseable' }; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { profile: null, reason: raw == null ? 'absent' : 'not-an-object' };
  }
  const storedVersion = Number.isFinite(value.metricVersion) ? value.metricVersion : RESONANCE_METRIC_VERSION_V1;
  if (storedVersion !== RESONANCE_METRIC_VERSION) {
    return {
      profile: null,
      reason: storedVersion > RESONANCE_METRIC_VERSION ? 'metric-version-newer' : 'metric-version-older',
      storedVersion,
    };
  }
  const span = value.span;
  const spanOk = span && Number.isFinite(span.min) && Number.isFinite(span.max)
    && span.max - span.min >= RESONANCE_CONTROL_MIN_SPAN * 0.5
    && span.min >= 0 && span.max <= 1;
  if (!spanOk) return { profile: null, reason: 'span-unusable', storedVersion };
  return {
    profile: makeResonanceProfile({
      span: {
        min: span.min, max: span.max, source: value.spanSource || 'calibrated',
        spreadFloored: value.spreadFloored === true,
        habitual: Number.isFinite(value.habitualAbsolute) ? value.habitualAbsolute : null,
        observedSpread: Number.isFinite(value.observedSpread) ? value.observedSpread : null,
        vowelExcursion: Number.isFinite(value.vowelExcursion) ? value.vowelExcursion : null,
        vowelAllowanceSource: value.vowelAllowanceSource || null,
      },
      ceilingHz: value.ceilingHz,
      calibratedAt: value.calibratedAt,
      postureSamples: value.postureSamples,
      phraseAbsolute: value.phraseAbsolute,
    }),
    reason: 'ok',
    storedVersion,
  };
}

// --- Readings, and the rule that aggregates never mix versions -----------------------------
//
// §3.5's second sentence. A reading is a value plus the two things needed to interpret it: the
// metric version, and which of the two scales it is on. A session summary that averaged a
// version-1 number with a version-2 one would be averaging two different quantities and
// reporting the result as progress.
export function makeReading(value, {
  scale = RESONANCE_SCALE_CONTROL, metricVersion = RESONANCE_METRIC_VERSION, spanId = null, at = null,
} = {}) {
  return { value, scale, metricVersion, spanId, at };
}

// Returns { mean, n, version, scale, rejected } — and `rejected` is not a warning, it is the
// count of readings this aggregate REFUSED. Mixing is not resolved by picking a winner; the
// caller is told what was left out so it can say "3 of your last 40 readings were taken on an
// older scale and are not in this average" rather than quietly folding them in.
export function aggregateReadings(readings, {
  metricVersion = RESONANCE_METRIC_VERSION, scale = RESONANCE_SCALE_CONTROL, spanId = null,
} = {}) {
  const list = Array.isArray(readings) ? readings : [];
  let sum = 0, n = 0, rejected = 0;
  for (const r of list) {
    if (!r || !Number.isFinite(r.value)) { rejected++; continue; }
    if (r.metricVersion !== metricVersion || r.scale !== scale) { rejected++; continue; }
    // A control reading is only comparable to another control reading taken against the SAME
    // span. Absolute readings have no span and are comparable across everything, which is the
    // entire reason §4 keeps them.
    if (scale === RESONANCE_SCALE_CONTROL && spanId != null && r.spanId !== spanId) { rejected++; continue; }
    sum += r.value; n++;
  }
  return { mean: n ? sum / n : null, n, rejected, metricVersion, scale, spanId };
}

// --- Threshold migration -------------------------------------------------------------------
//
// §3.5: "Threshold-based rules and hardware calibration are migrated or re-prompted, never
// silently reinterpreted." For resonance there is no honest migration. A stored "below 30" was
// set against v1, whose 30 is a position on a 17 cm → 14 cm apparent-tract axis optionally
// renormalised against a range learned in that session and thrown away at reload. Version 2's
// 30 is a position inside the adult population span, or inside the speaker's own calibrated
// one. There is no function from the first to the second — the v1 number depended on state that
// no longer exists — so rescaling would be inventing the user's intent.
//
// So resonance rules are SUSPENDED, not converted and not deleted: the threshold the user chose
// is kept exactly as they typed it, the rule stops firing, and the caller is handed the list to
// re-prompt with. Every other metric (pitch in Hz, energy, bounce, …) is untouched — none of
// them changed — which is why this takes the whole rule list rather than only the resonance
// ones: a migrator that its caller has to pre-filter is a migrator that will one day be called
// with the wrong filter.
export const RESONANCE_RULE_METRICS = new Set(['resonance']);

// `spanId` is the span the app is CURRENTLY normalising against. Pass it and a rule set
// against a different span is suspended too — a control threshold is a position inside a span,
// so a rule that outlives its span is exactly as un-interpretable as one that outlives its
// metric version. This is the case a settings import creates: rules and profile are exported
// together, but either can arrive without the other. Omit it to check versions only.
export function migrateResonanceRules(rules, {
  metricVersion = RESONANCE_METRIC_VERSION, spanId = undefined,
} = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const needsReprompt = [];
  const migrated = list.map((rule) => {
    if (!rule || !RESONANCE_RULE_METRICS.has(rule.metric)) return rule;
    const ruleVersion = Number.isFinite(rule.metricVersion) ? rule.metricVersion : RESONANCE_METRIC_VERSION_V1;
    const versionOk = ruleVersion === metricVersion;
    // A rule with no recorded span predates span tracking, so it cannot be shown to belong to
    // this one. It is only checked when the caller supplied a span to check against.
    const spanOk = spanId === undefined || rule.spanId === spanId;
    // An EXISTING suspension is never cleared here, even if this call's checks pass — a caller
    // that omitted `spanId` would otherwise un-suspend a rule suspended for a span change, and
    // "the migrator cleared it" is exactly the silent reinterpretation §3.5 forbids.
    // confirmResonanceRule is the only thing that clears one, and it needs a human.
    if (versionOk && spanOk && rule.suspended !== true) return { ...rule, metricVersion };
    const suspended = {
      ...rule,
      metricVersion: ruleVersion,
      // `enabled` is the user's setting and is left alone. `suspended` is ours, and it is what
      // the fire path tests — so re-confirming a rule is one flag flip and does not have to
      // guess whether the user had switched it off for their own reasons.
      suspended: true,
      suspendedReason: versionOk ? `span-${rule.spanId == null ? 'unknown' : 'changed'}` : `metric-version-${ruleVersion}`,
    };
    needsReprompt.push(suspended);
    return suspended;
  });
  return { rules: migrated, needsReprompt, migrated: needsReprompt.length };
}

// The single question the fire path asks. Kept here, next to the migration that sets the flag,
// so there is one definition of "may this rule fire" rather than one per surface (phone ball,
// watch overlay, necklace) — the divergence D1 exists to prevent.
export function ruleMayFire(rule, { metricVersion = RESONANCE_METRIC_VERSION } = {}) {
  if (!rule || rule.enabled === false) return false;
  if (!RESONANCE_RULE_METRICS.has(rule.metric)) return true;
  if (rule.suspended === true) return false;
  const ruleVersion = Number.isFinite(rule.metricVersion) ? rule.metricVersion : RESONANCE_METRIC_VERSION_V1;
  return ruleVersion === metricVersion;
}

// Confirming a suspended rule: the user has looked at the number on the new scale and said this
// threshold is still what they want. That is the ONLY thing that clears a suspension — there is
// no code path that clears it on the user's behalf.
export function confirmResonanceRule(rule, { metricVersion = RESONANCE_METRIC_VERSION, threshold = null } = {}) {
  if (!rule) return rule;
  const next = { ...rule, metricVersion, suspended: false };
  delete next.suspendedReason;
  if (Number.isFinite(threshold)) next.threshold = threshold;
  return next;
}

// ============================================================================
// TELLING THE USER THE AXIS MOVED (§3.5)
//
// §3.5: "Threshold-based rules and hardware calibration are migrated or re-prompted, never
// silently reinterpreted." `migrateResonanceRules` above does that for haptic rules. THE SPAN
// ITSELF HAD NO SUCH PATH, and that is the gap this closes.
//
// The gap, reported by a user and reproduced: v1 learned a personal range AUTOMATICALLY after
// ~6 s of voicing, every session, with no calibration step and nothing to opt into. Phase 4
// replaced that with a guided calibration that has to be run deliberately, and offered no
// migration — so an existing user who simply updated landed on the POPULATION span without
// being told. That span is the published adult range, so a speaker mid-transition is squeezed
// into its bottom third and reads 0 below it. Their whole session goes dark at once.
//
// The measurement is not wrong in that state and this does not change it. What was wrong is
// that nobody said so. The only thing the app offered was a passive status line.
//
// This is deliberately NOT shown to a first-time user: nothing was reinterpreted for them, the
// population span is the honest default for a voice the app has never heard, and onboarding
// already covers calibration. The notice exists for people whose numbers MOVED.
export const RESONANCE_NOTICE_KEY = 'vox:resonance:spanNoticeAck:v1';

// Parse reasons that mean "a profile was there and could not be used". Distinguished from
// 'absent' because they are different messages: one is "your calibration was refused", the
// other is "you never made one".
const PROFILE_REFUSED_REASONS = new Set([
  'metric-version-older', 'metric-version-newer', 'span-unusable', 'unparseable', 'not-an-object',
]);

// Evidence that this install has been used before. Any one of these keys means the app has
// held a setting for this person, which is the closest thing available to "you had a range
// under the old metric" — v1's learned range itself was never persisted (it lived in memory and
// died with the tab), so it cannot be detected directly and cannot be migrated. That is why the
// notice asks for a one-time calibration rather than converting anything.
//
// THIS SIGNAL IS DELIBERATELY IMPRECISE, and the imprecision runs one way on purpose. Every key
// it looks at is written on a user ACTION (picking a mic, a colour mode, a goal), so a genuinely
// new user who changes one setting looks "returning" on their next load. Perfect detection is
// impossible — a v1 user who never set a haptic rule left no resonance state at all — so the
// choice is which error to make. A false positive shows a calibration prompt to someone who has
// not calibrated, which is true and useful for them; a false negative is the reported bug, a
// user whose numbers moved and who was never told. The notice's wording is therefore written to
// be accurate for BOTH audiences rather than asserting a history the reader may not have.
export function isReturningUser(storedKeys) {
  const keys = storedKeys instanceof Set ? storedKeys : new Set(Array.isArray(storedKeys) ? storedKeys : []);
  for (const k of keys) {
    if (typeof k !== 'string') continue;
    if (k === RESONANCE_NOTICE_KEY || k === RESONANCE_PROFILE_KEY) continue;  // not evidence of prior USE
    if (k.startsWith('vox:')) return true;
  }
  return false;
}

// Returns null when there is nothing to say, or one notice. Pure: the caller supplies what it
// read from storage and does the rendering, so the decision is testable without a DOM.
export function resonanceSpanNotice({
  profileStatus = 'absent', returningUser = false, acknowledged = false,
} = {}) {
  if (acknowledged) return null;
  if (profileStatus === 'ok' || profileStatus === 'unwritable') return null;

  if (PROFILE_REFUSED_REASONS.has(profileStatus)) {
    const versioned = profileStatus === 'metric-version-older' || profileStatus === 'metric-version-newer';
    return {
      kind: 'refused',
      reason: profileStatus,
      title: 'Your saved resonance range could not be used',
      body: versioned
        ? 'It was calibrated on an older version of the resonance measurement, so applying it '
          + 'would point the ring at a different vocal target. You are on the typical adult '
          + 'range until you set yours up again.'
        : 'The saved calibration could not be read, so you are on the typical adult range. '
          + 'Setting it up again takes about a minute.',
      action: 'Set up my range',
    };
  }

  if (profileStatus === 'absent' && returningUser) {
    return {
      kind: 'never-calibrated',
      reason: 'absent',
      title: 'The ring is using the typical adult range, not yours',
      body: 'It has not been calibrated to your voice, so readings can sit lower and travel less '
        + 'than they should — the published range covers all adult speakers, not your own. If you '
        + 'used an earlier version, it learned your range automatically each session; this one '
        + 'asks once. The setup takes about a minute.',
      action: 'Set up my range',
    };
  }
  return null;
}
