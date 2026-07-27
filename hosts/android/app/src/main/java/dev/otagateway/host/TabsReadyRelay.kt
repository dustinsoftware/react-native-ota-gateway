package dev.otagateway.host

/**
 * Relays the JS `tabsReady` handshake (see [BrownfieldMessageDispatcher]) to
 * the shell activity. [RNHostActivity] registers itself while started; on
 * notify it re-posts the currently selected tab so a `selectTab` that was
 * emitted before the JS listener subscribed (the cold-start lost-message
 * window) is recovered. The JS side treats a re-post idempotently, so a spurious
 * notify (e.g. the surface was mounted directly at the right tab) is a no-op.
 *
 * A single volatile slot suffices: at most one shell activity is started at a
 * time, and the bridge listener may fire off the main thread -- the listener
 * itself is responsible for hopping to the main thread.
 */
object TabsReadyRelay {
    @Volatile
    var listener: (() -> Unit)? = null

    fun announce() {
        listener?.invoke()
    }
}
