import { test } from 'node:test';
import assert from 'node:assert';

function unoptimized(syllables) {
  const crystallized = syllables.filter(s => s.state === 'crystallized' && s.avgF0 > 0);
  if (crystallized.length < 3) return null;

  const pitches = crystallized.map(s => s.avgF0);
  let minP = pitches[0] || 0, maxP = pitches[0] || 0;
  for (let i = 1; i < pitches.length; i++) {
    if (pitches[i] < minP) minP = pitches[i];
    if (pitches[i] > maxP) maxP = pitches[i];
  }
  return { minP, maxP, crystallized, pitches };
}

function optimized(syllables) {
  const crystallized = [];
  let minP = Infinity, maxP = -Infinity;
  for (let i = 0; i < syllables.length; i++) {
    const s = syllables[i];
    if (s.state === 'crystallized' && s.avgF0 > 0) {
      crystallized.push(s);
      if (s.avgF0 < minP) minP = s.avgF0;
      if (s.avgF0 > maxP) maxP = s.avgF0;
    }
  }
  if (crystallized.length < 3) return null;
  return { minP, maxP, crystallized };
}

test('performance comparison', () => {
  const syllables = Array.from({length: 1000}, (_, i) => ({
    state: i % 2 === 0 ? 'crystallized' : 'active',
    avgF0: Math.random() * 200 + 100
  }));

  console.time('unoptimized');
  for (let i = 0; i < 10000; i++) {
    unoptimized(syllables);
  }
  console.timeEnd('unoptimized');

  console.time('optimized');
  for (let i = 0; i < 10000; i++) {
    optimized(syllables);
  }
  console.timeEnd('optimized');
});
