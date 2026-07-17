package dev.otagateway.host

import android.content.Context

/**
 * The native tabs the host shell exposes, each mapped to the Expo Router route
 * it mounts in the shared brownfield runtime. Order matches the
 * BottomNavigationView order in [RNHostActivity].
 */
enum class HostRoute(val path: String) {
    DEVELOPER("/developer"),
    SKY("/sky"),
    SPINNER("/spinner"),
    ;

    companion object {
        val DEFAULT = DEVELOPER

        fun fromPath(path: String?): HostRoute =
            entries.firstOrNull { it.path == path } ?: DEFAULT
    }
}

/**
 * Persists the selected native tab/route across the Activity relaunches the
 * host uses to switch tabs.
 *
 * Tab switching relaunches [RNHostActivity] rather than swapping fragments in
 * place (see the class doc for why), so the selected route must survive that
 * relaunch. It also survives an OTA relaunch and process death, so the host
 * restores the same tab the user was on.
 */
object HostRoutePrefs {
    private const val NAME = "dev.otagateway.host.route"
    private const val KEY_ROUTE = "selected_route"

    private fun prefs(context: Context) =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun selectedRoute(context: Context): HostRoute =
        HostRoute.fromPath(prefs(context).getString(KEY_ROUTE, null))

    fun setSelectedRoute(context: Context, route: HostRoute) {
        prefs(context).edit().putString(KEY_ROUTE, route.path).apply()
    }
}
