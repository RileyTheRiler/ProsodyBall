const iter = 100000;
console.time('original');
for (let i = 0; i < iter; i++) {
  const guides = [100, 150, 200, 250, 300].map((hz) => ({
    hz,
    norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
  }));
  for (const guide of guides) {
    const gy = 40 + (1 - guide.norm) * (1000 - 80);
  }
}
console.timeEnd('original');

console.time('bolt');
const PITCH_GUIDES = [100, 150, 200, 250, 300];
const PITCH_GUIDES_PRECALC = PITCH_GUIDES.map((hz) => ({
  hz,
  norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
}));

for (let i = 0; i < iter; i++) {
  for (let j = 0; j < PITCH_GUIDES_PRECALC.length; j++) {
    const guide = PITCH_GUIDES_PRECALC[j];
    const gy = 40 + (1 - guide.norm) * (1000 - 80);
  }
}
console.timeEnd('bolt');
