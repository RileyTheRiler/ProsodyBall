const { performance } = require('perf_hooks');

const crystallized = Array.from({length: 100}, (_, i) => ({avgF0: Math.random() * 200 + 100}));

function benchOriginal() {
  let res = 0;
  for(let x=0; x<10000; x++) {
    const pitches = crystallized.map(s => s.avgF0);
    let minP = pitches[0] || 0, maxP = pitches[0] || 0;
    for (let i = 1; i < pitches.length; i++) {
      if (pitches[i] < minP) minP = pitches[i];
      if (pitches[i] > maxP) maxP = pitches[i];
    }
    res += maxP;
  }
  return res;
}

function benchOptimized() {
  let res = 0;
  for(let x=0; x<10000; x++) {
    let minP = 0, maxP = 0;
    if (crystallized.length > 0) {
      minP = crystallized[0].avgF0;
      maxP = crystallized[0].avgF0;
      for (let i = 1; i < crystallized.length; i++) {
        const p = crystallized[i].avgF0;
        if (p < minP) minP = p;
        if (p > maxP) maxP = p;
      }
    }
    res += maxP;
  }
  return res;
}

const t0 = performance.now();
benchOriginal();
const t1 = performance.now();
console.log(`Original: ${t1 - t0}ms`);

const t2 = performance.now();
benchOptimized();
const t3 = performance.now();
console.log(`Optimized: ${t3 - t2}ms`);
