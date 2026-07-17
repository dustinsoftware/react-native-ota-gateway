package dev.otagateway.host

import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.appcompat.widget.Toolbar
import dev.otagateway.OtaUpdatesEnvironment
import kotlin.system.exitProcess

/**
 * Native settings / developer-tools screen, opened from the host shell's
 * ([RNHostActivity]) toolbar Settings action (shown on the Developer tab).
 *
 * Shows the OTA URL per environment, an environment radio (persisted to prefs,
 * "restart required"), a "Use Metro dev server" switch (Metro mode, "restart
 * required"), and a Relaunch button. Built programmatically (no Compose, no XML
 * layout) to keep the host minimal.
 *
 * expo-updates configuration is fixed for the process lifetime, so the env and
 * Metro selections only take effect after a relaunch -- hence "restart
 * required" and the Relaunch button. Relaunch restarts the process; the host
 * shell restores the previously selected native tab from [HostRoutePrefs].
 */
class HostSettingsActivity : AppCompatActivity() {

    // OTA endpoints per environment, matching the AAR's OtaUpdatesEnvironment
    // enum (its updateUrl is internal to the AAR module, so it is mirrored here
    // for display). These MUST stay in sync with app.json extra.gatewayUrls
    // (which withBrownfieldUpdates.js bakes into the enum at prebuild); this map
    // is display-only and the compiler cannot catch drift. See docs/configuration.md.
    private val otaUrls = mapOf(
        OtaUpdatesEnvironment.DEVELOPMENT to "http://localhost:3000/api/v2/updates/manifest",
        OtaUpdatesEnvironment.PRODUCTION to "http://localhost:3001/api/v2/updates/manifest",
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val toolbar = Toolbar(this).apply {
            title = getString(R.string.settings_title)
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }

        content.addView(header("OTA Gateway Host"))
        content.addView(
            body(
                "Native dev-tools. Shipping mode (default) loads JS from OTA/embedded; " +
                    "Metro mode loads from Metro. expo-updates config is fixed per " +
                    "process, so changes below need a relaunch.",
            ),
        )

        content.addView(sectionTitle("OTA endpoints"))
        content.addView(body("development: ${otaUrls[OtaUpdatesEnvironment.DEVELOPMENT]}"))
        content.addView(body("production: ${otaUrls[OtaUpdatesEnvironment.PRODUCTION]}"))

        content.addView(sectionTitle("Environment (restart required)"))
        content.addView(buildEnvRadioGroup())

        content.addView(sectionTitle("Metro dev server (restart required)"))
        content.addView(buildMetroSwitch())

        content.addView(sectionTitle("Actions"))
        content.addView(
            actionButton(
                id = R.id.button_relaunch,
                label = "Relaunch app",
                description = "Relaunch app",
            ) { relaunch() },
        )

        val scroll = ScrollView(this).apply {
            addView(content)
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
            addView(toolbar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(scroll)
        }
        setContentView(root)
        setSupportActionBar(toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        toolbar.setNavigationOnClickListener { finish() }
    }

    private fun buildEnvRadioGroup(): RadioGroup {
        val current = DebugPrefs.environment(this)
        return RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
            addView(
                RadioButton(this@HostSettingsActivity).apply {
                    id = R.id.radio_env_development
                    text = "development (:3000)"
                    contentDescription = "Environment development"
                    isChecked = current == OtaUpdatesEnvironment.DEVELOPMENT
                },
            )
            addView(
                RadioButton(this@HostSettingsActivity).apply {
                    id = R.id.radio_env_production
                    text = "production (:3001)"
                    contentDescription = "Environment production"
                    isChecked = current == OtaUpdatesEnvironment.PRODUCTION
                },
            )
            setOnCheckedChangeListener { _, checkedId ->
                val env = if (checkedId == R.id.radio_env_development) {
                    OtaUpdatesEnvironment.DEVELOPMENT
                } else {
                    OtaUpdatesEnvironment.PRODUCTION
                }
                DebugPrefs.setEnvironment(this@HostSettingsActivity, env)
            }
        }
    }

    private fun buildMetroSwitch(): SwitchCompat =
        SwitchCompat(this).apply {
            id = R.id.switch_use_metro
            text = "Use Metro dev server"
            contentDescription = "Use Metro dev server"
            isChecked = DebugPrefs.useMetro(this@HostSettingsActivity)
            setOnCheckedChangeListener { _, checked ->
                DebugPrefs.setUseMetro(this@HostSettingsActivity, checked)
            }
        }

    /**
     * Fully restarts the process so a new environment / Metro selection is
     * picked up. finishAffinity() tears down the task; exitProcess ends the
     * process (Android relaunches the last activity of a killed foreground
     * task). The host shell restores the selected tab from [HostRoutePrefs].
     */
    private fun relaunch() {
        val intent = packageManager.getLaunchIntentForPackage(packageName)
        intent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        finishAffinity()
        if (intent != null) {
            startActivity(intent)
        }
        exitProcess(0)
    }

    // --- tiny view helpers (keep the host free of XML layouts) ---

    private fun header(text: String) = TextView(this).apply {
        this.text = text
        textSize = 22f
        setPadding(0, 0, 0, dp(8))
    }

    private fun sectionTitle(text: String) = TextView(this).apply {
        this.text = text
        textSize = 16f
        setPadding(0, dp(16), 0, dp(4))
    }

    private fun body(text: String) = TextView(this).apply {
        this.text = text
        textSize = 13f
        setPadding(0, dp(2), 0, dp(2))
    }

    private fun actionButton(id: Int, label: String, description: String, onClick: () -> Unit) =
        Button(this).apply {
            this.id = id
            text = label
            contentDescription = description
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
            setOnClickListener { onClick() }
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
