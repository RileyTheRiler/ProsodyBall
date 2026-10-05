## 2024-05-30 - [Performance bottleneck in array iteration]
**Learning:** Found multiple instances where array iteration via `.reduce()` is significantly slower than standard `for` loops in performance-critical code paths, notably in `aggregateSpeech` inside `dsp-utils.js`. The cost of closure allocation and function calls during `reduce` operations inside tight or frequently called loops can noticeably degrade frontend performance.
**Action:** Replace `reduce` chains or double reductions with single-pass traditional `for` loops inside metric aggregation functions.
