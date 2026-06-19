const { performance } = require('perf_hooks');

const h = 600;
const margin = 20;

function benchOriginal() {
  let res = 0;
  for(let x=0; x<10000; x++) {
    const guides = [100, 150, 200, 250, 300].map((hz) => ({
      hz,
      norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
    }));
    for (const guide of guides) {
      const gy = 40 + (1 - guide.norm) * (h - 80);
      res += gy;
    }
  }
  return res;
}

const PITCH_GUIDES = [100, 150, 200, 250, 300].map((hz) => ({
  hz,
  norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
}));

function benchOptimized() {
  let res = 0;
  for(let x=0; x<10000; x++) {
    for (let i = 0; i < PITCH_GUIDES.length; i++) {
      const gy = 40 + (1 - PITCH_GUIDES[i].norm) * (h - 80);
      res += gy;
    }
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
