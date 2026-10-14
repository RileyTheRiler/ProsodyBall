
## 2026-10-14 - Optimize closure allocations in DSP paths
**Learning:** In performance-critical DSP code paths (e.g., `dsp-utils.js`), array iteration via `.reduce()` is a known bottleneck due to closure allocation overhead. Multiple `.reduce()` calls in `windowHomogeneity` significantly slowed down execution.
**Action:** Replace `reduce` chains or double reductions with single-pass traditional `for` loops in hot code paths.
