## 2024-09-13 - Float64Array Sort Performance
**Learning:** Using `Array.prototype.map().sort((a,b) => a-b)` for numerical sorting is measurably slower due to intermediate array allocations. Pre-allocating a `Float64Array`, populating it via a loop, and calling `.sort()` is significantly faster because it leverages native C++ numerical sorting and avoids garbage collection overhead.
**Action:** Always prefer `Float64Array` with pre-allocation over `Array.map().sort()` when sorting numbers, even for smaller arrays in hot paths.
