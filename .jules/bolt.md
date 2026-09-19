## 2024-05-30 - Optimize median calculation in summarizeVoiceCloud
**Learning:** Using `Array.prototype.map().sort()` on object arrays creates intermediate arrays and uses a slower JS comparison sort. Using `Float64Array` avoids allocations and uses faster native C++ sort for numeric data.
**Action:** Replace `pts.map().sort()` with pre-allocated `Float64Array` buffers populated via a `for` loop, then calling `.sort()`.
