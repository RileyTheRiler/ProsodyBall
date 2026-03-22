import { performance } from 'perf_hooks';

function generateBuffers(numBuffers, bufferSize) {
  const buffers = [];
  for (let i = 0; i < numBuffers; i++) {
    buffers.push(new Float32Array(bufferSize));
  }
  return buffers;
}

const numBuffers = 10000;
const bufferSize = 1024;
const buffers = generateBuffers(numBuffers, bufferSize);

function benchmarkReduce() {
  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    const totalLen = buffers.reduce((sum, b) => sum + b.length, 0);
  }
  const end = performance.now();
  console.log(`Reduce time: ${(end - start).toFixed(2)}ms`);
}

function benchmarkForLoop() {
  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    let totalLen = 0;
    for (let j = 0; j < buffers.length; j++) {
      totalLen += buffers[j].length;
    }
  }
  const end = performance.now();
  console.log(`For loop time: ${(end - start).toFixed(2)}ms`);
}

benchmarkReduce();
benchmarkForLoop();
