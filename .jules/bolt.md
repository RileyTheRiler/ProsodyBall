## 2026-10-15 - Array reduce overhead in DSP paths
**Learning:** In performance-critical DSP code paths (e.g., `dsp-utils.js`), array iteration via `.reduce()` is a known bottleneck due to closure allocation overhead.
**Action:** Replace `reduce` chains or double reductions with traditional `for` loops in hot paths to avoid GC pauses and improve throughput.
