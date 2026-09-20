## 2024-09-20 - Float64Array for fast numerical sorting
**Learning:** Native `Float64Array.sort()` is measurably faster than `Array.prototype.map().sort((a,b) => a-b)` for numerical arrays because it avoids intermediate allocations and uses native C++ numerical sorting under the hood.
**Action:** When mapping and sorting a numerical array, pre-allocate a `Float64Array`, populate it with a `for` loop, and then call `.sort()`.
