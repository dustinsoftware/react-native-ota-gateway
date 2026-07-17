package dev.otagateway.host

import android.app.Application
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import dev.otagateway.ReactNativeHostManager

/**
 * Host Application. Implements [ReactApplication] so expo-updates'
 * RelaunchProcedure can find the brownfield ReactHost -- the OTA reload path
 * ([BrownfieldReloadHandler]) aborts without it.
 *
 * onCreate boots RN according to the developer prefs:
 * - Metro mode (Metro toggle on): [ReactNativeDevHostManager] with dev support.
 * - Shipping mode (default): the AAR's [ReactNativeHostManager], pointing expo-updates
 *   at the selected environment's OTA endpoint before the controller is created.
 *
 * The bridge message dispatcher is registered afterward: one listener parses
 * every RN -> native message and routes reload/saveState/navigate to their
 * handlers.
 */
class OtaHostApplication : Application(), ReactApplication {

    override fun onCreate() {
        super.onCreate()

        if (DebugPrefs.useMetro(this)) {
            ReactNativeDevHostManager.initialize(this)
        } else {
            ReactNativeHostManager.initialize(this, DebugPrefs.environment(this), null)
        }

        BrownfieldMessageDispatcher.register(this)
    }

    /**
     * The brownfield RN host, for expo-updates' RelaunchProcedure. Null until
     * the RN runtime initializes in [onCreate].
     */
    override val reactHost: ReactHost?
        get() = try {
            ReactNativeBrownfield.shared.reactHost
        } catch (e: kotlin.UninitializedPropertyAccessException) {
            // RN brownfield runtime not initialized yet; nothing to expose.
            null
        }
}
