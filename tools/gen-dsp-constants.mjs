// Codegen for the cross-platform DSP constant spec (dsp-constants.json).
//
//   node tools/gen-dsp-constants.mjs           # (re)write the per-language files
//   node tools/gen-dsp-constants.mjs --check   # verify they are in sync (CI; exit 1 on drift)
//
// One spec → JS module + Kotlin object + C++ header, so a constant is edited once and
// drift across the three ports becomes impossible by construction. See docs/DSP_CONTRACT.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'dsp-constants.json'), 'utf8'));

const banner = (cmt) =>
  `${cmt} @generated from dsp-constants.json by tools/gen-dsp-constants.mjs — DO NOT EDIT.\n` +
  `${cmt} Edit the spec, then run \`npm run gen:constants\`. CI fails on drift (check:constants).`;

// Value for a platform: an explicit per-platform value, else the shared value, else absent.
function valueFor(c, platform) {
  if (c.perPlatform) {
    return Object.prototype.hasOwnProperty.call(c.perPlatform, platform) ? c.perPlatform[platform] : undefined;
  }
  return c.value;
}

// Render a numeric literal for the target language, preserving int/float intent.
function lit(v, type, lang) {
  if (type === 'int') return String(v);
  let s = Number.isInteger(v) ? v.toFixed(1) : String(v); // 20 -> "20.0", 0.08 -> "0.08"
  if (lang === 'cpp') s += 'f';
  return s;
}

function docLine(c) {
  if (!c.doc) return null;
  return c.unit ? `${c.doc} (${c.unit})` : c.doc;
}

function genJS() {
  const out = [banner('//'), ''];
  for (const [name, c] of Object.entries(spec.constants)) {
    const v = valueFor(c, 'js');
    if (v === undefined) continue;
    const d = docLine(c);
    if (d) out.push(`// ${d}`);
    out.push(`export const ${name} = ${lit(v, c.type, 'js')};`);
  }
  return out.join('\n') + '\n';
}

function genKotlin() {
  const out = [banner('//'), '', 'package com.voxarcade.wear', '',
    '/** Cross-platform DSP constants generated from dsp-constants.json. */', 'object DspConstants {'];
  for (const [name, c] of Object.entries(spec.constants)) {
    const v = valueFor(c, 'kotlin');
    if (v === undefined) continue;
    const ktType = c.type === 'int' ? 'Int' : 'Double';
    const d = docLine(c);
    if (d) out.push(`    /** ${d} */`);
    out.push(`    const val ${name}: ${ktType} = ${lit(v, c.type, 'kotlin')}`);
  }
  out.push('}');
  return out.join('\n') + '\n';
}

function genCpp() {
  const out = [banner('//'), '', '#pragma once', '',
    '// Cross-platform DSP constants generated from dsp-constants.json.', 'namespace dsp_constants {'];
  for (const [name, c] of Object.entries(spec.constants)) {
    const v = valueFor(c, 'cpp');
    if (v === undefined) continue;
    const cType = c.type === 'int' ? 'int' : 'float';
    const d = docLine(c);
    if (d) out.push(`  // ${d}`);
    out.push(`  constexpr ${cType} ${name} = ${lit(v, c.type, 'cpp')};`);
  }
  out.push('}  // namespace dsp_constants');
  return out.join('\n') + '\n';
}

const targets = [
  { file: 'dsp-constants.generated.js', gen: genJS },
  { file: 'wear/app/src/main/java/com/voxarcade/wear/DspConstants.kt', gen: genKotlin },
  { file: 'hardware/dsp_constants_generated.h', gen: genCpp },
];

const check = process.argv.includes('--check');
let drift = 0;
for (const t of targets) {
  const content = t.gen();
  const abs = path.join(ROOT, t.file);
  if (check) {
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    if (current !== content) {
      drift += 1;
      console.error(`DRIFT: ${t.file} is out of sync with dsp-constants.json`);
    }
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    console.log(`wrote ${t.file}`);
  }
}

if (check) {
  if (drift) {
    console.error(`\n${drift} generated file(s) out of sync. Run: npm run gen:constants`);
    process.exit(1);
  }
  console.log('All generated DSP constant files are in sync with dsp-constants.json.');
}
