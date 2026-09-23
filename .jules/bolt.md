## 2024-05-16 - Float64Array Sorting Optimization
**Learning:** When optimizing JS performance for mapping and sorting numerical arrays, avoid using `array.map(mapFn).sort((a,b) => a-b)`. Instead, pre-allocate a typed array (e.g., `new Float64Array(length)`), populate it using a standard `for` loop, and then call `.sort()`.
**Action:** Use Float64Array pre-allocation and native sorting for numerical arrays to eliminate intermediate array allocations and improve performance.
