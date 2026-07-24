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
 * Persists the selected native tab/route across the Activity relaunches the
 * host uses to switch tabs.
 *
 * Tab switching relaunches [RNHostActivity] rather than swapping fragments in
 * place (see the class doc for why), so the selected route must survive that
 * relaunch. It also survives an OTA relaunch and process death, so the host
 * restores the same tab the user was on. Stored by enum name (not RN path;
 * the native More tab has none); unknown values fall back to [HostRoute.DEFAULT].
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
