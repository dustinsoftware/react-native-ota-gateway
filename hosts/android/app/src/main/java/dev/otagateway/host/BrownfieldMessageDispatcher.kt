package dev.otagateway.host

import android.content.Context
import android.util.Log
import com.callstack.reactnativebrownfield.OnMessageListener
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import org.json.JSONException
import org.json.JSONObject

/**
 * The single bridge listener: every RN -> native message is parsed ONCE into a
 * [BrownfieldMessage] and dispatched to its handler, mirroring iOS's
 * `BrownfieldBootstrap.parseMessage` + switch. Handlers ([BrownfieldReloadHandler],
 * [HostStateStore], [HostNavigationHandler]) no longer register their own
 * listeners or re-parse the raw JSON -- one parser is a prerequisite for
 * request/response correlation (a future navigate-with-result envelope would
 * otherwise need correlation logic per handler).
 *
 * Unknown or malformed messages are ignored (the bridge is untrusted input,
 * and a NEWER OTA bundle may post types this host predates -- see
 * docs/version-skew.md).
 */
object BrownfieldMessageDispatcher {
    private const val TAG = "BrownfieldDispatch"

    /** A parsed RN -> native bridge message. One case per contract type. */
    sealed interface BrownfieldMessage {
        data object Reload : BrownfieldMessage
        data class SaveState(val key: String, val stateJson: String) : BrownfieldMessage
        data class Navigate(val destination: String) : BrownfieldMessage
        data object TabsReady : BrownfieldMessage
    }

    fun register(context: Context) {
        val appContext = context.applicationContext
        ReactNativeBrownfield.shared.addMessageListener(
            OnMessageListener { message ->
                when (val parsed = parseMessage(message)) {
                    is BrownfieldMessage.Reload ->
                        BrownfieldReloadHandler.onReload()
                    is BrownfieldMessage.SaveState ->
                        HostStateStore.write(appContext, parsed.key, parsed.stateJson)
                    is BrownfieldMessage.Navigate ->
                        HostNavigationHandler.open(appContext, parsed.destination)
                    is BrownfieldMessage.TabsReady ->
                        TabsReadyRelay.announce()
                    null -> Unit
                }
            },
        )
    }

    /**
     * Parse a raw JSON bridge message, or null for malformed JSON or an
     * unrecognized/incomplete `type` (both ignored). Exposed for the contract
     * literals it consumes from [Brownfield]; tolerance semantics are the
     * skew guarantee and must not tighten.
     */
    private fun parseMessage(message: String): BrownfieldMessage? =
        try {
            val json = JSONObject(message)
            when (json.optString("type")) {
                Brownfield.RELOAD_MESSAGE_TYPE -> BrownfieldMessage.Reload
                Brownfield.SAVE_STATE_MESSAGE_TYPE -> {
                    val key = json.optString("key").takeIf(String::isNotEmpty)
                    val state = json.optJSONObject("state")
                    if (key != null && state != null) {
                        BrownfieldMessage.SaveState(key, state.toString())
                    } else {
                        null
                    }
                }
                Brownfield.NAVIGATE_MESSAGE_TYPE -> {
                    json.optString("destination").takeIf(String::isNotEmpty)
                        ?.let { BrownfieldMessage.Navigate(it) }
                }
                Brownfield.TABS_READY_MESSAGE_TYPE -> BrownfieldMessage.TabsReady
                else -> null
            }
        } catch (e: JSONException) {
            Log.d(TAG, "Ignoring malformed brownfield message", e)
            null
        }
}
