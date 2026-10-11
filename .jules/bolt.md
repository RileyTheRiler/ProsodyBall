## 2026-10-11 - Array map/reduce in DSP hot paths
**Learning:** In performance-critical DSP code paths (e.g., `dsp-utils.js`), array iteration via `.reduce()` is a known bottleneck due to closure allocation overhead.
**Action:** Optimize these paths by replacing `reduce` chains or double reductions with single-pass traditional `for` loops.
