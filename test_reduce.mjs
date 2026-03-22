const iter = 10000;
const arr = Array.from({length: 10000}, () => Math.random());

console.time('reduce');
for (let i = 0; i < iter; i++) {
  const sum = arr.reduce((a, b) => a + b, 0);
}
console.timeEnd('reduce');

console.time('for');
for (let i = 0; i < iter; i++) {
  let sum = 0;
  for (let j = 0; j < arr.length; j++) {
    sum += arr[j];
  }
}
console.timeEnd('for');
