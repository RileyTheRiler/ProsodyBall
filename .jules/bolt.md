## 2024-05-18 - Avoid array.map().sort() for numerical arrays
**Learning:** Using `array.map(fn).sort((a,b) => a-b)` and `Float64Array.from(array, fn).sort()` is significantly slower than pre-allocating a `Float64Array`, populating it via a `for` loop, and calling native `.sort()`.
**Action:** When extracting numerical features for sorting (like finding medians in metric summarization), explicitly allocate a typed array and avoid intermediate generic array allocations.
