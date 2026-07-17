package dev.otagateway.host

import android.content.Context
import dev.otagateway.OtaUpdatesEnvironment

/**
 * Single source of truth for the host's developer preferences: which OTA
 * environment to point expo-updates at, and whether to load JS from the local
 * Metro dev server (Mode A) instead of the OTA/embedded bundle (Mode B).
 *
 * Both are read once at process start (in [OtaHostApplication]); expo-updates
 * configuration is fixed for the process lifetime, so changing either requires
 * an app relaunch ("restart required").
 */
object DebugPrefs {
    private const val NAME = "dev.otagateway.host.debug"
    private const val KEY_USE_METRO = "use_metro_dev_server"
    private const val KEY_ENVIRONMENT = "ota_environment"

    private fun prefs(context: Context) =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /** Mode A when true (JS from Metro); Mode B (OTA/embedded) when false. Default false. */
    fun useMetro(context: Context): Boolean =
        prefs(context).getBoolean(KEY_USE_METRO, false)

    fun setUseMetro(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_USE_METRO, enabled).apply()
    }

    /**
     * The selected OTA environment. Defaults to PRODUCTION (fail toward
     * production, matching the baked default in app.config.ts).
     */
    fun environment(context: Context): OtaUpdatesEnvironment {
        val name = prefs(context).getString(KEY_ENVIRONMENT, null)
        return OtaUpdatesEnvironment.entries.firstOrNull { it.name == name }
            ?: OtaUpdatesEnvironment.PRODUCTION
    }

    fun setEnvironment(context: Context, environment: OtaUpdatesEnvironment) {
        prefs(context).edit().putString(KEY_ENVIRONMENT, environment.name).apply()
    }
}
