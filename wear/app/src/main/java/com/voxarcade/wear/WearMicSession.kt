package com.voxarcade.wear

/** Combined engine and permission/lifecycle counts for deterministic diagnostics. */
data class WearMicSessionSnapshot(
    val engine: WearMicResourceSnapshot,
    val pendingPermissionAttempts: Int,
    val lifecycleListeners: Int,
)

/**
 * Activity-level owner for permission requests and [MicEngine].
 *
 * Permission callbacks do not carry an application token, so one OS request remains
 * in flight until its callback arrives. [stop] invalidates its generation; a late grant
 * may update Android's permission state, but cannot restart this or a later session.
 */
class WearMicSession internal constructor(private val engine: MicEngine) {
    private val lock = Any()
    private var generation = 0L
    private var permissionGeneration: Long? = null
    private var lifecycleListenerCount = 0

    /** Starts immediately with permission, or launches exactly one permission request. */
    fun start(hasPermission: Boolean, launchPermission: () -> Unit): Boolean {
        if (hasPermission) return engine.start()
        synchronized(lock) {
            if (permissionGeneration != null) return true
            generation += 1
            permissionGeneration = generation
        }
        launchPermission()
        return true
    }

    /** Applies a permission result only to the still-current request generation. */
    fun onPermissionResult(granted: Boolean): Boolean {
        val shouldStart = synchronized(lock) {
            val requestGeneration = permissionGeneration ?: return false
            permissionGeneration = null
            granted && requestGeneration == generation
        }
        return if (shouldStart) engine.start() else false
    }

    /** Cancels permission ownership and stops the native capture; safe to repeat. */
    fun stop() {
        synchronized(lock) { generation += 1 }
        engine.stop()
    }

    internal fun lifecycleListenerAttached() = synchronized(lock) { lifecycleListenerCount = 1 }
    internal fun lifecycleListenerDetached() = synchronized(lock) { lifecycleListenerCount = 0 }

    fun resourceSnapshot(): WearMicSessionSnapshot = synchronized(lock) {
        WearMicSessionSnapshot(
            engine = engine.resourceSnapshot(),
            pendingPermissionAttempts = if (permissionGeneration == null) 0 else 1,
            lifecycleListeners = lifecycleListenerCount,
        )
    }
}
