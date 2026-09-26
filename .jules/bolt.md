## 2024-05-23 - Avoid intermediate allocations for Array.map().sort()
**Learning:** `Array.map().sort()` creates intermediate arrays which are inefficient.
**Action:** Use a pre-allocated typed array populated via a for-loop, then call `.sort()` to leverage native C++ sorting and avoid garbage collection overhead.
