# Wear microphone lifecycle

This contract covers the native Wear OS v2 application in `wear/app`. It is a
standalone `AudioRecord` pipeline. It does not use the web app's `MediaStream`, Web
Audio graph, Phone Microphone PeerJS relay, recording collection, or playback path.
Those resources remain owned by `VoiceAnalyzer`, the phone relay, and the recording
lifecycle documented elsewhere.

## Ownership

| Resource | Single owner | Release event |
|---|---|---|
| `AudioRecord` | One `MicEngine` capture generation | Stop, initialization/start/read failure, device loss, lifecycle stop, or disposal |
| Capture thread and PCM buffers | The same capture generation | Thread exit after its `AudioRecord` is stopped and released |
| Pitch/brightness estimators and published flows | `MicEngine` | Reused by the next generation; published live values reset on stop |
| Calibration counters | Active capture generation | Completion, stop, failure, or disposal |
| Permission request state | `WearMicSession` | Permission callback; stop invalidates its generation so a late grant cannot start audio |
| Activity lifecycle listener | `VoxApp` composition | Composition disposal; `ON_STOP` and `ON_DESTROY` stop the session |
| Haptic coroutine | Compose `LaunchedEffect` keyed to microphone state/settings | Microphone stops, relevant settings change, or composition disposal |

There is no Wear-owned `MediaStream`, `MediaStreamTrack`, `AudioContext`, Web Audio
node, Peer/relay/Bluetooth/WebRTC transport, JavaScript timer, object URL, recording
Blob, playback element, or export resource. Their deterministic Wear counts are zero.

## State and generation policy

`IDLE -> STARTING -> RUNNING` is the only successful path. Any initialization,
start, or read/device error ends in `FAILED` after releasing the generation's
capture. `stop()` is valid in every state and ends in `IDLE`.

- Every start and stop advances a monotonic generation.
- The worker checks its generation after factory creation, after capture start,
  after every blocking read, and while publishing a frame.
- Stop invalidates the generation before it asks `AudioRecord.stop()` to unblock
  the reader.
- A new start is refused while an older capture thread is still alive. This favors
  a temporarily unavailable Start button over two simultaneous microphone owners.
- The worker that acquired an `AudioRecord` releases it in `finally`, including
  uninitialized, start-failure, cancellation, and device-loss paths.
- Repeated start and stop calls do not create or retain additional owners.

Android's permission launcher does not expose a cancellable promise or return an
application token. `WearMicSession` therefore keeps at most one OS request in flight.
Stop invalidates its generation. A later callback clears the pending count but cannot
start the stopped session. A second request is not launched until that callback arrives.

## Deterministic diagnostics

`MicEngine.resourceSnapshot()` reports:

- generation and microphone state;
- live `AudioRecord` owners;
- live capture threads;
- pending engine starts;
- active calibration captures; and
- explicit zero counts for browser streams/tracks, contexts/nodes, transports,
  timers, retry loops, and engine listeners.

`WearMicSession.resourceSnapshot()` adds pending permission attempts and attached
activity lifecycle listeners. Tests assert resource counts rather than heap size.

## Terminal paths

| Path | Required result |
|---|---|
| Repeated start | Existing `STARTING`/`RUNNING` generation remains the sole owner |
| Repeated stop | No-op after the first cleanup; all live values stay reset |
| Permission denial | No engine start and no audio resource |
| Failure after capture allocation | Capture stopped/released; state `FAILED` |
| Stop during initialization | Generation invalidated; late capture released before use |
| Device/read failure | Capture stopped/released; state `FAILED`; a later Start creates one replacement |
| Activity background/destruction | Pending permission generation invalidated and engine stopped |
| Late permission callback | Callback clears its pending slot but cannot restore a stopped generation |
| Voice/Necklace/Screen tab change | Same microphone generation continues; tabs do not own input |

## Product boundaries and limitations

- Wear v2 has no recording, playback, export, microphone selector, phone relay, or
  switch to the browser's ordinary microphone. This PR intentionally does not add
  those features or alter their web implementations.
- JVM tests use a deterministic capture seam. The APK build verifies Android API
  integration, but a physical Wear OS device is still required to verify OEM
  permission UI, `AudioRecord.stop()` behavior during device loss, microphone
  indicator release, and watch sleep/background behavior.
- If an OEM `AudioRecord` call ignores both `stop()` and thread interruption beyond
  the bounded join, diagnostics retain the live thread/pending count and a new start
  is refused until the old owner exits.
