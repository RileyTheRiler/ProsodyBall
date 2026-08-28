#!/usr/bin/env node
// Build fixtures/hillenbrand-1995.json from the author's published `vowdata.dat`.
//
// docs/RESONANCE_REDESIGN.md §5's validation ladder calls real vowels measured against
// hand-checked formants "the next real gap". Every constant the resonance redesign ships was
// derived from Peterson & Barney's TWO population MEANS; this corpus is 139 individual
// speakers, which is what makes speaker-independence testable rather than assertable.
//
// The fixture it writes is committed, so the benchmark runs offline and every number in the
// Phase 5 report is checkable from the repo alone. This tool exists so the committed fixture is
// REPRODUCIBLE — run it and the bytes should come back identical, sha256 included.
//
// Usage:
//   node tools/fetch-hillenbrand.mjs            # write fixtures/hillenbrand-1995.json
//   node tools/fetch-hillenbrand.mjs --check    # rebuild and diff against the committed file
//   node tools/fetch-hillenbrand.mjs --from=<path to a local vowdata.dat>
//
// ---------------------------------------------------------------------------------------------
// PROVENANCE, AND WHY THE URL IS AN ARCHIVE URL
//
// The canonical location is https://homepages.wmich.edu/~hillenbr/voweldata/vowdata.dat. As of
// this writing that host does not serve: Western Michigan University points `homepages.wmich.edu`
// at a redirect server presenting a certificate for `redirect.wmich.edu`, so the name fails TLS
// verification, and `wmich.edu/~hillenbr/...` returns 404. The file is therefore fetched from the
// Internet Archive's capture of the author's own URL, pinned to a specific capture timestamp so
// the fetch is reproducible rather than "whatever the archive serves today".
//
// LICENCE — read this before redistributing the fixture further.
//
// `vowdata.dat` opens with the line `(c) 1995 James Hillenbrand` and carries no licence, no
// terms of use, and no explicit grant of redistribution. The author published it for free
// download from his university page; that is permission to DOWNLOAD, which is not the same
// thing as a licence to REDISTRIBUTE, and this file does not pretend otherwise. What is
// committed here is a corpus of acoustic MEASUREMENTS — durations and frequencies — reproduced
// in full with the copyright notice, the JASA citation and the retrieval provenance attached,
// for measurement and validation of this repository's own DSP. The audio recordings, which are
// the part of the collection with an obvious creative-work claim, are NOT included and are not
// wanted here (Tier 2 is explicitly out of scope for Phase 5).
//
// If this repository is ever published under a licence, or the fixture is lifted out of it,
// that status needs revisiting with the author rather than inherited from this comment.
// ---------------------------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'fixtures', 'hillenbrand-1995.json');

export const CANONICAL_URL = 'https://homepages.wmich.edu/~hillenbr/voweldata/vowdata.dat';
export const ARCHIVE_CAPTURE = '2023';
export const ARCHIVE_URL =
  `https://web.archive.org/web/${ARCHIVE_CAPTURE}id_/${CANONICAL_URL}`;

// sha256 of the raw `vowdata.dat` bytes as retrieved, CRLF line endings and all. Recorded so a
// future run can say "the source changed" rather than silently rewriting the fixture.
export const SOURCE_SHA256 =
  '05a4a69e2c6b0f444077245b1427d12bc86f8d7a32ae7a4b63f7e06e5712e4b1';

// Hillenbrand's two-letter vowel codes → the IPA keys this repo already uses in
// fixtures/peterson-barney-1952.json, so the two corpora index the same way and the P&B-derived
// templates can be applied to Hillenbrand tokens without a translation layer at every call site.
//
// The keyword column is the author's own ("ae=had"), not this file's gloss. /e/ and /o/ have no
// P&B counterpart in that fixture — P&B tabulated ten monophthongs and these two are the
// diphthongised mid vowels — so they are carried with `inPetersonBarney: false` and every
// comparison against P&B excludes them explicitly rather than silently.
export const VOWEL_MAP = {
  iy: { ipa: 'i', keyword: 'heed', inPetersonBarney: true },
  ih: { ipa: 'ɪ', keyword: 'hid', inPetersonBarney: true },
  ei: { ipa: 'e', keyword: 'hayed', inPetersonBarney: false },
  eh: { ipa: 'ɛ', keyword: 'head', inPetersonBarney: true },
  ae: { ipa: 'æ', keyword: 'had', inPetersonBarney: true },
  ah: { ipa: 'ɑ', keyword: 'hod', inPetersonBarney: true },
  aw: { ipa: 'ɔ', keyword: 'hawed', inPetersonBarney: true },
  oa: { ipa: 'o', keyword: 'hoed', inPetersonBarney: false },
  oo: { ipa: 'ʊ', keyword: 'hood', inPetersonBarney: true },
  uw: { ipa: 'u', keyword: "who'd", inPetersonBarney: true },
  uh: { ipa: 'ʌ', keyword: 'hud', inPetersonBarney: true },
  er: { ipa: 'ɝ', keyword: 'heard', inPetersonBarney: true },
};

// m/w/b/g is the author's first filename character.
export const GROUP_MAP = {
  m: { group: 'men', sex: 'male', adult: true },
  w: { group: 'women', sex: 'female', adult: true },
  b: { group: 'boys', sex: 'male', adult: false },
  g: { group: 'girls', sex: 'female', adult: false },
};

// --- parsing -----------------------------------------------------------------
//
// Column layout is documented at the head of vowdata.dat itself. Only the STEADY-STATE columns
// are carried: they are the ones the paper's own tables and every downstream reuse quote, and
// they are what a sustained-vowel measurement in this app corresponds to. The 20/50/80% contour
// columns are deliberately dropped — see `absent` in the fixture.
//
//   1 filename  2 duration(ms)  3 f0  4 F1  5 F2  6 F3  7 F4   (steady state)
//   8-16        F1/F2/F3 at 20%, 50%, 80% of vowel duration
//
// "An entry of zero means that the formant was not measurable" (author's note). Zeros become
// `null`, never 0 — a missing formant is not a formant at 0 Hz, and the difference is the whole
// reason §6's abstention discipline exists.
export function parseVowdata(text) {
  const speakers = new Map();
  let rows = 0, skipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = /^([mwbg])(\d{2})([a-z]{2})\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, groupCh, talkerNum, vowelCode, rest] = m;
    const vowel = VOWEL_MAP[vowelCode];
    if (!vowel) { skipped++; continue; }
    const nums = rest.split(/\s+/).filter((s) => s.length).map(Number);
    if (nums.length < 6 || nums.some((n) => !Number.isFinite(n))) { skipped++; continue; }
    const [durationMs, f0, f1, f2, f3, f4] = nums;
    const id = `${groupCh}${talkerNum}`;
    if (!speakers.has(id)) {
      speakers.set(id, { id, ...GROUP_MAP[groupCh], tokens: {} });
    }
    const z = (v) => (v > 0 ? v : null);
    speakers.get(id).tokens[vowel.ipa] = {
      durationMs, f0: z(f0), f1: z(f1), f2: z(f2), f3: z(f3), f4: z(f4),
    };
    rows++;
  }
  // Sorted by group then talker number so the committed file is stable across runs.
  const order = ['m', 'w', 'b', 'g'];
  const list = [...speakers.values()].sort((a, b) =>
    (order.indexOf(a.id[0]) - order.indexOf(b.id[0])) || a.id.localeCompare(b.id));
  return { speakers: list, rows, skipped };
}

export function buildFixture(text, { sourceSha256 } = {}) {
  const { speakers, rows, skipped } = parseVowdata(text);
  const counts = {};
  for (const s of speakers) counts[s.group] = (counts[s.group] || 0) + 1;
  // Per-formant availability, reported in the fixture rather than discovered at read time. F4 is
  // the headline: P&B published NONE, so this is the first F4 any phase of this redesign has had
  // that was not placed by a synthesizer.
  const yieldOf = (k) => {
    let have = 0, total = 0;
    for (const s of speakers) for (const t of Object.values(s.tokens)) { total++; if (t[k] != null) have++; }
    return { measured: have, total, rate: Number((have / total).toFixed(4)) };
  };
  return {
    source: 'Hillenbrand, J., Getty, L. A., Clark, M. J., & Wheeler, K. (1995). Acoustic '
      + 'characteristics of American English vowels. Journal of the Acoustical Society of '
      + 'America, 97(5), 3099-3111. Per-speaker acoustic measurements as published by the first '
      + 'author in `vowdata.dat`.',
    copyright: '(c) 1995 James Hillenbrand — the verbatim notice on the first line of '
      + 'vowdata.dat. The file carries no licence and no stated terms of use; it was published '
      + 'for free download from the author\'s Western Michigan University page. Reproduced here '
      + 'in full, with attribution, as acoustic measurements used to validate this repository\'s '
      + 'DSP. The audio recordings (men.zip / women.zip / kids.zip) are NOT included.',
    retrieval: {
      canonicalUrl: CANONICAL_URL,
      canonicalUrlStatus: 'Not serving at the time of retrieval: homepages.wmich.edu presents a '
        + 'certificate for redirect.wmich.edu (hostname mismatch), and wmich.edu/~hillenbr/ 404s.',
      retrievedFrom: ARCHIVE_URL,
      archiveCapture: ARCHIVE_CAPTURE,
      sourceFile: 'vowdata.dat',
      sourceSha256: sourceSha256 || null,
      builtBy: 'tools/fetch-hillenbrand.mjs',
    },
    units: 'Hz, except durationMs (milliseconds)',
    measurementPoint: 'steady state',
    note: 'Formants are the author\'s hand-corrected LPC measurements at the vowel\'s '
      + '"steady state". A formant the author could not measure is null, never 0 — the source '
      + 'encodes it as 0 and the distinction is load-bearing (docs/RESONANCE_REDESIGN.md §6: a '
      + 'missing formant must produce an abstention, not a fabricated value).',
    absent: [
      'Audio. men.zip / women.zip / kids.zip are not fetched, not committed and not wanted: '
        + 'docs/RESONANCE_REDESIGN.md §5 Tier 2 is out of scope for this phase.',
      'The formant contour columns (F1-F3 at 20%, 50% and 80% of vowel duration) and the finer '
        + 'bigdata.dat sampling. Only the steady-state frame is carried, because that is the '
        + 'frame a sustained-vowel reading in this app corresponds to.',
      'The listener identification data (iddata.dat, misid.dat), the descriptive statistics file '
        + '(vowdata.ds) and the segmentation times (timedata.dat).',
      'Speaker age, region and any other talker metadata beyond the group encoded in the '
        + 'filename. The published .dat carries none.',
      'Talker numbers are not contiguous — the author notes "there are a few talker numbers that '
        + 'are not used (e.g., m05, w18, g03)". Ids are kept exactly as published rather than '
        + 'renumbered.',
    ],
    groups: counts,
    childGroups: ['boys', 'girls'],
    vowelMap: Object.fromEntries(Object.entries(VOWEL_MAP).map(([code, v]) => [code, v])),
    // The ten vowels this corpus shares with fixtures/peterson-barney-1952.json. Every
    // P&B-vs-Hillenbrand comparison runs on exactly this set, so a difference is never the two
    // corpora covering different vowels.
    petersonBarneyOverlap: Object.values(VOWEL_MAP).filter((v) => v.inPetersonBarney).map((v) => v.ipa),
    hillenbrandOnly: Object.values(VOWEL_MAP).filter((v) => !v.inPetersonBarney).map((v) => v.ipa),
    tokenCount: rows,
    formantYield: { f0: yieldOf('f0'), f1: yieldOf('f1'), f2: yieldOf('f2'), f3: yieldOf('f3'), f4: yieldOf('f4') },
    parseSkipped: skipped,
    speakers,
  };
}

// Two things reliably go wrong here, so they are named rather than left as a stack trace.
//
// 1. Node's built-in fetch does not read HTTPS_PROXY unless NODE_USE_ENV_PROXY=1, so behind an
//    egress proxy this times out with no proxy error at all. The npm scripts set it.
// 2. web.archive.org rate-limits, and a rate-limited connection is RESET rather than refused —
//    which reads as a network failure rather than as "wait and retry". Both are recoverable and
//    neither means the corpus has moved, so the message says so and points at --from=.
async function fetchSource() {
  try {
    const res = await fetch(ARCHIVE_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(
      `could not fetch ${ARCHIVE_URL}\n` +
      `  cause: ${err && err.message}\n` +
      '  The canonical host (homepages.wmich.edu) does not serve — it presents a certificate for\n' +
      '  redirect.wmich.edu — so this reads the Internet Archive instead, and the archive rate-limits.\n' +
      '  Behind an egress proxy, set NODE_USE_ENV_PROXY=1 (Node ignores HTTPS_PROXY without it).\n' +
      '  Otherwise download vowdata.dat by hand and pass it: --from=<path>.\n' +
      `  The committed fixture was built from sha256 ${SOURCE_SHA256}.`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const fromArg = args.find((a) => a.startsWith('--from='));
  const buf = fromArg
    ? fs.readFileSync(fromArg.slice('--from='.length))
    : await fetchSource();
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const fixture = buildFixture(buf.toString('utf8'), { sourceSha256: sha });
  const json = `${JSON.stringify(fixture, null, 2)}\n`;

  if (fixture.tokenCount !== 1668) {
    console.error(`FAIL expected 1668 tokens, parsed ${fixture.tokenCount}`);
    process.exit(1);
  }
  if (check) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (have === json) { console.log(`OK ${path.relative(process.cwd(), OUT)} matches the source (sha256 ${sha.slice(0, 12)}…)`); process.exit(0); }
    console.error(`FAIL ${path.relative(process.cwd(), OUT)} differs from a fresh build of the source.`);
    console.error(`     source sha256 ${sha}`);
    process.exit(1);
  }
  fs.writeFileSync(OUT, json);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`  source sha256 ${sha}`);
  console.log(`  ${fixture.tokenCount} tokens, ${fixture.speakers.length} speakers ` +
    `(${Object.entries(fixture.groups).map(([g, n]) => `${g} ${n}`).join(', ')})`);
  for (const [k, y] of Object.entries(fixture.formantYield)) {
    console.log(`  ${k}: ${y.measured}/${y.total} measured (${(100 * y.rate).toFixed(1)}%)`);
  }
}
