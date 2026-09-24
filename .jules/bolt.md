## 2024-09-24 - Typed arrays for fast median calculations
**Learning:** In hot audio analysis paths, `array.map(fn).sort((a,b) => a-b)` and even `Float64Array.from(arr, fn).sort()` carry noticeable intermediate object allocation overhead and GC pressure.
**Action:** Pre-allocate a typed array (e.g., `new Float64Array(len)`), populate it using a standard `for` loop, and then call `.sort()`. This prevents object creation overhead and uses fast native C++ numerical sorting, making the sort up to 3-4x faster in tight loops.
