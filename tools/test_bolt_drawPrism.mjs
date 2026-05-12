import { performance } from 'node:perf_hooks';

const crystallized = Array.from({ length: 1000 }, (_, i) => ({ avgF0: Math.random() * 500 + 100, state: 'crystallized' }));

function original() {
    const pitches = crystallized.map(s => s.avgF0);
    let minP = pitches[0] || 0, maxP = pitches[0] || 0;
    for (let i = 1; i < pitches.length; i++) {
      if (pitches[i] < minP) minP = pitches[i];
      if (pitches[i] > maxP) maxP = pitches[i];
    }
    return [minP, maxP];
}

function optimized() {
    let minP = crystallized[0]?.avgF0 || 0;
    let maxP = crystallized[0]?.avgF0 || 0;
    for (let i = 1; i < crystallized.length; i++) {
      const pitch = crystallized[i]?.avgF0 || 0;
      if (pitch < minP) minP = pitch;
      if (pitch > maxP) maxP = pitch;
    }
    return [minP, maxP];
}

const N = 100000;
const start1 = performance.now();
for (let i=0; i<N; i++) original();
const end1 = performance.now();
console.log('Original:', end1 - start1, 'ms');

const start2 = performance.now();
for (let i=0; i<N; i++) optimized();
const end2 = performance.now();
console.log('Optimized:', end2 - start2, 'ms');
