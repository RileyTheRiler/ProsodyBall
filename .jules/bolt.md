## 2026-10-07 - Array Reductions in DSP Loops
**Learning:** Performance-critical DSP code paths (like `windowHomogeneity`) suffer from closure allocation overhead when using `.reduce()` chains or double reductions.
**Action:** Optimize these paths by replacing `reduce` chains with single-pass traditional `for` loops.
