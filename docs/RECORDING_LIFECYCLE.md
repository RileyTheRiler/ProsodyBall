# Recording memory and resource lifecycle

Recordings are local, in-memory tab data. They are not persisted across a reload and are not
uploaded. Users must download a clip before deleting it or closing the tab if they want to keep it.

## Product limits

| Resource | Limit | Behavior at the limit |
|---|---:|---|
| One take | 10 minutes | The take stops and saves; the accessible status banner explains why. |
| Saved clips | 20 | A new take is refused until the user downloads/deletes a clip. |
| Saved audio | 256 MiB per tab | A new take is refused when full; an active take stops at its remaining budget. |
| Active audio | 64 MiB per take | The take stops and saves. MediaRecorder checks one-second chunks; a browser may coalesce chunks, so the final emitted chunk can cross the threshold. |
| Metric snapshots | 25 per second; 15,001 per take | Sampling stops at the ten-minute ceiling. |
| Concurrent download hand-offs | 4 | Extra download clicks are refused for about one second instead of accumulating Blob URLs. |

No saved clip is silently evicted or truncated. Byte/duration limits stop the active take and save
what the browser has emitted. The UI tells the user when a limit caused the stop.

## Ownership and cleanup

| Resource | Owner | Released on |
|---|---|---|
| `MediaRecorder` chunks | Active `RecordingAttempt` | Successful Blob construction, recorder error/timeout, cancellation, or page hide |
| PCM fallback `Int16Array` windows | Active `RecordingAttempt` | WAV construction, failure, cancellation, or page hide |
| Per-take metric snapshots | Active `RecordingAttempt` | Summary/phrase analysis, failure, cancellation, or page hide |
| Saved audio `Blob` | `recordings[]` entry | Delete, Clear all, or page close/reload |
| Playback object URL | Current playback consumer | Stop, ended, playback error, replacement, deletion, restart, or page hide |
| Download object URL | Download hand-off consumer | One-second post-click grace timer or page hide |
| Playback `Audio` and its listeners | Current playback consumer | Stop, ended, error, replacement, deletion, restart, or page hide |
| Recorder interval and stop timeout | Active/finalizing take | Every success, failure, cancellation, limit stop, restart, or page hide |
| Input stream and Web Audio graph | `VoiceAnalyzer` session | Analyzer stop/start failure; the recorder borrows the stream and never owns or stops it |

Every take and playback receives a monotonically increasing token. Callbacks verify that token
before adding chunks, saving a Blob, changing controls, or clearing playback. A callback from an
invalidated take cannot append to a later take or restore a deleted resource.

## Deterministic diagnostics

`game.getRecordingResourceSnapshot()` reports retained Blob bytes, retained/active chunks,
retained/active metric samples, object URLs, stream tracks, recording nodes, audio elements,
timers, and playback listeners. Tests assert these counts instead of depending on heap snapshots
or garbage-collector timing.

The browser stress test runs 40 record/stop/play/delete cycles, an export followed immediately by
deletion, and a cancelled take. Unit tests simulate the full ten-minute metric timeline, PCM byte
limits, stale callbacks, URL grace periods, and 200 start/cancel cycles.
