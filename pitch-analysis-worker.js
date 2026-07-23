import { estimatePitchYin } from './pitch-estimator.js';

self.addEventListener('message', ({ data }) => {
  const { id, samples, options } = data;
  const result = estimatePitchYin(new Float32Array(samples), options);
  self.postMessage({ id, ...result });
});
