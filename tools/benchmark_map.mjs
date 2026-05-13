import { performance } from 'perf_hooks';

const ITERATIONS = 100000;

function benchInlineMap() {
    let sum = 0;
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        const guides = [100, 150, 200, 250, 300].map((hz) => ({
            hz,
            norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
        }));
        for (const guide of guides) {
            sum += guide.norm;
        }
    }
    const end = performance.now();
    console.log(`Inline Map: ${end - start} ms, sum=${sum}`);
}

const PITCH_GUIDES = [100, 150, 200, 250, 300].map((hz) => ({
    hz,
    norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
}));

function benchHoistedLoop() {
    let sum = 0;
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        for (let j = 0; j < PITCH_GUIDES.length; j++) {
            sum += PITCH_GUIDES[j].norm;
        }
    }
    const end = performance.now();
    console.log(`Hoisted Loop: ${end - start} ms, sum=${sum}`);
}

benchInlineMap();
benchHoistedLoop();
