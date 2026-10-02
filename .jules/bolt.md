## 2024-05-19 - Fast metric sample counting
**Learning:** Found multiple instances of `Array.prototype.reduce` being used in performance-sensitive utility functions (`retainedAudioBytes`, `retainedMetricSamples`) inside `recording-lifecycle.js`.
**Action:** Traditional `for` loops are objectively faster than array-methods on hot paths, so replaced the `reduce` implementations with basic loops while maintaining the exact same logic.
