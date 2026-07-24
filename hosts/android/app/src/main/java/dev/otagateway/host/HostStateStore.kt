package dev.otagateway.host

import android.content.Context
import android.util.Log
import com.callstack.reactnativebrownfield.OnMessageListener
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import org.json.JSONException
import org.json.JSONObject

/**
 * The native store behind the RN saved-state seam (apps/mobile
 * src/brownfield/host-state.ts).
 *
 * RN components checkpoint state slices by posting
 * `{ "type": "saveState", "key": <slice>, "state": <object> }` over the
 * brownfield message bridge; [register] writes each slice into
 * SharedPreferences. Every RN surface the host mounts gets the WHOLE store
 * back as the `savedStateJson` initial property ([readAllJson]), so a
 * dismissed component -- the fidget spinner mid-coast, say -- resumes exactly
 * where it left off, across tab switches, pushed screens, and process death.
 *
 * Slices are stored as JSON strings keyed by the RN-side slice key; malformed
 * slices are dropped on read (never propagated to a fresh surface).
 */
object HostStateStore {
    private const val TAG = "HostStateStore"
    private const val NAME = "dev.otagateway.host.state"
    private const val SAVE_STATE_MESSAGE_TYPE = "saveState"

    private fun prefs(context: Context) =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /** Subscribes to the brownfield bridge and persists saveState messages. */
    fun register(context: Context) {
        val appContext = context.applicationContext
        ReactNativeBrownfield.shared.addMessageListener(
            OnMessageListener { message ->
                parseSaveState(message)?.let { (key, stateJson) ->
                    prefs(appContext).edit().putString(key, stateJson).apply()
                }
            },
        )
    }

    /** The whole store as a JSON object of slices: `{"spinner": {...}, ...}`. */
    fun readAllJson(context: Context): String {
        val all = JSONObject()
        for ((key, value) in prefs(context).all) {
            if (value !is String) continue
            try {
                all.put(key, JSONObject(value))
            } catch (e: JSONException) {
                Log.w(TAG, "Dropping malformed saved-state slice '$key'", e)
            }
        }
        return all.toString()
    }

    /**
     * Extracts (key, state-JSON) from a raw bridge message, or null if it is
     * not a well-formed saveState message. The bridge is an untrusted input
     * source: anything malformed is ignored, matching BrownfieldReloadHandler.
     */
    private fun parseSaveState(message: String): Pair<String, String>? =
        try {
            val json = JSONObject(message)
            val key = json.optString("type").takeIf { it == SAVE_STATE_MESSAGE_TYPE }
                ?.let { json.optString("key").takeIf(String::isNotEmpty) }
            val state = json.optJSONObject("state")
            if (key != null && state != null) key to state.toString() else null
        } catch (e: JSONException) {
            Log.d(TAG, "Ignoring malformed brownfield message", e)
            null
        }
}
