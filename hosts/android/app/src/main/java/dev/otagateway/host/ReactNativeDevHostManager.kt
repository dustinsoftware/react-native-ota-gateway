package dev.otagateway.host

import android.app.Application
import com.callstack.reactnativebrownfield.OnJSBundleLoaded
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.facebook.react.PackageList
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

/**
 * Metro-mode initializer: boots the React Native brownfield runtime with developer
 * support enabled, so the JS bundle loads from the local Metro dev server (with
 * Fast Refresh) instead of the OTA/embedded bundle.
 *
 * Mirrors the AAR's [dev.otagateway.ReactNativeHostManager] but passes
 * useDevSupport = true to [ExpoReactHostFactory.getDefaultReactHost] and skips
 * the expo-updates configuration override (Metro owns the bundle URL here). The
 * runtime toggle works on Android because bundle resolution honors
 * useDevSupport at runtime; the host selects this via the "Use Metro dev
 * server" switch (see [DebugPrefs]).
 *
 * Metro host: RN dev support special-cases the standard emulator to
 * 10.0.2.2:8081 for the bundle download, but the app's own localhost requests
 * still need `adb reverse tcp:8081 tcp:8081` on the emulator too. Start Metro
 * with `pnpm --filter @ota-gateway/mobile start`.
 */
object ReactNativeDevHostManager {
    fun initialize(application: Application, onJSBundleLoaded: OnJSBundleLoaded? = null) {
        loadReactNative(application)

        ApplicationLifecycleDispatcher.onApplicationCreate(application)

        val reactHost: ReactHost by lazy {
            ExpoReactHostFactory.getDefaultReactHost(
                context = application.applicationContext,
                packageList = PackageList(application).packages,
                useDevSupport = true,
            )
        }

        ReactNativeBrownfield.initialize(application, reactHost, onJSBundleLoaded)
    }
}
