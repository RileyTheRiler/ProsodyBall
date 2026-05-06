import { performance } from 'perf_hooks';

function runFilter() {
  let barriers = Array.from({length: 100}, (_, i) => ({x: -150 + i * 10, width: 20}));
  for (let i = 0; i < 10000; i++) {
    barriers = barriers.filter(b => b.x + b.width > -120);
  }
}

function runSplice() {
  let barriers = Array.from({length: 100}, (_, i) => ({x: -150 + i * 10, width: 20}));
  for (let i = 0; i < 10000; i++) {
    for (let j = barriers.length - 1; j >= 0; j--) {
      if (barriers[j].x + barriers[j].width <= -120) {
        barriers.splice(j, 1);
      }
    }
  }
}

const t0 = performance.now();
runFilter();
const t1 = performance.now();
console.log(`Filter: ${t1 - t0}ms`);

const t2 = performance.now();
runSplice();
const t3 = performance.now();
console.log(`Splice: ${t3 - t2}ms`);
