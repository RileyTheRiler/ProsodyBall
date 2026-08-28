#!/usr/bin/env node
// PHASE 5 (Tier 1) — the benchmark, on real speakers.
//
// docs/RESONANCE_REDESIGN.md §5's validation ladder puts "real sustained vowels vs manually
// checked F1–F4" at "the next real gap". Everything Phases 0–4 measured came from either two
// Peterson & Barney population MEANS or a Klatt cascade whose formants are placed by
// construction. This runs the same machinery over Hillenbrand, Getty, Clark & Wheeler (1995):
// 139 individual speakers × 12 vowels, hand-corrected F0 and F1–F4.
//
// The library is tools/resonance-benchmark.mjs — the P&B benchmark, EXTENDED rather than forked,
// so `pbSpeaker` and `realSpeaker` return the same shape and every routine runs on either corpus.
// The assertions are in resonance-dprime.test.mjs.
//
// THIS PHASE MEASURES. It changes no threshold, template or weight. Where a shipped constant is
// measurably wrong the report says so with the number and proposes; §3.5's versioning makes
// changing it a separate change.
//
// Usage:
//   node tools/real-speaker-benchmark.mjs          # the report
//   node tools/real-speaker-benchmark.mjs --check  # the standing checks
import {
  HB, HB_SET, HB_EXTRA, HB_GROUPS, HB_CHILD_GROUPS, HB_ADULT_GROUPS,
  F3_FLOOR_HZ, F3_RHOTIC_FLOOR_HZ,
  realSpeakers, realTemplates, realResidualSd, realSpeakerScatter,
  ladderValues, pbLadderValues, dPrimeDenominators, MEASURE_LADDER,
  speakerHeldOutEval, outOfInventoryEval,
  f4ScaleStability, r4TemplateEvidence, f4ClassifierEval,
  rhoticReal, f2PositionReal,
  templateDistance, mean, sd, FULL_SET,
} from './resonance-benchmark.mjs';
import { VOWEL_TEMPLATES, VOWEL_RESIDUAL_SD, VOWEL_SPEAKER_SCATTER } from '../dsp-utils.js';

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const pad = (s, n) => String(s).padStart(n);

// ---------------------------------------------------------------------------------------------
// The standing checks.
//
// These pin what this phase MEASURED, not what anyone would like it to say. Three of them pin
// results that are worse than the numbers Phases 1–4 quote — the shipped classifier's accuracy on
// real speakers, the shipped template distance, the shipped speaker scatter — precisely so the
// gap cannot be quietly forgotten. A check that only ever asserted good news would be decoration.
export function runChecks() {
  const fails = [];
  const ok = [];
  const note = (pass, msg) => (pass ? ok : fails).push(msg);

  // The corpus is what it claims to be.
  note(HB.speakers.length === 139, `corpus: ${HB.speakers.length} speakers (expect 139)`);
  note(HB.tokenCount === 1668, `corpus: ${HB.tokenCount} tokens (expect 1668)`);
  note(HB.formantYield.f4.measured === 1425,
    `corpus: F4 measured on ${HB.formantYield.f4.measured}/${HB.formantYield.f4.total} tokens`);

  // The shipped classifier on real speakers. Bounded from BELOW so a regression is caught, and
  // from ABOVE so nobody can later claim the Phase 2 figure transfers: it does not.
  const shipped = speakerHeldOutEval({ templates: 'shipped' });
  note(shipped.accuracy > 0.45 && shipped.accuracy < 0.60,
    `shipped templates on 139 real speakers: ${pct(shipped.accuracy)} correct ` +
    `(Phase 2 measured 95% on 2 mean speakers; this must stay bracketed, not drift)`);
  const derived = speakerHeldOutEval({ templates: 'derived' });
  note(derived.accuracy > shipped.accuracy + 0.10,
    `real-speaker templates beat the shipped ones by ${pct(derived.accuracy - shipped.accuracy)} ` +
    `(${pct(derived.accuracy)} vs ${pct(shipped.accuracy)}) — the method generalises further than the constants`);

  // Children are reported as their own group and must not be silently dropped.
  const kids = speakerHeldOutEval({ templates: 'derived', trainGroups: HB_ADULT_GROUPS, testGroups: HB_CHILD_GROUPS });
  note(kids.n > 400, `children evaluated as their own group: ${kids.n} decisions over ${kids.nSpeakers} speakers`);

  // F4 sharpens the scale. First measurement of this on a real F4 rather than a synthesized one.
  const f4 = f4ScaleStability();
  note(f4.meanCvWithF4 < f4.meanCvWithoutF4,
    `real F4 tightens the within-speaker scale: CV ${f4.meanCvWithoutF4.toFixed(4)} → ${f4.meanCvWithF4.toFixed(4)} ` +
    `on ${f4.improved}/${f4.n} speakers`);
  // And r₄ is still not a template. §7's open question 2 gets a measured answer, not a hopeful one.
  const r4 = r4TemplateEvidence();
  note(r4.r4.separability < 1.5,
    `r₄ separability ${r4.r4.separability.toFixed(2)} (r₁ ${r4.r1.separability.toFixed(2)}, ` +
    `r₂ ${r4.r2.separability.toFixed(2)}) — a measured r₄ template is NOT supported`);

  // The rhotic, at the formant level.
  const rh = rhoticReal();
  note(rh.f3.all.belowStandardFloor / rh.f3.all.n > 0.5,
    `${pct(rh.f3.all.belowStandardFloor / rh.f3.all.n)} of real /ɝ/ tokens have F3 below the ` +
    `${F3_FLOOR_HZ} Hz standard assignment floor`);
  note(rh.nonRhoticInBand === 0,
    `${rh.nonRhoticInBand}/${rh.nonRhoticTotal} non-rhotic tokens have F3 in ` +
    `[${F3_RHOTIC_FLOOR_HZ}, ${F3_FLOOR_HZ}) — the widened floor's false-positive surface is empty here`);

  // f2Position: the within-speaker contrast must still beat raw F2, the sex contrast must still
  // not. Both are Phase 4's stated split and both are re-measured rather than inherited.
  const f2 = f2PositionReal();
  note(f2.training.f2Position.dAcrossVowel > 2 * f2.training.rawF2.dAcrossVowel,
    `f2Position beats raw F2 on the GAVT within-speaker shift: d′ ` +
    `${f2.training.f2Position.dAcrossVowel.toFixed(3)} vs ${f2.training.rawF2.dAcrossVowel.toFixed(3)}`);
  note(Math.abs(f2.sex.f2Position.dAcrossVowel) < 0.5,
    `f2Position still carries no tract size: sex d′ ${f2.sex.f2Position.dAcrossVowel.toFixed(3)}`);

  // The denominator fix itself: the two denominators must actually disagree about rank, or there
  // was nothing to fix.
  const adults = realSpeakers({ groups: HB_ADULT_GROUPS });
  const L = ladderValues(adults);
  const rows = MEASURE_LADDER.map((m) => ({ m, r: dPrimeDenominators(L[m.key], 'men', 'women') }));
  const rankBy = (k) => rows.slice().sort((a, b) => b.r[k] - a.r[k]).map((x) => x.m.key);
  const rv = rankBy('dAcrossVowel'), rs = rankBy('dAcrossSpeaker');
  const moved = rv.filter((k, i) => rs[i] !== k).length;
  note(moved > 0,
    `the two denominators disagree on ${moved}/${rv.length} ladder positions — the across-speaker ` +
    `SD is a different measurement, not a rescaling`);

  return { ok, fails };
}

function report() {
  console.log('\n=== PHASE 5 (Tier 1) — the resonance benchmark on REAL SPEAKERS ===\n');
  console.log('Corpus: Hillenbrand, Getty, Clark & Wheeler (1995), JASA 97(5) 3099-3111.');
  console.log(`  ${HB.speakers.length} speakers, ${HB.tokenCount} tokens: ` +
    Object.entries(HB.groups).map(([g, n]) => `${g} ${n}`).join(', '));
  console.log(`  ${HB.copyright.split('—')[0].trim()}`);
  console.log(`  retrieved from ${HB.retrieval.retrievedFrom}`);
  console.log(`  canonical URL: ${HB.retrieval.canonicalUrl}`);
  console.log(`    ${HB.retrieval.canonicalUrlStatus}`);
  console.log('  measured formants: ' +
    Object.entries(HB.formantYield).map(([k, y]) => `${k} ${pct(y.rate)}`).join('  '));
  console.log(`  vowels shared with P&B: ${HB_SET.join(' ')}   Hillenbrand-only: ${HB_EXTRA.join(' ')}`);
  console.log('\n  NOTE ON /ɝ/: this corpus DOES include it (the author\'s key maps `er` to "heard",');
  console.log('  139 tokens, one per speaker). The Phase 5 brief assumed it did not. Everything the');
  console.log('  rhotic section below reports is real-speaker evidence at the FORMANT level.');

  // --- the group scales -----------------------------------------------------------------
  console.log('\n\n--- Pooled formant scale per group (the thing `formantScale` estimates) ---\n');
  console.log('  group     n   pooled ΔF mean ± SD        range           apparent VTL');
  for (const g of HB_GROUPS) {
    const xs = realSpeakers({ groups: [g] }).map((s) => s.scaleHz).filter((x) => x > 0);
    const m = mean(xs);
    console.log(`  ${g.padEnd(7)} ${pad(xs.length, 3)}   ${pad(m.toFixed(1), 8)} ± ${sd(xs).toFixed(1)} Hz` +
      `        ${pad(Math.min(...xs).toFixed(0), 4)}–${Math.max(...xs).toFixed(0)} Hz` +
      `     ${(35000 / (2 * m)).toFixed(1)} cm`);
  }
  console.log('\n  The children sit OUTSIDE the adult range the templates were built from — men');
  console.log('  920–1101 Hz against girls 1146–1384 Hz, entirely disjoint. That is what makes them');
  console.log('  the strongest available test that the residuals are genuinely scale-normalised,');
  console.log('  and they are reported as their own group throughout rather than pooled in.');

  // --- (c) the d′ denominator ------------------------------------------------------------
  console.log('\n\n=== (c) THE d′ DENOMINATOR ===\n');
  console.log('  §1.3 divides by the within-sex ACROSS-VOWEL SD, because two mean speakers expose no');
  console.log('  other within-sex variance. That denominator is why conditioning on the vowel inflates');
  console.log('  d′ almost tautologically. 139 speakers give the across-SPEAKER SD it always wanted.');
  console.log('\n  Both are reported on one numerator. The across-vowel column is kept so every');
  console.log('  historical number stays comparable; nothing is restated retroactively.');
  console.log('\n  BEFORE READING THE TABLE: only `v1` and `v2` are committed code (resonanceScoreV1,');
  console.log('  resonanceAbsoluteV2) and both reproduce §1.3 exactly on P&B. The other six rows are');
  console.log('  this benchmark\'s restatement of §1.3\'s one-line descriptions — that table was prose,');
  console.log('  not code, so its exact ranges and clamping are unrecoverable. They reproduce §1.3\'s');
  console.log('  ORDERING, not its values, and the published figure is printed beside them so the');
  console.log('  discrepancy is visible rather than absorbed. The §1.3 column is that table\'s');
  console.log('  SEVEN-vowel figure; the P&B column here is the TEN vowels Hillenbrand shares, which');
  console.log('  is why they differ. On those ten, the two committed rows reproduce §5\'s Phase 1');
  console.log('  entry exactly — v1 0.757 against its quoted 0.76, v2 1.220 against its quoted 1.22.\n');

  const adults = realSpeakers({ groups: HB_ADULT_GROUPS });
  const L = ladderValues(adults);
  const PBL = pbLadderValues(FULL_SET);
  console.log('                                    §1.3    P&B          ---------- REAL SPEAKERS ----------');
  console.log('  measure                          (7-vwl)  (10-vwl)   across-vowel  across-speaker  per-token   AUC');
  const rows = [];
  for (const m of MEASURE_LADDER) {
    const r = dPrimeDenominators(L[m.key], 'men', 'women');
    const p = dPrimeDenominators(PBL[m.key], 'men', 'women');
    rows.push({ m, r });
    console.log(`  ${m.label.padEnd(30)} ${pad(m.published.toFixed(2), 6)} ${pad(p.dAcrossVowel.toFixed(3), 9)}` +
      `   ${pad(r.dAcrossVowel.toFixed(3), 12)} ${pad(r.dAcrossSpeaker.toFixed(3), 15)} ` +
      `${pad(r.dToken.toFixed(3), 10)} ${pad(r.aucSpeaker.toFixed(3), 6)}` +
      `${m.committed ? '  <- committed' : ''}`);
  }
  const rankBy = (k) => rows.slice().sort((a, b) => b.r[k] - a.r[k]);
  console.log('\n  RANK BY ACROSS-VOWEL SD (§1.3\'s denominator):');
  rankBy('dAcrossVowel').forEach((x, i) => console.log(`    ${i + 1}. ${x.m.label}  ${x.r.dAcrossVowel.toFixed(3)}`));
  console.log('\n  RANK BY ACROSS-SPEAKER SD (the one 139 speakers make possible):');
  rankBy('dAcrossSpeaker').forEach((x, i) => console.log(`    ${i + 1}. ${x.m.label}  ${x.r.dAcrossSpeaker.toFixed(3)}`));
  const rv = rankBy('dAcrossVowel').map((x) => x.m.key), rs = rankBy('dAcrossSpeaker').map((x) => x.m.key);
  console.log(`\n  ${rv.filter((k, i) => rs[i] !== k).length} of ${rv.length} positions move. WHICH MEASURES CHANGE RANK, plainly:`);
  for (const m of MEASURE_LADDER) {
    const a = rv.indexOf(m.key) + 1, b = rs.indexOf(m.key) + 1;
    if (a !== b) console.log(`    ${m.label.padEnd(30)} ${a} → ${b}  (${b < a ? 'up' : 'down'} ${Math.abs(a - b)})`);
  }
  console.log('\n  THE HEADLINE, AND IT IS NOT COMFORTABLE: under the across-speaker denominator, v1 —');
  console.log('  the measure this whole redesign exists to replace — ranks FIRST, and v2 fifth.');
  console.log('  Read the AUC column before drawing a conclusion from that. Every scale measure sits');
  console.log('  at AUC 0.98–1.00: averaged over a speaker\'s whole ten-vowel inventory, they all');
  console.log('  separate men from women almost perfectly, and d′ is magnifying differences between');
  console.log('  measures that are all already at ceiling.');
  console.log('\n  The reason this does NOT argue for reverting to v1 is the per-token column, and it is');
  console.log('  the column the app lives in. v1 0.889 against v2 1.051: on ONE vowel from ONE speaker');
  console.log('  — which is what a frame is — v2 is still ahead, and §1.1\'s 73-point across-vowel');
  console.log('  swing is exactly the within-speaker variance the across-speaker denominator averages');
  console.log('  away by construction. The two denominators answer different questions:');
  console.log('    across-vowel  — can a single frame tell two speakers apart despite the vowel?');
  console.log('    across-speaker— can a speaker\'s whole inventory tell them apart from another\'s?');
  console.log('  The app displays the first. The second is the honest denominator for a study that');
  console.log('  gets to average a person, and it is reported because it is measurable now, not');
  console.log('  because it is the operating point.');

  // --- the acceptance criterion ----------------------------------------------------------
  console.log('\n\n=== VOWEL CLASSIFICATION, HELD OUT ACROSS REAL SPEAKERS ===\n');
  console.log('  Phase 2 reports 95% correct at 0% abstention "held out across sexes". That is n = 20');
  console.log('  decisions over TWO mean speakers. Here the held-out unit is a PERSON.\n');
  const evals = [
    ['SHIPPED VOWEL_TEMPLATES (P&B-derived) vs all 139 real speakers', { templates: 'shipped' }],
    ['templates re-derived from real speakers, 5-fold held out BY SPEAKER', { templates: 'derived' }],
    ['shipped templates, CHILDREN only', { templates: 'shipped', testGroups: HB_CHILD_GROUPS }],
    ['trained on ADULTS only, tested on CHILDREN (tract lengths outside the training range)',
      { templates: 'derived', trainGroups: HB_ADULT_GROUPS, testGroups: HB_CHILD_GROUPS }],
  ];
  let shipped = null;
  for (const [name, opts] of evals) {
    const e = speakerHeldOutEval(opts);
    if (!shipped) shipped = e;
    console.log(`  ${name}`);
    console.log(`    n=${e.n} decisions over ${e.nSpeakers} speakers:  correct ${pct(e.accuracy)}   ` +
      `misclassified ${pct(e.wrong / e.n)}   abstained ${pct(e.abstentionRate)}   ` +
      `(of frames it answered: ${pct(e.accuracyDecided)})`);
    console.log('    by group: ' + Object.entries(e.byGroup).map(([g, o]) => {
      const n = o.correct + o.wrong + o.abstain;
      return `${g} ${pct(o.correct / n)}`;
    }).join('   '));
    console.log('    per vowel: ' + Object.entries(e.perVowel).map(([v, o]) => {
      const n = o.correct + o.wrong + o.abstain;
      return `/${v}/ ${n ? (100 * o.correct / n).toFixed(0) : '·'}%`;
    }).join('  '));
    console.log('');
  }

  console.log('  DOES SPEAKER-INDEPENDENCE SURVIVE CONTACT WITH 139 SPEAKERS? Largely no, and the 95%');
  console.log('  was substantially an artefact of averaging. The shipped templates get ' + pct(shipped.accuracy));
  console.log('  of real productions right. But the failure splits cleanly in two, and only one half is');
  console.log('  about the method:');
  const derived = speakerHeldOutEval({ templates: 'derived' });
  console.log(`    - the shipped CONSTANTS are wrong: re-deriving templates from real speakers and`);
  console.log(`      holding out by speaker gives ${pct(derived.accuracy)}, ` +
    `${(100 * (derived.accuracy - shipped.accuracy)).toFixed(1)} points better on the same test;`);
  console.log('    - the METHOD still degrades: 70% is not 95%, and real speakers scatter around a');
  console.log('      vowel template far more than two population means suggested (see the scatter');
  console.log('      constant below). Averaging two mean speakers hid both.');

  console.log('\n  Confusion matrix — SHIPPED templates, rows = spoken, cols = reported, last col = abstained');
  const cols = [...HB_SET, '—'];
  console.log('        ' + cols.map((c) => pad(c, 5)).join(''));
  for (const v of HB_SET) {
    const total = Object.values(shipped.matrix[v]).reduce((a, b) => a + b, 0) || 1;
    console.log(`   /${v}/`.padEnd(8) + cols.map((c) => {
      const n = shipped.matrix[v][c] || 0;
      return pad(n ? (100 * n / total).toFixed(0) : '·', 5);
    }).join(''));
  }
  console.log('        (% of that vowel\'s tokens)');
  console.log('  The errors are overwhelmingly to the ADJACENT vowel — /i/→/ɪ/, /u/→/ʊ/, /æ/→/ɛ/,');
  console.log('  /ɔ/→/ɑ/ — which is what a template set whose spacing is too wide for the real');
  console.log('  scatter produces. It is not naming random vowels; it is failing to resolve neighbours.');

  const oo = outOfInventoryEval();
  console.log(`\n  OUT-OF-INVENTORY: /e/ and /o/ are real vowels of the language with no shipped template.`);
  console.log(`  Over ${oo.n} such tokens the classifier abstains on only ${pct(oo.abstentionRate)} and confidently`);
  console.log(`  names something on the rest: ` +
    Object.entries(oo.got).map(([v, g]) => `/${v}/ → ${Object.entries(g).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ')}`).join('   '));
  console.log('  §6 asks the classifier to degrade to "no vowel this frame" rather than guess. The two');
  console.log('  abstention gates do not catch a vowel that is simply not in the inventory — it lands');
  console.log('  squarely on a neighbour, which is the same hole §5\'s Phase 2 entry names at the frame');
  console.log('  level. Reported, not fixed: this phase does not tune.');

  // --- (d) the shipped constants ---------------------------------------------------------
  console.log('\n\n=== (d) THE SHIPPED CONSTANTS vs THE REAL CORPUS ===\n');
  console.log('  Re-derived by the IDENTICAL definitions, from 139 speakers instead of two means.');
  console.log('  NOTHING IS SWAPPED. §3.5\'s versioning applies to anything that moves a displayed');
  console.log('  number, so this is a proposal with numbers attached.\n');
  const all = realSpeakers();
  const T = realTemplates(all);
  console.log('  VOWEL_TEMPLATES  (r₁, r₂, r₃)');
  console.log('   vowel      shipped (P&B)              real (139 speakers)        distance');
  let worst = 0, tot = 0, n = 0;
  for (const v of HB_SET) {
    const a = VOWEL_TEMPLATES[v], b = T[v];
    if (!b) continue;
    const d = templateDistance(a, b, 2, VOWEL_RESIDUAL_SD);
    worst = Math.max(worst, d); tot += d; n++;
    console.log(`   /${v}/`.padEnd(11) + a.map((x) => x.toFixed(4)).join(' ') + '    ' +
      b.map((x) => x.toFixed(4)).join(' ') + '    ' + d.toFixed(3) +
      (d > 0.585 ? '  ← beyond the abstention gate' : ''));
  }
  console.log(`\n   mean distance ${(tot / n).toFixed(3)} across-vowel SDs, worst ${worst.toFixed(3)}.`);
  console.log('   For scale: VOWEL_ABSTAIN_MAX_DISTANCE is 0.585. The shipped /æ/ template sits');
  console.log('   FURTHER from the real /æ/ centroid than the classifier\'s own "this is not a vowel"');
  console.log('   threshold — which is most of why /æ/ scores 6% above.');

  const rsd = realResidualSd(T);
  console.log('\n  VOWEL_RESIDUAL_SD');
  console.log(`   shipped  [${VOWEL_RESIDUAL_SD.map((x) => x.toFixed(4)).join(', ')}]`);
  console.log(`   real     [${rsd.map((x) => x.toFixed(4)).join(', ')}]`);
  console.log(`   ratio     ${rsd.map((x, i) => (x / VOWEL_RESIDUAL_SD[i]).toFixed(3)).join('   ')}`);
  console.log('   The shipped SDs are 12–18% WIDE. Distances are divided by these, so every measured');
  console.log('   distance is reported ~13% smaller than it is, and both abstention gates are that');
  console.log('   much looser than they were specified to be.');

  const scReal = realSpeakerScatter(all, { templates: T });
  const scShip = realSpeakerScatter(all, { templates: VOWEL_TEMPLATES });
  console.log('\n  VOWEL_SPEAKER_SCATTER');
  console.log(`   shipped                                  ${VOWEL_SPEAKER_SCATTER}`);
  console.log(`   real, against real templates             ${scReal.mean.toFixed(4)}  (median ${scReal.median.toFixed(4)}, n=${scReal.n})`);
  console.log(`   real, against the SHIPPED templates      ${scShip.mean.toFixed(4)}`);
  console.log('   by group (real templates): ' +
    Object.entries(scReal.byGroup).map(([g, o]) => `${g} ${o.mean.toFixed(3)}`).join('   '));
  console.log('\n   The shipped 0.195 is ONE difference — the P&B male norm against the P&B female norm');
  console.log('   for the same vowel. Measured as what it is meant to be (how far a genuine production');
  console.log(`   sits from the template because the speaker is a different person) it is ${scReal.mean.toFixed(3)},`);
  console.log(`   ${((scReal.mean / VOWEL_SPEAKER_SCATTER - 1) * 100).toFixed(0)}% larger. The posterior gate and the 3-scatter distance gate are both`);
  console.log('   calibrated on it, so both are tighter than the constant claims. Children scatter');
  console.log('   most — the population the constant was never shown.');

  console.log('\n  PROPOSAL (this phase does not apply it): all three constants are measurably wrong in');
  console.log('  the same direction — the P&B means understate how far real speakers sit from a');
  console.log('  template. Re-deriving them from this corpus is worth ~19 points of classifier');
  console.log('  accuracy on real speakers. It moves `f2Position`, therefore the vowel-nucleus');
  console.log('  statistics, therefore a displayed metric, so it is a versioned change under §3.5 and');
  console.log('  the user\'s call, not this phase\'s.');

  // --- F4 --------------------------------------------------------------------------------
  console.log('\n\n=== F4 — THE FIRST MEASURED ONE ===\n');
  console.log('  P&B published no F4, so every F4 claim in Phases 1–2 rests on either the live');
  console.log('  extractor\'s own output or a synthetic F4 placed at 3.5·ΔF of the vowel\'s OWN fit —');
  console.log('  an F4 constructed to agree with the other three formants cannot answer whether F4');
  console.log(`  adds anything. This corpus measured it by hand on ${pct(HB.formantYield.f4.rate)} of tokens.\n`);
  const f4 = f4ScaleStability();
  console.log('  1. DOES F4 MAKE THE SCALE BETTER DETERMINED?');
  console.log('     The test is not whether ΔF changes but whether the speaker\'s scale stops depending');
  console.log('     on which vowel they said: the within-speaker across-vowel CV of per-token ΔF.');
  console.log('     Paired — the same F4-complete tokens scored both ways.\n');
  console.log(`     F1–F3   CV ${f4.meanCvWithoutF4.toFixed(4)}        F1–F4   CV ${f4.meanCvWithF4.toFixed(4)}` +
    `        ${pct(1 - f4.meanCvWithF4 / f4.meanCvWithoutF4)} tighter`);
  console.log(`     improved for ${f4.improved} of ${f4.n} speakers (${pct(f4.improvedRate)})`);
  console.log('     by group: ' + Object.entries(f4.byGroup).filter(([, o]) => o)
    .map(([g, o]) => `${g} ${o.withoutF4.toFixed(4)}→${o.withF4.toFixed(4)}`).join('   '));
  console.log('\n     YES, and this is the first evidence for it that is not circular. §3.2 said');
  console.log('     weighting the scale toward F3 and F4 was "the single largest validity gain');
  console.log('     available"; on real speakers F4 removes 28% of the vowel-dependence of the scale.');

  const r4 = r4TemplateEvidence();
  console.log('\n  2. IS THERE A MEASURED r₄ TEMPLATE? (§7 open question 2, open since Phase 2)');
  console.log('     A dimension carries vowel identity when its across-vowel spread exceeds its');
  console.log('     across-speaker scatter within a vowel. That ratio is the whole answer.\n');
  console.log('     dim   across-vowel SD   across-speaker SD   separability');
  for (const k of ['r1', 'r2', 'r3', 'r4']) {
    console.log(`     ${k}      ${pad(r4[k].acrossVowelSd.toFixed(4), 10)}        ${pad(r4[k].acrossSpeakerSd.toFixed(4), 10)}` +
      `          ${r4[k].separability.toFixed(2)}`);
  }
  console.log('\n     NO — r₄ separability ' + r4.r4.separability.toFixed(2) + ' against r₁ ' +
    r4.r1.separability.toFixed(2) + ' and r₂ ' + r4.r2.separability.toFixed(2) + '. r₄ reports who is');
  console.log('     talking nearly as much as what they said. Held out by speaker, a 4-dimension');
  const f4c = f4ClassifierEval();
  console.log('     nearest-template classifier is WORSE than a 3-dimension one:');
  for (const d of [2, 3, 4]) {
    console.log(`       ${d} dims: ${pct(f4c[d].correct / f4c[d].n)} correct  (n=${f4c[d].n})`);
  }
  console.log('     So VOWEL_TEMPLATE_FORMANTS stays at 3, and now for a measured reason rather than');
  console.log('     because P&B published no F4. §7\'s question 2 is answered: F4 is worth its miss');
  console.log('     rate for the SCALE and is not worth a template.');
  console.log('\n     ONE EXCEPTION, and it is the interesting one — the r₄ template values:');
  console.log('       ' + Object.entries(r4.r4.template).map(([v, x]) => `${v} ${x.toFixed(3)}`).join('  '));
  console.log('     /ɝ/ sits at ' + r4.r4.template['ɝ'].toFixed(3) + ' against 0.94–1.03 for everything else. The rhotic lowers F3');
  console.log('     and LEAVES F4 UP. §5\'s Phase 4 entry abandoned exactly this test — "restricting the');
  console.log('     widened slot to poles corroborated by F4 is a physical claim and cannot be evaluated');
  console.log('     here, because the synthesized corpus places every vowel\'s F4 at 3.5·ΔF of that');
  console.log('     vowel\'s own fit, so the synthetic /ɝ/\'s F4 has already been dragged down with its');
  console.log('     F3". On real speakers it has not been. The physical claim holds.');

  // --- the rhotic ------------------------------------------------------------------------
  console.log('\n\n=== /ɝ/ — WHAT THIS CORPUS SETTLES, AND WHAT IT CANNOT ===\n');
  const rh = rhoticReal();
  const s = rh.f3.all;
  console.log('  Phase 4 left the rhotic assignment measured, exposed and SWITCHED OFF, with one stated');
  console.log('  blocker: "every number above is from a Klatt cascade whose /ɝ/ F3 is placed by');
  console.log('  construction ... The remaining blocker is that validation." Here is that validation at');
  console.log('  the formant level.\n');
  console.log(`  Real /ɝ/ F3, n=${s.n}: mean ${s.mean.toFixed(0)} Hz, SD ${s.sd.toFixed(0)}, ` +
    `range ${s.min}–${s.max}, median ${s.median}`);
  console.log(`    below the ${F3_FLOOR_HZ} Hz STANDARD assignment floor: ${s.belowStandardFloor}/${s.n}  (${pct(s.belowStandardFloor / s.n)})`);
  console.log(`    below the ${F3_RHOTIC_FLOOR_HZ} Hz WIDENED floor:        ${s.belowRhoticFloor}/${s.n}  (${pct(s.belowRhoticFloor / s.n)})`);
  console.log('\n    group     n    mean F3   median   <2000 Hz   <1500 Hz');
  for (const g of HB_GROUPS) {
    const o = rh.f3.byGroup[g];
    if (!o) continue;
    console.log(`    ${g.padEnd(7)} ${pad(o.n, 3)}    ${pad(o.mean.toFixed(0), 5)} Hz   ${pad(o.median, 5)}    ` +
      `${pad(o.belowStandardFloor, 5)}      ${pad(o.belowRhoticFloor, 5)}`);
  }
  console.log('\n  EVERY ONE of the 40 men is below the standard floor. P&B\'s adult-male /ɝ/ F3 of');
  console.log('  1690 Hz was not an artefact of averaging — the real adult-male mean is ' +
    rh.f3.byGroup.men.mean.toFixed(0) + ' Hz. The');
  console.log('  standard assignment structurally cannot resolve an F3 for a rhotic in an adult male');
  console.log('  voice, which is precisely the population this app is most used by.');
  console.log(`\n  THE FALSE-POSITIVE SURFACE OF THE WIDENED FLOOR IS EMPTY: ${rh.nonRhoticInBand} of ${rh.nonRhoticTotal} non-rhotic`);
  console.log(`  tokens have F3 in [${F3_RHOTIC_FLOOR_HZ}, ${F3_FLOOR_HZ}). There is nothing in that band for a widened floor`);
  console.log('  to manufacture a rhotic from. Phase 3 predicted the widening "manufactures rhotics";');
  console.log('  Phase 4 measured that it does not on synthetic vowels; real speakers say there is not');
  console.log('  even a candidate to be wrong about.');
  console.log('\n  ρ, ACROSS 139 REAL SPEAKERS (§5\'s Phase 3 entry measured 0.7212 vs 0.9053–1.1882 on the norms):');
  console.log('    ' + Object.entries(rh.rho).map(([v, o]) => `${v} ${o.mean.toFixed(3)}`).join('  '));
  console.log(`    shipped threshold √(0.7212·0.9053) = ${rh.rhoThreshold.toFixed(4)}:  ` +
    `recall ${pct(rh.rhoDetector.recall)}   false positives ${pct(rh.rhoDetector.falsePositiveRate)}`);
  console.log('    Phase 3\'s strict criterion is ≥50% recall and ≤5% false positives. On real formants');
  console.log('    it CLEARS BOTH, on a threshold that was derived from two published norms and never');
  console.log('    tuned. The shipped classifier also names real /ɝ/ correctly on ' +
    (() => { const e = speakerHeldOutEval({ templates: 'shipped' }); const p = e.perVowel['ɝ']; return pct(p.correct / (p.correct + p.wrong + p.abstain)); })() + ' of tokens —');
  console.log('    against 0% on the live path.');
  console.log('\n  WHAT THIS DOES NOT SETTLE, stated rather than implied. Every number above starts from');
  console.log('  the AUTHOR\'S hand-corrected formants. The live path\'s 0% /ɝ/ recall is not a');
  console.log('  thresholding failure, it is an extraction failure: the question is whether a root-');
  console.log('  solved LPC can produce a pole at 1700 Hz and have the assignment loop accept it as F3');
  console.log('  from AUDIO. This corpus contains audio (men.zip / women.zip / kids.zip) and this phase');
  console.log('  deliberately does not fetch it — Tier 2. So:');
  console.log('    SETTLED   — where a real rhotic\'s F3 sits, in 139 mouths, per group; that the');
  console.log('                standard floor excludes essentially all adult-male rhotics; that the');
  console.log('                widened floor admits no non-rhotic; that ρ and the shipped threshold');
  console.log('                work on real formants; that F4 stays up when a real rhotic\'s F3 drops.');
  console.log('    NOT SETTLED — whether the extractor finds that F3 in real audio, at real F0s, with');
  console.log('                real breathiness and room. That is Tier 2 and it is the remaining');
  console.log('                blocker. It is now the ONLY remaining blocker.');

  // --- f2Position ------------------------------------------------------------------------
  console.log('\n\n=== f2Position, RE-MEASURED ON REAL SPEAKERS ===\n');
  const f2 = f2PositionReal();
  const f2o = f2PositionReal({ oracle: true });
  const line = (label, o) => `  ${label.padEnd(34)} d′ across-vowel ${pad(o.dAcrossVowel.toFixed(3), 7)}   ` +
    `across-speaker ${pad(o.dAcrossSpeaker.toFixed(3), 7)}   AUC ${o.aucSpeaker.toFixed(3)}`;
  console.log('  CONTRAST 1 — women vs men. Phase 4 demoted this from a gate to a descriptive figure.');
  console.log(line('raw F2', f2.sex.rawF2));
  console.log(line('f2Position (shipped classifier)', f2.sex.f2Position));
  console.log(line('f2Position (oracle vowel)', f2o.sex.f2Position));
  console.log(`\n  The P&B figure is 0.105; with an oracle vowel the real-speaker figure is ` +
    `${f2o.sex.f2Position.dAcrossVowel.toFixed(3)} — the`);
  console.log('  same number. f2Position carries no tract size on real speakers either, which is what');
  console.log('  it is designed not to carry. The criterion as originally written is still missed, and');
  console.log('  still deliberately.\n');
  console.log('  CONTRAST 2 — §1.5\'s published GAVT within-speaker shift (F2 1847 → 1961 Hz, +6.2%),');
  console.log('  applied to every real speaker at their own fixed tract length.');
  console.log(line('raw F2', f2.training.rawF2));
  console.log(line('f2Position (shipped classifier)', f2.training.f2Position));
  console.log(line('f2Position (oracle vowel)', f2o.training.f2Position));
  console.log(`\n  DOES THE GAVT RESULT SURVIVE? YES, WITH A MUCH SMALLER MARGIN, and here is the number:`);
  console.log(`  on P&B f2Position beat raw F2 by 13× (2.085 vs 0.158). On 139 real speakers it is`);
  console.log(`  ${(f2.training.f2Position.dAcrossVowel / f2.training.rawF2.dAcrossVowel).toFixed(1)}× (${f2.training.f2Position.dAcrossVowel.toFixed(3)} vs ${f2.training.rawF2.dAcrossVowel.toFixed(3)}), and ${(f2o.training.f2Position.dAcrossVowel / f2o.training.rawF2.dAcrossVowel).toFixed(1)}× with an oracle vowel. The direction and the`);
  console.log('  conclusion hold; the effect size does not. Two reasons, both worth stating:');
  console.log('    - the classifier is right on about half of real tokens, so f2Position is often');
  console.log('      computed against the wrong template;');
  console.log('    - and the shipped, classifier-driven number is partly SELF-FULFILLING — picking the');
  console.log('      nearest template makes the observed r₂ close to the template r₂ by construction,');
  console.log('      which narrows f2Position\'s own spread. That is why the oracle column is lower');
  console.log(`      (${f2o.training.f2Position.dAcrossVowel.toFixed(3)}) and why it is the one to quote when comparing to a future estimator.`);
  console.log(`\n  §3.1\'s across-vowel variance removal: raw F2 ${f2.varianceRemoved.rawPct.toFixed(1)}% of its mean → ` +
    `f2Position ${f2.varianceRemoved.positionPct.toFixed(2)}%,`);
  console.log(`  a ${f2.varianceRemoved.ratio.toFixed(1)}× reduction (oracle: ${f2o.varianceRemoved.ratio.toFixed(1)}×). On P&B this was 11.4×. The conditioning`);
  console.log('  still does what §3.1 claims; it does about a third as much of it on real voices.');

  console.log('\n\n=== WHAT THIS PHASE DID NOT TOUCH ===\n');
  console.log('  No threshold, template or weight changed. `npm run test:all` and the dsp-golden');
  console.log('  vectors pass untouched; the displayed metric has not moved. Everything above is a');
  console.log('  measurement or a proposal.\n');
}

const args = process.argv.slice(2);
if (args.includes('--check')) {
  const { ok, fails } = runChecks();
  for (const m of ok) console.log(`OK   ${m}`);
  for (const m of fails) console.log(`FAIL ${m}`);
  process.exit(fails.length ? 1 : 0);
} else {
  report();
}
