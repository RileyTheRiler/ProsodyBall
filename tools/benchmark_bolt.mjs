const iterations = 10000;
const testArr = [];
for (let i = 0; i < 500; i++) {
  testArr.push({ state: i % 2 === 0 ? 'crystallized' : 'pending', avgF0: Math.random() * 300, vowelScore: Math.random(), strainFlag: i % 10 === 0 });
}

console.time('filter.map');
for (let i = 0; i < iterations; i++) {
  const crystallized = testArr.filter(s => s.state === 'crystallized' && s.avgF0 > 0);
  const pitches = crystallized.map(s => s.avgF0);
  let minP = pitches[0] || 0, maxP = pitches[0] || 0;
  for (let j = 1; j < pitches.length; j++) {
    if (pitches[j] < minP) minP = pitches[j];
    if (pitches[j] > maxP) maxP = pitches[j];
  }
}
console.timeEnd('filter.map');

console.time('singlePass');
for (let i = 0; i < iterations; i++) {
  let minP = null, maxP = null;
  const pitches = [];
  for (let j = 0; j < testArr.length; j++) {
    const s = testArr[j];
    if (s.state === 'crystallized' && s.avgF0 > 0) {
      pitches.push(s.avgF0);
      if (minP === null || s.avgF0 < minP) minP = s.avgF0;
      if (maxP === null || s.avgF0 > maxP) maxP = s.avgF0;
    }
  }
}
console.timeEnd('singlePass');
