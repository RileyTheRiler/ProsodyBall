## 2024-10-24 - Typed Arrays for Fast Sorting
**Learning:** When optimizing JS performance for mapping and sorting numerical arrays, using `array.map(mapFn).sort((a,b) => a-b)` is inefficient.
**Action:** Pre-allocate a typed array (e.g., `new Float64Array(length)`), populate it using a standard `for` loop, and then call `.sort()`. This eliminates intermediate array allocations and uses native C++ numerical sorting.
