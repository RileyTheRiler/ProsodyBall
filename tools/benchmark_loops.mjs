const iterations = 10000;
const testArray = [];
for (let i = 0; i < 1000; i++) {
  testArray.push({ state: i % 2 === 0 ? 'crystallized' : 'other', vowelScore: i % 2 === 0 ? Math.random() : 0, strainFlag: i % 10 === 0 });
}

console.time('filter-chain');
for (let i = 0; i < iterations; i++) {
  const crystallized = testArray.filter(s => s.state === 'crystallized');
  const scored = crystallized.filter(s => s.vowelScore > 0);
  let scoreSum = 0;
  for (let i = 0; i < scored.length; i++) {
    scoreSum += scored[i].vowelScore;
  }
  const avgScore = scored.length > 0 ? scoreSum / scored.length : 0;
  const strainCount = crystallized.filter(s => s.strainFlag).length;
}
console.timeEnd('filter-chain');

console.time('single-loop');
for (let i = 0; i < iterations; i++) {
  let crystallizedCount = 0;
  let scoreSum = 0;
  let scoredCount = 0;
  let strainCount = 0;

  for (let j = 0; j < testArray.length; j++) {
    const s = testArray[j];
    if (s.state === 'crystallized') {
      crystallizedCount++;
      if (s.vowelScore > 0) {
        scoreSum += s.vowelScore;
        scoredCount++;
      }
      if (s.strainFlag) {
        strainCount++;
      }
    }
  }
  const avgScore = scoredCount > 0 ? scoreSum / scoredCount : 0;
}
console.timeEnd('single-loop');
