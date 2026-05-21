const { performance } = require('perf_hooks');

const h = 600;

function benchOriginal() {
  let sum = 0;
  for(let i=0; i<100000; i++) {
    const guides = [100, 150, 200, 250, 300].map((hz) => ({
      hz,
      norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
    }));
    for (const guide of guides) {
      const gy = 40 + (1 - guide.norm) * (h - 80);
      sum += gy;
    }
  }
  return sum;
}

const PITCH_GUIDES = [100, 150, 200, 250, 300].map((hz) => ({
  hz,
  norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
}));

function benchOptimized() {
  let sum = 0;
  for(let i=0; i<100000; i++) {
    for (let j = 0; j < PITCH_GUIDES.length; j++) {
      const guide = PITCH_GUIDES[j];
      const gy = 40 + (1 - guide.norm) * (h - 80);
      sum += gy;
    }
  }
  return sum;
}

const t0 = performance.now();
benchOriginal();
const t1 = performance.now();
console.log(`Original: ${t1 - t0}ms`);

const t2 = performance.now();
benchOptimized();
const t3 = performance.now();
console.log(`Optimized: ${t3 - t2}ms`);
