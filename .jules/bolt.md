## 2026-09-30 - Optimize Array map-and-sort
**Learning:** In Javascript, using `array.map(fn).sort((a,b) => a-b)` allocates intermediate arrays and uses JS engine generic sorting. Pre-allocating a typed array like `new Float64Array(len)`, populating it via a `for` loop, and calling `.sort()` leverages native C++ numerical sorting and avoids garbage collection overhead, making it significantly faster even for small arrays.
**Action:** Replace map-and-sort patterns with Float64Array for numerical arrays on hot paths.
