## 2026-10-08 - Array Iteration Overhead in DSP Paths
**Learning:** In performance-critical DSP code paths (e.g., `dsp-utils.js`), array iteration via `.reduce()` is a known bottleneck due to closure allocation overhead.
**Action:** Optimize these paths by replacing `reduce` chains or double reductions with single-pass traditional `for` loops.
