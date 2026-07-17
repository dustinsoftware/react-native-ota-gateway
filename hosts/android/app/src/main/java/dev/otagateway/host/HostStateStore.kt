package dev.otagateway.host

import android.content.Context
import android.util.Log
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
    private const val MAX_SLICE_BYTES = 16 * 1024

    private fun prefs(context: Context) =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /**
     * Persist one slice (invoked by [BrownfieldMessageDispatcher] for a parsed
     * saveState message).
     *
     * commit() (synchronous), NOT apply(): surviving process death is this
     * store's whole point, and a force-stop can drop apply()'s
     * asynchronously-flushed write -- the spinner then resumes idle after a
     * kill. The bridge listener runs off the main thread, so the blocking
     * write is fine.
     */
    fun write(context: Context, key: String, stateJson: String) {
        // Size cap mirroring the JS-side guard (host-state.ts): the whole
        // store is injected into every mounted surface, so oversized slices
        // are dropped rather than stored. The secret-name denylist lives on
        // the JS side (the contract's enforcement point).
        if (stateJson.length > MAX_SLICE_BYTES) {
            Log.w(TAG, "Dropping oversized saved-state slice '$key' (${stateJson.length} bytes)")
            return
        }
        @Suppress("ApplySharedPref")
        prefs(context).edit().putString(key, stateJson).commit()
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

}
