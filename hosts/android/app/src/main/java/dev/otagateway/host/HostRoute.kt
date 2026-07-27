package dev.otagateway.host

import android.content.Context

/**
 * The native tabs the host shell exposes. RN tabs carry the Expo Router route
 * they mount in the shared brownfield runtime; [MORE] is a NATIVE tab
 * (`path == null`) that mounts the native Test menu instead of an RN surface.
 * Order matches the BottomNavigationView order in [RNHostActivity].
 */
enum class HostRoute(val path: String?) {
    DEVELOPER("/developer"),
    SKY("/sky"),
    SPINNER("/spinner"),
    MORE(null),
    ;

    companion object {
        val DEFAULT = DEVELOPER

        fun fromName(name: String?): HostRoute =
            entries.firstOrNull { it.name == name } ?: DEFAULT
    }
}

/**
 * Persists the selected native tab/route so the host restores the same tab
 * across a recreation, an OTA relaunch, and process death.
 *
 * RN tab -> RN tab changes now keep the persistent RN root mounted (see
 * [RNHostActivity]) rather than relaunching the Activity, but the selected
 * route is still persisted on every tab change so onCreate can re-mount the
 * correct surface after a config change, OTA relaunch, or process death.
 * Stored by enum name (not RN path; the native More tab has none); unknown
 * values fall back to [HostRoute.DEFAULT].
 */
object HostRoutePrefs {
    private const val NAME = "dev.otagateway.host.route"
    private const val KEY_ROUTE = "selected_route"

    private fun prefs(context: Context) =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun selectedRoute(context: Context): HostRoute =
        HostRoute.fromName(prefs(context).getString(KEY_ROUTE, null))

    fun setSelectedRoute(context: Context, route: HostRoute) {
        prefs(context).edit().putString(KEY_ROUTE, route.name).apply()
    }
}
