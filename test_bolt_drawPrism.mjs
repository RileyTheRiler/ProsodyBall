const iter = 10000;
const syllables = Array.from({length: 1000}, (_, i) => ({
  state: i % 2 === 0 ? 'crystallized' : 'pending',
  hue: Math.random() * 360,
  glowRadius: Math.random() * 10
}));

console.time('original');
for (let i = 0; i < iter; i++) {
  const crystallized = syllables.filter(s => s.state === 'crystallized');
  const progress = crystallized.length / Math.max(1, syllables.length);

  if (crystallized.length > 0) {
    const avgHue = crystallized.reduce((s, c) => s + c.hue, 0) / crystallized.length;
    const recentHue = crystallized.length > 0 ? crystallized[crystallized.length - 1].hue : avgHue;
  }
}
console.timeEnd('original');

console.time('bolt');
for (let i = 0; i < iter; i++) {
  let crystallizedCount = 0;
  let hueSum = 0;
  let lastCrystSyl = null;

  for (let j = 0; j < syllables.length; j++) {
    const syl = syllables[j];
    if (syl.state === 'crystallized') {
      crystallizedCount++;
      hueSum += syl.hue;
      lastCrystSyl = syl;
    }
  }

  const progress = crystallizedCount / Math.max(1, syllables.length);

  if (crystallizedCount > 0) {
    const avgHue = hueSum / crystallizedCount;
    const recentHue = lastCrystSyl.hue;
  }
}
console.timeEnd('bolt');
