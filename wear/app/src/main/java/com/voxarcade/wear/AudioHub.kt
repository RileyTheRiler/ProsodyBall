package com.voxarcade.wear

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Process-wide audio singletons shared between [VoiceCaptureService] (which owns the
 * capture lifecycle + alert loop so it survives screen-off) and the UI (which only
 * observes the same [MicEngine] for display). Keeping one engine instance here avoids
 * the complexity of a bound service: start/stop is driven by the service, while the
 * Activity reads the same StateFlows.
 */
object AudioHub {
    /** The single capture/DSP engine for the whole process. */
    val engine = MicEngine()

    /** True while the eyes-free Necklace mode is active (so the service buzzes). */
    val necklaceActive = AtomicBoolean(false)
}
