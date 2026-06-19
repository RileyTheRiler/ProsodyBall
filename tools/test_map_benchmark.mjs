import { performance } from 'perf_hooks';

function benchmarkInlineMap() {
  const start = performance.now();
  let total = 0;
  for (let i = 0; i < 100000; i++) {
    const guides = [100, 150, 200, 250, 300].map((hz) => ({
      hz,
      norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
    }));
    for (const guide of guides) {
      total += guide.hz + guide.norm;
    }
  }
  const end = performance.now();
  console.log(`Inline .map() time: ${(end - start).toFixed(2)}ms`);
}

const PITCH_GUIDE_VALUES = [100, 150, 200, 250, 300];

function benchmarkForLoop() {
  const start = performance.now();
  let total = 0;
  for (let i = 0; i < 100000; i++) {
    for (let j = 0; j < PITCH_GUIDE_VALUES.length; j++) {
      const hz = PITCH_GUIDE_VALUES[j];
      const norm = Math.max(0, Math.min(1, (hz - 80) / (300 - 80)));
      total += hz + norm;
    }
  }
  const end = performance.now();
  console.log(`For loop time: ${(end - start).toFixed(2)}ms`);
}

benchmarkInlineMap();
benchmarkForLoop();
