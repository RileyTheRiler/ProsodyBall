// Phase 4's bookkeeping, tested where it is load-bearing: the population span must come from
// the published norms rather than from taste, control must be absent rather than zero when
// there is nothing to report, and a threshold set against one metric version must not fire
// against another.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESONANCE_METRIC_VERSION, RESONANCE_METRIC_VERSION_V1,
  RESONANCE_POPULATION_SPAN, RESONANCE_CONTROL_MIN_SPAN, RESONANCE_POOLED_SCALE_SD_20DB,
  RESONANCE_ACROSS_VOWEL_HALF_EXCURSION,
  RESONANCE_SCALE_ABSOLUTE, RESONANCE_SCALE_CONTROL,
  resonanceControl, spanFromPostures,
  makeResonanceProfile, serializeResonanceProfile, parseResonanceProfile, spanIdFor,
  makeReading, aggregateReadings,
  migrateResonanceRules, ruleMayFire, confirmResonanceRule,
  resonanceSpanNotice, isReturningUser, RESONANCE_NOTICE_KEY, RESONANCE_PROFILE_KEY,
} from './resonance-metric.js';
import { resonanceAbsoluteV2, fitFormantScale, poolFormantScale } from './dsp-utils.js';
import { BENCH_SET, formantsOf } from './tools/resonance-benchmark.mjs';

// --- the population span is a measurement, not a taste --------------------------------------

// Recomputed from the committed Peterson & Barney fixture through the same functions the app
// uses, exactly as resonance-dprime.test.mjs does for RESONANCE_V2_REFERENCE_DELTA_F_HZ. If the
// norms, the scale fit or the absolute mapping move, this fails rather than the span quietly
// meaning something else.
function pbPopulation(sex) {
  const dfs = BENCH_SET.map((v) => fitFormantScale(formantsOf(v, sex)).deltaF);
  const pooled = poolFormantScale(dfs.map((d) => ({ deltaF: d, weight: 1 })), { minSamples: 2 }).deltaF;
  const abs = dfs.map((d) => resonanceAbsoluteV2(d));
  return { pooled: resonanceAbsoluteV2(pooled), excursion: Math.max(...abs) - Math.min(...abs) };
}

test('the population span ends are P&B\'s two pooled means, each half an across-vowel excursion inside', () => {
  const m = pbPopulation('male');
  const f = pbPopulation('female');
  const halfExcursion = (m.excursion + f.excursion) / 4;
  assert.ok(Math.abs(RESONANCE_POPULATION_SPAN.min - (m.pooled - halfExcursion)) < 5e-4,
    `span.min ${RESONANCE_POPULATION_SPAN.min} vs recomputed ${(m.pooled - halfExcursion).toFixed(4)}`);
  assert.ok(Math.abs(RESONANCE_POPULATION_SPAN.max - (f.pooled + halfExcursion)) < 5e-4,
    `span.max ${RESONANCE_POPULATION_SPAN.max} vs recomputed ${(f.pooled + halfExcursion).toFixed(4)}`);
});

test('by construction each published mean lands at 30.4% / 69.6% of the population span', () => {
  const m = resonanceControl(pbPopulation('male').pooled);
  const f = resonanceControl(pbPopulation('female').pooled);
  assert.ok(Math.abs(m - 0.304) < 0.005, `adult-male pooled reads ${(100 * m).toFixed(1)}%`);
  assert.ok(Math.abs(f - 0.696) < 0.005, `adult-female pooled reads ${(100 * f).toFixed(1)}%`);
});

// --- resonanceControl ------------------------------------------------------------------------

test('control is null, not 0, when there is no reading', () => {
  assert.equal(resonanceControl(null), null);
  assert.equal(resonanceControl(undefined), null);
  assert.equal(resonanceControl(NaN), null);
  // 0 is a real position on this axis and must survive.
  assert.equal(resonanceControl(0), 0);
});

test('control clamps to the span and is monotone inside it', () => {
  const span = { min: 0.4, max: 0.6 };
  assert.equal(resonanceControl(0.3, span), 0);
  assert.equal(resonanceControl(0.7, span), 1);
  assert.ok(Math.abs(resonanceControl(0.5, span) - 0.5) < 1e-12);
  assert.ok(resonanceControl(0.55, span) > resonanceControl(0.45, span));
});

test('control refuses a degenerate span rather than dividing by zero', () => {
  assert.equal(resonanceControl(0.5, { min: 0.5, max: 0.5 }), null);
  assert.equal(resonanceControl(0.5, { min: 0.6, max: 0.4 }), null);
  assert.equal(resonanceControl(0.5, null), null);
});

// --- the personal span ----------------------------------------------------------------------

test('the two deliberate postures centre the span; habitual is recorded and sets nothing', () => {
  const span = spanFromPostures({
    darker: [0.40, 0.41, 0.42], brighter: [0.62, 0.63, 0.64], habitual: [0.50, 0.51],
  });
  // Medians 0.41 and 0.63: spread 0.22, above the floor, centred on 0.52.
  assert.ok(Math.abs(span.observedSpread - 0.22) < 1e-9);
  assert.ok(Math.abs((span.min + span.max) / 2 - 0.52) < 1e-9, 'postures centre the span');
  assert.equal(span.spreadFloored, false);
  assert.ok(Math.abs(span.habitual - 0.505) < 1e-9);
  // The postures sit strictly INSIDE the span now, not on its ends. The ends carry the
  // across-vowel allowance on top — see RESONANCE_ACROSS_VOWEL_HALF_EXCURSION. Before that
  // allowance existed, the ends were the postures and ordinary vowels railed the meter.
  assert.ok(span.min < 0.41 && span.max > 0.63);
  const expectedWidth = 0.22 + 2 * RESONANCE_ACROSS_VOWEL_HALF_EXCURSION + 2 * 0.22 * 0.05;
  assert.ok(Math.abs((span.max - span.min) - expectedWidth) < 1e-9,
    `width ${(span.max - span.min).toFixed(4)}, expected ${expectedWidth.toFixed(4)}`);
  assert.equal(span.vowelAllowanceSource, 'published');
  assert.equal(span.vowelExcursion, null);
});

test('a measured across-vowel excursion is used in place of the published one', () => {
  const postures = { darker: [0.44], brighter: [0.50], habitual: [0.47] };
  const published = spanFromPostures(postures);
  const measured = spanFromPostures(postures, { vowelExcursion: 0.145 });
  assert.equal(published.vowelAllowanceSource, 'published');
  assert.equal(measured.vowelAllowanceSource, 'measured');
  assert.ok(Math.abs(measured.vowelAllowance - 0.145 / 2) < 1e-9);
  assert.ok(Math.abs(measured.vowelExcursion - 0.145) < 1e-9);
  // A speaker with a WIDER vowel space than the published average needs a wider span, and a
  // narrower one needs less. Both directions, so this cannot be a one-sided fudge.
  assert.ok(measured.max - measured.min > published.max - published.min, 'wider vowel space -> wider span');
  const narrow = spanFromPostures(postures, { vowelExcursion: 0.06 });
  assert.ok(narrow.max - narrow.min < published.max - published.min, 'narrower vowel space -> narrower span');
  // Garbage is ignored rather than trusted.
  for (const bad of [0, -1, NaN, null, undefined, 'x']) {
    assert.equal(spanFromPostures(postures, { vowelExcursion: bad }).vowelAllowanceSource, 'published');
  }
});

test('THE REGRESSION: held vowels must not rail a calibrated span', () => {
  // The reported bug. Live-measured pooled absolutes for one speaker holding four vowels, and
  // the posture excursion a real calibration produces. Before the allowance, /i/ read 1.00 and
  // /u/ read 0.00 — the voice-map firefly pinned to the left and right edges.
  const held = { i: 0.5470, 'ɛ': 0.4667, 'ɑ': 0.4555, u: 0.4015 };
  const vals = Object.values(held);
  const excursion = Math.max(...vals) - Math.min(...vals);          // 0.1455
  const mid = (Math.max(...vals) + Math.min(...vals)) / 2;
  const postureSpread = 0.06;                                        // a GAVT-sized posture change
  const span = spanFromPostures({
    darker: [mid - postureSpread / 2], brighter: [mid + postureSpread / 2], habitual: [mid],
  }, { vowelExcursion: excursion });

  for (const [vowel, absolute] of Object.entries(held)) {
    const c = resonanceControl(absolute, span);
    assert.ok(c > 0 && c < 1, `/${vowel}/ railed at ${c} — the firefly is back on the edge`);
  }
  // And the postures themselves still travel a useful part of the meter: the fix must not
  // flatten the axis into uselessness, which is the opposite failure.
  const lo = resonanceControl(mid - postureSpread / 2, span);
  const hi = resonanceControl(mid + postureSpread / 2, span);
  assert.ok(hi - lo > 0.2, `a deliberate posture change moves only ${(100 * (hi - lo)).toFixed(0)}% of the meter`);
});

test('a speaker whose postures barely differ gets the floor span and is flagged, not a steep axis', () => {
  const span = spanFromPostures({ darker: [0.49], brighter: [0.51], habitual: [0.50] });
  assert.equal(span.spreadFloored, true);
  assert.ok(span.max - span.min >= RESONANCE_CONTROL_MIN_SPAN, `width ${(span.max - span.min).toFixed(4)}`);
  // The observed 0.02 spread is below the measurement noise it would have to beat, so the floor
  // does the work instead — and the display's noise-induced jitter is bounded at a fifth of the
  // meter rather than the ~28% a 0.02 span would have produced.
  assert.ok(RESONANCE_POOLED_SCALE_SD_20DB / (span.max - span.min) < 0.25);
});

test('the span floor is five times the measured pooled-scale SD, not a chosen width', () => {
  // The floor's whole justification is that the two ends are separated by enough measurement
  // noise SDs to be a demonstrated difference. If either number moves, this fails rather than
  // the floor quietly meaning something else. RESONANCE_POOLED_SCALE_SD_20DB is re-measured on a
  // sustained vowel — where the true value is constant by construction — by
  // tools/resonance-two-scale.mjs, which also asserts the floor stays clear of it.
  assert.ok(Math.abs(RESONANCE_CONTROL_MIN_SPAN / RESONANCE_POOLED_SCALE_SD_20DB - 5) < 1e-9);
  // Above the noise by enough to be a demonstrated difference rather than a coin flip.
  assert.ok(RESONANCE_CONTROL_MIN_SPAN > 3 * RESONANCE_POOLED_SCALE_SD_20DB);
  // And BELOW a genuine darker->brighter sweep, or it binds for every user and the ball's travel
  // is compressed for everyone — which is the failure the first two floor values had. The
  // calibration asks for a posture in EACH direction, so the sweep is two of the published GAVT
  // excursions (F2 1847 -> 1961, +6.2% of formant frequency, applied to an adult-male-scaled
  // tract). tools/resonance-two-scale.mjs measures the same sweep end to end through the live
  // analyzer and gets 0.051 and 0.059 for its two speakers.
  const pbMaleDeltaF = 993.3;
  const gavtOneWay = (pbMaleDeltaF * (1961 / 1847) - pbMaleDeltaF) / (2 * 1078);
  const fullSweep = 2 * gavtOneWay;
  assert.ok(RESONANCE_CONTROL_MIN_SPAN < fullSweep,
    `the floor (${RESONANCE_CONTROL_MIN_SPAN.toFixed(4)}) is above a published-magnitude posture `
    + `sweep (${fullSweep.toFixed(4)}) and would bind for every user`);
});

test('a swapped pair of postures still produces a monotone span, and says so', () => {
  const span = spanFromPostures({ darker: [0.62], brighter: [0.41], habitual: [0.5] });
  assert.equal(span.postureOrderSwapped, true);
  assert.ok(span.min < span.max);
});

test('spanFromPostures returns null when a deliberate extreme is missing', () => {
  assert.equal(spanFromPostures({ darker: [0.4], brighter: [], habitual: [0.5] }), null);
  assert.equal(spanFromPostures(null), null);
});

// --- versioned persistence -------------------------------------------------------------------

test('a profile round-trips and carries the metric version', () => {
  const span = spanFromPostures({ darker: [0.40], brighter: [0.62], habitual: [0.50] });
  const p = makeResonanceProfile({ span, ceilingHz: 5000, calibratedAt: '2026-08-23T00:00:00.000Z' });
  assert.equal(p.metricVersion, RESONANCE_METRIC_VERSION);
  const back = parseResonanceProfile(serializeResonanceProfile(p));
  assert.equal(back.reason, 'ok');
  assert.equal(back.profile.metricVersion, RESONANCE_METRIC_VERSION);
  assert.ok(Math.abs(back.profile.span.min - p.span.min) < 1e-9);
  assert.ok(Math.abs(back.profile.span.max - p.span.max) < 1e-9);
  assert.equal(back.profile.ceilingHz, 5000);
  assert.equal(back.profile.spanId, p.spanId);
});

test('a profile from another metric version is refused, in both directions, with the reason', () => {
  const span = { min: 0.4, max: 0.62 };
  const older = JSON.stringify({ schema: 1, metricVersion: 1, span });
  const newer = JSON.stringify({ schema: 1, metricVersion: 99, span });
  assert.equal(parseResonanceProfile(older).profile, null);
  assert.equal(parseResonanceProfile(older).reason, 'metric-version-older');
  assert.equal(parseResonanceProfile(newer).profile, null);
  assert.equal(parseResonanceProfile(newer).reason, 'metric-version-newer');
});

test('an unversioned stored profile is read as version 1 and refused', () => {
  const legacy = JSON.stringify({ span: { min: 0.4, max: 0.62 } });
  const r = parseResonanceProfile(legacy);
  assert.equal(r.profile, null);
  assert.equal(r.storedVersion, RESONANCE_METRIC_VERSION_V1);
});

test('garbage and absence are distinguishable, and neither throws', () => {
  assert.equal(parseResonanceProfile(null).reason, 'absent');
  assert.equal(parseResonanceProfile('{not json').reason, 'unparseable');
  assert.equal(parseResonanceProfile('[]').reason, 'not-an-object');
  assert.equal(parseResonanceProfile(JSON.stringify({ metricVersion: 2, span: { min: 0.5, max: 0.5 } })).reason,
    'span-unusable');
});

test('a span id changes when the span moves and not otherwise', () => {
  const a = spanIdFor({ min: 0.4, max: 0.62, source: 'calibrated' });
  const b = spanIdFor({ min: 0.4, max: 0.62, source: 'calibrated' });
  const c = spanIdFor({ min: 0.41, max: 0.62, source: 'calibrated' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// --- aggregates never mix versions -----------------------------------------------------------

test('an aggregate refuses readings from another version or another scale, and reports how many', () => {
  const readings = [
    makeReading(0.6, { scale: RESONANCE_SCALE_CONTROL }),
    makeReading(0.4, { scale: RESONANCE_SCALE_CONTROL }),
    makeReading(0.9, { scale: RESONANCE_SCALE_CONTROL, metricVersion: RESONANCE_METRIC_VERSION_V1 }),
    makeReading(0.1, { scale: RESONANCE_SCALE_ABSOLUTE }),
  ];
  const agg = aggregateReadings(readings);
  assert.equal(agg.n, 2);
  assert.equal(agg.rejected, 2);
  assert.ok(Math.abs(agg.mean - 0.5) < 1e-12);
});

test('control readings from a different span are refused; absolute readings never carry one', () => {
  const readings = [
    makeReading(0.6, { scale: RESONANCE_SCALE_CONTROL, spanId: 'A' }),
    makeReading(0.8, { scale: RESONANCE_SCALE_CONTROL, spanId: 'B' }),
  ];
  assert.equal(aggregateReadings(readings, { spanId: 'A' }).n, 1);
  const abs = [makeReading(0.46, { scale: RESONANCE_SCALE_ABSOLUTE }), makeReading(0.54, { scale: RESONANCE_SCALE_ABSOLUTE })];
  assert.equal(aggregateReadings(abs, { scale: RESONANCE_SCALE_ABSOLUTE }).n, 2);
});

test('an aggregate over nothing is null, not 0', () => {
  assert.equal(aggregateReadings([]).mean, null);
});

// --- threshold migration ----------------------------------------------------------------------

test('an unversioned resonance rule is suspended, keeps its threshold, and is handed back to re-prompt', () => {
  const rules = [
    { id: 1, metric: 'resonance', direction: 'below', threshold: 30, enabled: true },
    { id: 2, metric: 'pitch', direction: 'below', threshold: 150, enabled: true },
  ];
  const { rules: out, needsReprompt } = migrateResonanceRules(rules);
  assert.equal(out[0].suspended, true);
  assert.equal(out[0].threshold, 30, 'the threshold the user typed is preserved verbatim');
  assert.equal(out[0].enabled, true, 'the user\'s enabled flag is not touched');
  assert.equal(out[0].metricVersion, RESONANCE_METRIC_VERSION_V1);
  assert.equal(needsReprompt.length, 1);
  // Every other metric is untouched: none of them changed.
  assert.deepEqual(out[1], rules[1]);
});

test('no resonance rule from another version may fire; pitch rules are unaffected', () => {
  const v1Rule = { metric: 'resonance', direction: 'below', threshold: 30, enabled: true };
  assert.equal(ruleMayFire(v1Rule), false, 'unversioned = v1, must not fire against a v2 value');
  const migrated = migrateResonanceRules([v1Rule]).rules[0];
  assert.equal(ruleMayFire(migrated), false);
  assert.equal(ruleMayFire({ metric: 'pitch', threshold: 150, enabled: true }), true);
  assert.equal(ruleMayFire({ metric: 'resonance', threshold: 30, enabled: true, metricVersion: RESONANCE_METRIC_VERSION }), true);
  assert.equal(ruleMayFire({ metric: 'resonance', threshold: 30, enabled: false, metricVersion: RESONANCE_METRIC_VERSION }), false);
});

test('only an explicit confirmation clears a suspension', () => {
  const suspended = migrateResonanceRules([
    { metric: 'resonance', direction: 'below', threshold: 30, enabled: true },
  ]).rules[0];
  assert.equal(ruleMayFire(suspended), false);
  // Re-running the migrator does not clear it.
  assert.equal(ruleMayFire(migrateResonanceRules([suspended]).rules[0]), false);
  const confirmed = confirmResonanceRule(suspended, { threshold: 35 });
  assert.equal(ruleMayFire(confirmed), true);
  assert.equal(confirmed.threshold, 35);
  assert.equal(confirmed.suspendedReason, undefined);
});

test('a rule set against a different span is suspended too, when a span is given to check', () => {
  // The settings-import case: rules and profile are exported together but either can arrive
  // without the other, and a control threshold is a position inside a span.
  const rules = [
    { metric: 'resonance', direction: 'below', threshold: 30, enabled: true,
      metricVersion: RESONANCE_METRIC_VERSION, spanId: 'calibrated/0.4000-0.6200' },
  ];
  const same = migrateResonanceRules(rules, { spanId: 'calibrated/0.4000-0.6200' });
  assert.equal(same.needsReprompt.length, 0);
  assert.equal(ruleMayFire(same.rules[0]), true);

  const moved = migrateResonanceRules(rules, { spanId: 'calibrated/0.4200-0.6600' });
  assert.equal(moved.needsReprompt.length, 1);
  assert.equal(moved.rules[0].suspendedReason, 'span-changed');
  assert.equal(moved.rules[0].threshold, 30, 'the threshold is preserved across a span change too');
  assert.equal(ruleMayFire(moved.rules[0]), false);

  // A rule with no recorded span cannot be shown to belong to this one.
  const unknown = migrateResonanceRules(
    [{ metric: 'resonance', threshold: 30, enabled: true, metricVersion: RESONANCE_METRIC_VERSION }],
    { spanId: 'calibrated/0.4000-0.6200' });
  assert.equal(unknown.rules[0].suspendedReason, 'span-unknown');

  // And omitting the span checks versions only, which is what a caller that does not yet know
  // its span wants.
  assert.equal(migrateResonanceRules(rules).needsReprompt.length, 0);
});

test('migrating an already-current rule is a no-op that stamps the version', () => {
  const rule = { metric: 'resonance', direction: 'above', threshold: 70, enabled: true, metricVersion: RESONANCE_METRIC_VERSION };
  const { rules: out, needsReprompt } = migrateResonanceRules([rule]);
  assert.equal(needsReprompt.length, 0);
  assert.equal(out[0].suspended, undefined);
  assert.equal(ruleMayFire(out[0]), true);
});

// ============================================================================
// §3.5's re-prompt, for the SPAN — the gap a user found
// ============================================================================
//
// Reported symptom: "resonance is now reading darker than it should be". Reproduced: the
// measurement was fine (a sustained /i/ tracked to within 2 Hz of its true ΔF and read 45.6
// points brighter than running speech), but the user was on the POPULATION span and had never
// run the guided calibration — because v1 learned a personal range automatically every session
// and v2 does not. Nothing told them. These tests pin the notice that now does.

test('a returning user with no calibration is told the axis changed', () => {
  const n = resonanceSpanNotice({ profileStatus: 'absent', returningUser: true });
  assert.ok(n, 'a returning user with no profile must be told');
  assert.equal(n.kind, 'never-calibrated');
  assert.ok(n.action, 'the notice must offer the remedy, not just describe the problem');
});

test('the notice is worded to be true for a returning user AND a merely-uncalibrated one', () => {
  // The "returning" signal is imprecise by design (see isReturningUser): every key it reads is
  // written on a user action, so a new user who changes one setting trips it. The notice must
  // therefore not ASSERT a history the reader may not have.
  const n = resonanceSpanNotice({ profileStatus: 'absent', returningUser: true });
  assert.ok(/not calibrated|has not been calibrated/i.test(n.body), n.body);
  assert.ok(/if you used an earlier version/i.test(n.body),
    'any claim about earlier versions must be conditional, not asserted');
});

test('a first-time user is NOT nagged — nothing was reinterpreted for them', () => {
  // The population span is the honest default for a voice the app has never heard, and
  // onboarding already covers calibration. The notice is for people whose numbers MOVED.
  assert.equal(resonanceSpanNotice({ profileStatus: 'absent', returningUser: false }), null);
});

test('a refused profile says so, instead of falling back silently', () => {
  for (const reason of ['metric-version-older', 'metric-version-newer']) {
    const n = resonanceSpanNotice({ profileStatus: reason, returningUser: false });
    assert.ok(n, `${reason} must surface`);
    assert.equal(n.kind, 'refused');
    assert.equal(n.reason, reason);
    // A refusal is worth saying even to someone with no other stored state: they DID calibrate,
    // so a profile existed and was discarded.
  }
  for (const reason of ['span-unusable', 'unparseable', 'not-an-object']) {
    assert.equal(resonanceSpanNotice({ profileStatus: reason }).kind, 'refused');
  }
});

test('a working profile, and an unwritable store, say nothing', () => {
  assert.equal(resonanceSpanNotice({ profileStatus: 'ok', returningUser: true }), null);
  // 'unwritable' means the span IS live for this session and simply will not persist. The user
  // is on their own range right now, so telling them it changed would be false.
  assert.equal(resonanceSpanNotice({ profileStatus: 'unwritable', returningUser: true }), null);
});

test('the notice is shown once — acknowledging it silences every kind', () => {
  for (const profileStatus of ['absent', 'metric-version-older', 'unparseable']) {
    assert.ok(resonanceSpanNotice({ profileStatus, returningUser: true }));
    assert.equal(resonanceSpanNotice({ profileStatus, returningUser: true, acknowledged: true }), null);
  }
});

test('"returning user" means prior app state, not the resonance keys themselves', () => {
  assert.equal(isReturningUser([]), false);
  assert.equal(isReturningUser(['vox:micDeviceId']), true);
  assert.equal(isReturningUser(['vox:goalMode', 'unrelated']), true);
  // The notice's own acknowledgement key and the profile key must not count as evidence that
  // the app was used before — otherwise the first run after this change flags everyone, and
  // writing the ack would itself make the user look "returning" forever.
  assert.equal(isReturningUser([RESONANCE_NOTICE_KEY]), false);
  assert.equal(isReturningUser([RESONANCE_PROFILE_KEY]), false);
  assert.equal(isReturningUser([RESONANCE_NOTICE_KEY, RESONANCE_PROFILE_KEY]), false);
  // Non-app keys from another site on the same origin are not evidence either.
  assert.equal(isReturningUser(['theme', 'analytics_id']), false);
  assert.equal(isReturningUser(new Set(['vox:speechGate'])), true);
  assert.equal(isReturningUser(null), false);
});

test('an implausible measured excursion is capped, so one bad vowel cannot flatten the axis', () => {
  const postures = { darker: [0.44], brighter: [0.50], habitual: [0.47] };
  // A vowel whose formants were mis-tracked can inflate max-minus-min without bound. That does
  // not rail the meter, it does the opposite — it widens the span until a real posture change
  // moves nothing — so the allowance is capped.
  const sane = spanFromPostures(postures, { vowelExcursion: 0.145 });
  const absurd = spanFromPostures(postures, { vowelExcursion: 0.9 });
  const cap = 4 * RESONANCE_ACROSS_VOWEL_HALF_EXCURSION;
  assert.ok(absurd.max - absurd.min < sane.max - sane.min + cap,
    'an absurd excursion must not widen the span without limit');
  assert.ok(Math.abs(absurd.vowelAllowance - cap / 2) < 1e-9,
    `allowance capped at ${cap / 2}, got ${absurd.vowelAllowance}`);
  // A posture change must still move the meter meaningfully even at the cap.
  const travel = resonanceControl(0.50, absurd) - resonanceControl(0.44, absurd);
  assert.ok(travel > 0.1, `posture travel collapsed to ${(100 * travel).toFixed(0)}%`);
  // And a plausible excursion is passed through untouched.
  assert.ok(Math.abs(sane.vowelAllowance - 0.145 / 2) < 1e-9);
});
