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
import dev.otagateway.OtaUpdatesEnvironment
import kotlin.system.exitProcess

/**
 * Native developer-tools page. It is the launcher activity and the root the
 * hardware-back returns to from an RN screen. Built programmatically (no
 * Compose, no XML layout) to keep the host minimal.
 *
 * Shows the OTA URL per environment, an environment radio (persisted to prefs,
 * "restart required"), a "Use Metro dev server" switch (Mode A, "restart
 * required"), and buttons to open RN screens and relaunch the app.
 *
 * expo-updates configuration is fixed for the process lifetime, so the env and
 * Metro selections only take effect after a relaunch -- hence "restart
 * required" and the Relaunch button.
 */
class MainActivity : AppCompatActivity() {

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

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }

        root.addView(header("OTA Gateway Host"))
        root.addView(
            body(
                "Native dev-tools. Mode B (default) loads JS from OTA/embedded; " +
                    "Mode A loads from Metro. expo-updates config is fixed per " +
                    "process, so changes below need a relaunch.",
            ),
        )

        root.addView(sectionTitle("OTA endpoints"))
        root.addView(body("development: ${otaUrls[OtaUpdatesEnvironment.DEVELOPMENT]}"))
        root.addView(body("production: ${otaUrls[OtaUpdatesEnvironment.PRODUCTION]}"))

        root.addView(sectionTitle("Environment (restart required)"))
        root.addView(buildEnvRadioGroup())

        root.addView(sectionTitle("Metro dev server (restart required)"))
        root.addView(buildMetroSwitch())

        root.addView(sectionTitle("Actions"))
        root.addView(
            actionButton(
                id = R.id.button_open_rn,
                label = "Open RN screen",
                description = "Open RN screen",
            ) { openRoute("/") },
        )
        root.addView(
            actionButton(
                id = R.id.button_open_dev_tools,
                label = "Open RN dev tools",
                description = "Open RN dev tools",
            ) { openRoute("/developer") },
        )
        root.addView(
            actionButton(
                id = R.id.button_relaunch,
                label = "Relaunch app",
                description = "Relaunch app",
            ) { relaunch() },
        )

        val scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)
    }

    private fun buildEnvRadioGroup(): RadioGroup {
        val current = DebugPrefs.environment(this)
        return RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
            addView(
                RadioButton(this@MainActivity).apply {
                    id = R.id.radio_env_development
                    text = "development (:3000)"
                    contentDescription = "Environment development"
                    isChecked = current == OtaUpdatesEnvironment.DEVELOPMENT
                },
            )
            addView(
                RadioButton(this@MainActivity).apply {
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
                DebugPrefs.setEnvironment(this@MainActivity, env)
            }
        }
    }

    private fun buildMetroSwitch(): SwitchCompat =
        SwitchCompat(this).apply {
            id = R.id.switch_use_metro
            text = "Use Metro dev server"
            contentDescription = "Use Metro dev server"
            isChecked = DebugPrefs.useMetro(this@MainActivity)
            setOnCheckedChangeListener { _, checked ->
                DebugPrefs.setUseMetro(this@MainActivity, checked)
            }
        }

    private fun openRoute(route: String) {
        startActivity(
            Intent(this, RNHostActivity::class.java).putExtra(RNHostActivity.EXTRA_ROUTE, route),
        )
    }

    /**
     * Fully restarts the process so a new environment / Metro selection is
     * picked up. finishAffinity() tears down the task; exitProcess ends the
     * process (Android relaunches the last activity of a killed foreground task).
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
