## 2024-10-10 - Array Reduction Overhead in DSP
**Learning:** DSP functions that perform multiple iterations over arrays using chained map/filter/reduce closures cause unnecessary closure allocation and array creation overhead.
**Action:** Replace `reduce()` chains or double reductions with single-pass or dual-pass traditional `for` loops in performance-critical DSP code paths.
