## 2024-09-14 - Float64Array for Faster Median Calculation
**Learning:** Using `array.map(mapFn).sort((a,b) => a-b)` in tight loops or for median calculation creates intermediate array objects and relies on JavaScript's callback overhead during sorting, which is slow.
**Action:** Pre-allocate a `Float64Array`, populate it with a standard `for` loop, and call native `.sort()`. This avoids intermediate allocations and uses C++ numeric sorting for significant performance gains.
