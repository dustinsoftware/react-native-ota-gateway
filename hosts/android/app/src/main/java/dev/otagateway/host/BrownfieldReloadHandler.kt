package dev.otagateway.host

import android.util.Log
import expo.modules.updates.UpdatesController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

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

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** Invoked by [BrownfieldMessageDispatcher] for a parsed reload message. */
    fun onReload() {
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
}
