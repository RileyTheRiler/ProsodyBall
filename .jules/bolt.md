## 2026-09-21 - Native Sorting with Typed Arrays
**Learning:** Using `array.map().sort()` for sorting numerical data requires intermediate array allocations and uses JS comparison functions, which is noticeably slower.
**Action:** Pre-allocate a typed array (like `Float64Array`), populate it using a `for` loop, and then call `.sort()` to eliminate intermediate allocations and use native C++ sorting, significantly improving execution time.
