package dev.otagateway.host

import android.content.Context
import android.content.Intent

/**
 * Lets React Native navigate INTO native screens. The RN side posts
 * `{ "type": "navigate", "destination": <name> }` over the brownfield message
 * bridge (e.g. Test 2's "Open native Settings" button) and this handler
 * launches the matching native screen -- the reverse direction of the More
 * tab pushing RN screens, closing the mix-and-match loop.
 *
 * Only known destinations launch; anything else is ignored (the bridge is an
 * untrusted input source, matching the other handlers).
 */
object HostNavigationHandler {
    /** Invoked by [BrownfieldMessageDispatcher] for a parsed navigate message. */
    fun open(context: Context, destination: String) {
        when (destination) {
            Brownfield.SETTINGS_DESTINATION ->
                // Launched from the application context (the bridge has no
                // Activity); NEW_TASK is required for that, and the settings
                // activity lands on the existing task's stack.
                context.startActivity(
                    Intent(context, HostSettingsActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            else -> Unit
        }
    }
}
