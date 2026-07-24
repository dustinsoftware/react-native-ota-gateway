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
 * - Mode A (Metro toggle on): [ReactNativeDevHostManager] with dev support.
 * - Mode B (default): the AAR's [ReactNativeHostManager], pointing expo-updates
 *   at the selected environment's OTA endpoint before the controller is created.
 *
 * The reload handler is registered afterward so a downloaded OTA update can be
 * applied in place.
 */
class OtaHostApplication : Application(), ReactApplication {

    override fun onCreate() {
        super.onCreate()

        if (DebugPrefs.useMetro(this)) {
            ReactNativeDevHostManager.initialize(this)
        } else {
            ReactNativeHostManager.initialize(this, DebugPrefs.environment(this), null)
        }

        BrownfieldReloadHandler.register()
        HostStateStore.register(this)
        HostNavigationHandler.register(this)
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
