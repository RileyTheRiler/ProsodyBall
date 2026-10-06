## 2024-10-06 - Costly Function Chaining in DSP Path
**Learning:** Found multiple instances where simple arrays were being processed with chained higher-order functions like `filter()` followed by multiple `reduce()` calls (e.g., in `windowHomogeneity`). In the frontend hot path of signal processing, this causes significant closure allocation overhead and redundant element iterations.
**Action:** Replace `filter/map/reduce` chains with traditional single-pass `for` loops in performance-critical DSP code.
