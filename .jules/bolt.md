## 2026-10-01 - Avoid array.map().sort() for numbers
**Learning:** Using `array.map(mapFn).sort((a,b) => a-b)` and even `Float64Array.from(array, mapFn).sort()` for numerical arrays creates intermediate array allocations and can be much slower than populating a pre-allocated typed array using a standard `for` loop before sorting.
**Action:** When mapping and sorting numerical arrays, pre-allocate a typed array (e.g., `new Float64Array(length)`), populate it with a `for` loop, and call `.sort()`. This uses native C++ numerical sorting and avoids intermediate allocations.
