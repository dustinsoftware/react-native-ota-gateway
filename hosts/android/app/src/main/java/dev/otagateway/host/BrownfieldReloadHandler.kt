package dev.otagateway.host

import android.util.Log
import com.callstack.reactnativebrownfield.OnMessageListener
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import expo.modules.updates.UpdatesController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONException
import org.json.JSONObject

/**
 * Applies a downloaded OTA update when the RN brownfield JS asks for it.
 *
 * The shared RN JS cannot rely on expo-updates' reloadAsync() in a brownfield
 * host, so after downloading an update it posts { "type": "reload" } over the
 * brownfield message bridge (see apps/mobile src/utils/reload-app.ts). This is
 * the Android handler: it relaunches through expo-updates' own RelaunchProcedure
 * ([UpdatesController.relaunchReactApplicationForModule]), which builds a new
 * launcher pointing at the freshly-downloaded update and reloads the ReactHost
 * in place.
 *
 * The procedure aborts unless the Application implements
 * [com.facebook.react.ReactApplication] and exposes the ReactHost, which is why
 * [OtaHostApplication] does.
 *
 * A failed relaunch is logged and otherwise ignored: the downloaded update
 * still applies on the next cold launch. Expected on the very first
 * (asset-bundle) launch, where expo-updates has no launched update to relaunch
 * from.
 */
object BrownfieldReloadHandler {
    private const val TAG = "BrownfieldReload"

    /** Message `type` the JS posts after an OTA update download (shared contract with iOS). */
    private const val RELOAD_MESSAGE_TYPE = "reload"

    fun register() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        ReactNativeBrownfield.shared.addMessageListener(
            OnMessageListener { message ->
                if (parseMessageType(message) == RELOAD_MESSAGE_TYPE) {
                    scope.launch {
                        try {
                            UpdatesController.instance.relaunchReactApplicationForModule()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            Log.e(
                                TAG,
                                "Brownfield OTA reload failed; the update applies on next launch",
                                e,
                            )
                        }
                    }
                }
            },
        )
    }

    /**
     * Pulls `type` out of a raw JSON bridge message. Returns null for malformed
     * JSON (logged) or a missing/empty type (silently) -- the bridge is an
     * untrusted input source, so neither is treated as an error.
     */
    private fun parseMessageType(message: String): String? =
        try {
            JSONObject(message).optString("type").takeIf { it.isNotEmpty() }
        } catch (e: JSONException) {
            Log.d(TAG, "Ignoring malformed brownfield message", e)
            null
        }
}
