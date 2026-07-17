package dev.otagateway.host

import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.core.os.bundleOf
import com.callstack.reactnativebrownfield.ReactNativeFragment
import com.google.android.material.bottomnavigation.BottomNavigationView

/**
 * Launcher and host shell. Mirrors the eng-regal-hybrid-app lifecycle: one
 * shared, already-initialized brownfield runtime (booted in
 * [OtaHostApplication]) with exactly ONE mounted [ReactNativeFragment] at a
 * time. The shell is a toolbar, a single fragment container, and a
 * [BottomNavigationView] with the Developer / Sky / Spinner tabs.
 *
 * Callstack constraint (load-bearing): the brownfield fragment's createView
 * registers an Activity-scoped OnBackPressedCallback with **no fragment
 * lifecycle owner**, so it is never removed when a fragment is detached. If we
 * swapped fragments in place across tab changes the callbacks (and RN roots)
 * would accumulate on the same Activity. Instead a tab change persists the
 * selected route and **relaunches this Activity** ([recreate]); destroying the
 * Activity tears down the old back callback and RN root before the newly
 * selected route mounts in a fresh Activity.
 *
 * Guards:
 * - Restart loops: the [BottomNavigationView] listener no-ops when the tapped
 *   tab equals the route this Activity already mounted ([currentRoute]), so the
 *   programmatic initial selection never triggers a relaunch.
 * - Duplicate fragments: mounting keys off the presence of a fragment in the
 *   container (not savedInstanceState), so a process-death restore keeps the
 *   single restored fragment while a fresh launch or a tab relaunch (which
 *   removes the fragment first) adds exactly one.
 *
 * The toolbar exposes a Settings action (only on the Developer tab) that opens
 * [HostSettingsActivity] -- the environment radio, Metro toggle, OTA URLs, and
 * relaunch controls live there, not in the shell.
 */
class RNHostActivity : AppCompatActivity() {

    private lateinit var currentRoute: HostRoute

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        currentRoute = HostRoutePrefs.selectedRoute(this)

        val toolbar = Toolbar(this).apply {
            id = R.id.host_toolbar
            title = getString(R.string.app_name)
            // Settings is a Developer-tab concern (dev-tools / OTA controls);
            // populate the Toolbar's own menu directly (no action-bar plumbing).
            if (currentRoute == HostRoute.DEVELOPER) {
                menu.add(Menu.NONE, R.id.action_settings, Menu.NONE, getString(R.string.action_settings))
                    .setIcon(android.R.drawable.ic_menu_preferences)
                    .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
                setOnMenuItemClickListener { item ->
                    if (item.itemId == R.id.action_settings) {
                        startActivity(Intent(this@RNHostActivity, HostSettingsActivity::class.java))
                        true
                    } else {
                        false
                    }
                }
            }
        }

        val container = FrameLayout(this).apply {
            // Stable id (not generateViewId()) so the RN child fragment restores
            // into the same container after recreation/process death.
            id = R.id.rn_host_container
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
            addView(toolbar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(container, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(buildBottomNav(), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        setContentView(root)

        if (supportFragmentManager.findFragmentById(container.id) == null) {
            val fragment = ReactNativeFragment.createReactNativeFragment(
                RN_MODULE_NAME,
                bundleOf("initialUrl" to currentRoute.path),
            )
            supportFragmentManager.beginTransaction()
                .replace(container.id, fragment)
                .commit()
        }
    }

    private fun buildBottomNav(): BottomNavigationView =
        BottomNavigationView(this).apply {
            id = R.id.host_bottom_nav
            val tabColors = ColorStateList(
                arrayOf(
                    intArrayOf(android.R.attr.state_checked),
                    intArrayOf(),
                ),
                intArrayOf(Color.WHITE, Color.LTGRAY),
            )
            setBackgroundColor(Color.BLACK)
            itemIconTintList = tabColors
            itemTextColor = tabColors
            itemActiveIndicatorColor = ColorStateList.valueOf(Color.DKGRAY)
            // Titles double as the accessibility labels the tab bar announces.
            menu.add(Menu.NONE, R.id.nav_developer, Menu.NONE, getString(R.string.tab_developer))
                .setIcon(android.R.drawable.ic_menu_manage)
            menu.add(Menu.NONE, R.id.nav_sky, Menu.NONE, getString(R.string.tab_sky))
                .setIcon(android.R.drawable.ic_menu_compass)
            menu.add(Menu.NONE, R.id.nav_spinner, Menu.NONE, getString(R.string.tab_spinner))
                .setIcon(android.R.drawable.ic_menu_rotate)
            // Reflect the mounted route without triggering a relaunch; the
            // listener also guards on currentRoute, so no relaunch loop starts.
            selectedItemId = menuIdFor(currentRoute)
            setOnItemSelectedListener { item ->
                routeForMenuId(item.itemId)
                    ?.takeIf { it != currentRoute }
                    ?.let { navigateTo(it) }
                true
            }
        }

    /**
     * Persists the newly selected tab and relaunches this Activity so the old
     * Activity (with its brownfield back callback and RN root) is destroyed
     * before the new route mounts. The current fragment is removed first so the
     * FragmentManager does not restore it against the new route after recreate.
     */
    private fun navigateTo(route: HostRoute) {
        HostRoutePrefs.setSelectedRoute(this, route)
        supportFragmentManager.findFragmentById(R.id.rn_host_container)?.let { fragment ->
            supportFragmentManager.beginTransaction().remove(fragment).commitNow()
        }
        recreate()
    }

    private fun menuIdFor(route: HostRoute): Int =
        when (route) {
            HostRoute.DEVELOPER -> R.id.nav_developer
            HostRoute.SKY -> R.id.nav_sky
            HostRoute.SPINNER -> R.id.nav_spinner
        }

    private fun routeForMenuId(menuId: Int): HostRoute? =
        when (menuId) {
            R.id.nav_developer -> HostRoute.DEVELOPER
            R.id.nav_sky -> HostRoute.SKY
            R.id.nav_spinner -> HostRoute.SPINNER
            else -> null
        }

    companion object {
        private const val RN_MODULE_NAME = "OtaGatewayApp"
    }
}
