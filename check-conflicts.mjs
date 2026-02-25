import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.wav', '.zip']);

async function walk(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.gitattributes') {
      if (e.isDirectory()) continue;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, acc);
    } else {
      const dot = e.name.lastIndexOf('.');
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : '';
      if (!SKIP_EXT.has(ext)) acc.push(full);
    }
  }
  return acc;
}

const markerRe = /^(<{7}|={7}|>{7})/m;
const files = await walk(ROOT);
const hits = [];
for (const file of files) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  if (markerRe.test(text)) {
    hits.push(file.replace(`${ROOT}/`, ''));
  }
}

if (hits.length) {
  console.error('❌ Merge conflict markers found in:');
  hits.forEach((f) => console.error(` - ${f}`));
  process.exit(1);
}

console.log('✅ No merge conflict markers found.');
