package dev.otagateway.host

import android.content.Context
import android.content.Intent
import android.util.Log
import com.callstack.reactnativebrownfield.OnMessageListener
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import org.json.JSONException
import org.json.JSONObject

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
    private const val TAG = "HostNavigation"

    fun register(context: Context) {
        val appContext = context.applicationContext
        ReactNativeBrownfield.shared.addMessageListener(
            OnMessageListener { message ->
                when (parseDestination(message)) {
                    Brownfield.SETTINGS_DESTINATION ->
                        // Launched from the application context (the bridge has
                        // no Activity); NEW_TASK is required for that, and the
                        // settings activity lands on the existing task's stack.
                        appContext.startActivity(
                            Intent(appContext, HostSettingsActivity::class.java)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    else -> Unit
                }
            },
        )
    }

    private fun parseDestination(message: String): String? =
        try {
            val json = JSONObject(message)
            if (json.optString("type") == Brownfield.NAVIGATE_MESSAGE_TYPE) {
                json.optString("destination").takeIf(String::isNotEmpty)
            } else {
                null
            }
        } catch (e: JSONException) {
            Log.d(TAG, "Ignoring malformed brownfield message", e)
            null
        }
}
