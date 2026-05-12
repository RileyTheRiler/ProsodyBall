import { performance } from 'node:perf_hooks';

function original() {
    const guides = [100, 150, 200, 250, 300].map((hz) => ({
      hz,
      norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
    }));
    let sum = 0;
    for (const guide of guides) {
        sum += guide.norm;
    }
    return sum;
}

const STATIC_GUIDES = [100, 150, 200, 250, 300];
const PRECOMPUTED_GUIDES = [100, 150, 200, 250, 300].map((hz) => ({
  hz,
  norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
}));

function optimized1() {
    let sum = 0;
    for (let i = 0; i < STATIC_GUIDES.length; i++) {
        const hz = STATIC_GUIDES[i];
        const norm = Math.max(0, Math.min(1, (hz - 80) / (300 - 80)));
        sum += norm;
    }
    return sum;
}

function optimized2() {
    let sum = 0;
    for (let i = 0; i < PRECOMPUTED_GUIDES.length; i++) {
        const guide = PRECOMPUTED_GUIDES[i];
        sum += guide.norm;
    }
    return sum;
}

const N = 100000;
const start1 = performance.now();
for (let i=0; i<N; i++) original();
const end1 = performance.now();
console.log('Original:', end1 - start1, 'ms');

const start2 = performance.now();
for (let i=0; i<N; i++) optimized1();
const end2 = performance.now();
console.log('Optimized1:', end2 - start2, 'ms');

const start3 = performance.now();
for (let i=0; i<N; i++) optimized2();
const end3 = performance.now();
console.log('Optimized2:', end3 - start3, 'ms');
