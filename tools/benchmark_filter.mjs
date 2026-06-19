const iterations = 10000;
const testArray = [];
for (let i = 0; i < 1000; i++) {
  testArray.push({ state: i % 2 === 0 ? 'crystallized' : 'other', id: i });
}

console.time('filter');
for (let i = 0; i < iterations; i++) {
  const result = testArray.filter(item => item.state === 'crystallized');
}
console.timeEnd('filter');

console.time('for-loop');
for (let i = 0; i < iterations; i++) {
  const result = [];
  for (let j = 0; j < testArray.length; j++) {
    if (testArray[j].state === 'crystallized') {
      result.push(testArray[j]);
    }
  }
}
console.timeEnd('for-loop');
