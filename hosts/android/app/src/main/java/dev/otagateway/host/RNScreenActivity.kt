package dev.otagateway.host

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.os.bundleOf
import com.callstack.reactnativebrownfield.ReactNativeFragment

/**
 * Hosts one React Native brownfield screen as a PUSHED activity with the
 * standard native toolbar (title + back arrow) -- the per-activity hosting
 * pattern the product hosts landed on for screens like Terms of Service.
 *
 * Per-activity hosting is load-bearing, not just presentation: Callstack's
 * `ReactNativeFragment.createView` registers an Activity-scoped
 * OnBackPressedCallback with no fragment lifecycle owner, so a fragment swap
 * inside a SHARED activity leaks callbacks across visits (second-visit dead
 * Back). A dedicated activity per RN surface gives every visit a fresh
 * OnBackPressedDispatcher, and the leak cannot manifest. If an RN screen is
 * ever fragment-hosted in a shared activity again, that upstream bug returns
 * -- see docs/brownfield.md.
 *
 * `singleTop` (manifest) absorbs a rapid double tap on a launcher row instead
 * of stacking the screen twice. The toolbar back arrow routes through the back
 * dispatcher ([PushedScreenShell]), so RN JS sees Back first and an RN-internal
 * push (Test 1 -> Test 2) pops before the activity finishes.
 */
class RNScreenActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val route = requireNotNull(intent.getStringExtra(EXTRA_ROUTE)) {
            "RNScreenActivity requires $EXTRA_ROUTE; launch it via start()"
        }
        val title = intent.getStringExtra(EXTRA_TITLE) ?: getString(R.string.app_name)

        val container = PushedScreenShell.install(this, title)

        // Keyed off the container (not savedInstanceState) like the shell: a
        // restore keeps the single restored fragment; a fresh launch adds one.
        if (supportFragmentManager.findFragmentById(container.id) == null) {
            val fragment = ReactNativeFragment.createReactNativeFragment(
                Brownfield.RN_MODULE_NAME,
                bundleOf(
                    "initialUrl" to route,
                    // Persisted component state (host-state seam), matching
                    // the shell's tab surfaces.
                    "savedStateJson" to HostStateStore.readAllJson(this),
                ),
            )
            supportFragmentManager.beginTransaction()
                .replace(container.id, fragment)
                .commit()
        }
    }

    /**
     * singleTop re-delivers a launch to the existing top instance without
     * recreating it, and the route is read once in onCreate -- so a re-launch
     * carrying a DIFFERENT route would silently keep showing the old one. No
     * UI path does that today (the menu and Test 3 only launch from below this
     * activity), but this is a template others copy: recreate on a route
     * change so the invariant cannot rot silently. Same-route re-delivery (a
     * double tap, the case singleTop exists for) stays a no-op.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val newRoute = intent.getStringExtra(EXTRA_ROUTE)
        if (newRoute != null && newRoute != this.intent.getStringExtra(EXTRA_ROUTE)) {
            setIntent(intent)
            supportFragmentManager.findFragmentById(R.id.pushed_screen_container)?.let {
                supportFragmentManager.beginTransaction().remove(it).commitNow()
            }
            recreate()
        }
    }

    companion object {
        private const val EXTRA_ROUTE = "dev.otagateway.host.extra.ROUTE"
        private const val EXTRA_TITLE = "dev.otagateway.host.extra.TITLE"

        fun start(activity: Activity, route: String, title: String) {
            activity.startActivity(
                Intent(activity, RNScreenActivity::class.java)
                    .putExtra(EXTRA_ROUTE, route)
                    .putExtra(EXTRA_TITLE, title),
            )
        }
    }
}
