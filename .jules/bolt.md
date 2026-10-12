## 2024-10-12 - Avoid reduce chains in DSP code
**Learning:** In performance-critical DSP code paths (like `dsp-utils.js`), array iteration via `.reduce()` is a noticeable bottleneck due to closure allocation overhead, especially when chained three times in a single method (`windowHomogeneity`).
**Action:** Optimize these paths by replacing `reduce` chains or double reductions with single-pass traditional `for` loops.
