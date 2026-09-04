## 2023-10-27 - Fast Array Sorting with TypedArrays
**Learning:** Using `.map().sort()` on arrays of objects generates intermediate array allocations and incurs overhead by implicitly casting to strings and doing a lexicographical sort.
**Action:** When sorting numeric values from objects, pre-allocate `Float64Array` buffers and use native `.sort()`. This prevents intermediate allocations and triggers native fast C++ sorting logic under the hood in V8, reducing sort times drastically.
