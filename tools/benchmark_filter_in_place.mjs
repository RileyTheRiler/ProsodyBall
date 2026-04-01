const iterations = 10000;
const testArray = [];
for (let i = 0; i < 1000; i++) {
  testArray.push({ x: i, width: 10 });
}

console.time('filter');
for (let i = 0; i < iterations; i++) {
  let arr = testArray.slice();
  arr = arr.filter(b => b.x + b.width > 120);
}
console.timeEnd('filter');

console.time('splice-loop');
for (let i = 0; i < iterations; i++) {
  let arr = testArray.slice();
  for (let j = arr.length - 1; j >= 0; j--) {
    const b = arr[j];
    if (!(b.x + b.width > 120)) {
      arr.splice(j, 1);
    }
  }
}
console.timeEnd('splice-loop');

console.time('two-pointers');
for (let i = 0; i < iterations; i++) {
  let arr = testArray.slice();
  let keepCount = 0;
  for (let j = 0; j < arr.length; j++) {
    const b = arr[j];
    if (b.x + b.width > 120) {
      arr[keepCount++] = b;
    }
  }
  arr.length = keepCount;
}
console.timeEnd('two-pointers');
