package dev.otagateway.host

import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.core.os.bundleOf
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.callstack.reactnativebrownfield.ReactNativeFragment
import com.google.android.material.bottomnavigation.BottomNavigationView
import org.json.JSONObject

/**
 * Launcher and host shell. Mirrors the host lifecycle: one
 * shared, already-initialized brownfield runtime (booted in
 * [OtaHostApplication]) with at most ONE mounted [ReactNativeFragment] at a
 * time. The shell is a toolbar, a single content container, and a
 * [BottomNavigationView] with the Developer / Sky / Spinner / More tabs. The
 * first three mount an RN surface; More is NATIVE -- a Test menu whose rows
 * PUSH dedicated screens on the back stack ([RNScreenActivity] for the RN
 * Test 1/2, [NativeTestActivity] for the native Test 3), so while More is
 * selected the only live RN surface is a pushed one.
 *
 * Callstack back-callback note: upstream, the brownfield fragment's createView
 * registers an Activity-scoped OnBackPressedCallback with **no fragment
 * lifecycle owner**, so it would never be removed when a fragment is detached
 * and callbacks would accumulate if fragments were swapped in place. This repo
 * patches the package (patches/@callstack__react-native-brownfield@3.6.1.patch,
 * see docs/brownfield.md) so the callback is scoped to the fragment's VIEW
 * (owner registration plus removal in onDestroyView) and dies with it. Because
 * the leak is gone, one fragment can stay alive across tab changes.
 *
 * Tab model (persistent root + selectTab message; see docs/brownfield.md):
 * - RN tab -> RN tab: the fragment is NOT torn down and the Activity is NOT
 *   recreated. The shell persists the route, updates its own native chrome
 *   dynamically (title/Settings action), and posts
 *   `{"type":"selectTab","route":"<path>"}` over the brownfield bridge; the RN
 *   app swaps the visible route in the one live surface. This removes the
 *   per-tab-switch remount (and its flash) on the common tab path.
 * - RN tab -> More: the RN fragment is removed and the native More menu is
 *   shown in the same container, so while More is selected the ONLY live RN
 *   surface is a pushed one -- the one-ExpoRoot rule.
 * - More -> RN tab: the menu is removed and a FRESH fragment is mounted for the
 *   selected route (deliberate: the shell surface is fully torn down while More
 *   is selected, so nothing competes with a pushed Test screen).
 *
 * Recreation now happens only via config changes, process death, or an OTA
 * relaunch ([BrownfieldReloadHandler] relaunches the shared ReactHost in place,
 * re-rendering the mounted fragment); onCreate re-mounts whatever
 * [HostRoutePrefs] records.
 *
 * Guards:
 * - Restart loops: the [BottomNavigationView] listener no-ops when the tapped
 *   tab equals the route the shell already shows ([currentRoute]), so the
 *   programmatic initial selection never triggers a navigation.
 * - Duplicate fragments: onCreate mounting keys off the presence of a fragment
 *   in the container (not savedInstanceState), so a process-death restore keeps
 *   the single restored fragment while a fresh launch adds exactly one.
 *
 * The toolbar exposes a Settings action (only on the Developer tab) that opens
 * [HostSettingsActivity] -- the environment radio, Metro toggle, OTA URLs, and
 * relaunch controls live there, not in the shell.
 */
class RNHostActivity : AppCompatActivity() {

    private lateinit var currentRoute: HostRoute
    private lateinit var toolbar: Toolbar
    private lateinit var container: FrameLayout

    /** The native More menu, added to [container] while More is selected. */
    private var moreMenuView: View? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        currentRoute = HostRoutePrefs.selectedRoute(this)

        toolbar = Toolbar(this).apply {
            id = R.id.host_toolbar
            title = getString(R.string.app_name)
            // Settings is a Developer-tab concern (dev-tools / OTA controls);
            // the menu is populated dynamically by updateToolbarChrome() so it
            // appears/disappears on tab change without recreating the Activity.
            setOnMenuItemClickListener { item ->
                if (item.itemId == R.id.action_settings) {
                    startActivity(Intent(this@RNHostActivity, HostSettingsActivity::class.java))
                    true
                } else {
                    false
                }
            }
        }

        container = FrameLayout(this).apply {
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

        updateToolbarChrome()

        // Mount whatever HostRoutePrefs records -- covers a fresh launch,
        // rotation, process death, and OTA relaunch.
        val routePath = currentRoute.path
        if (routePath == null) {
            // Native tab (More): no RN surface -- remove a restored fragment
            // from a previous RN tab, then mount the native Test menu.
            removeMountedFragment()
            showMoreMenu()
        } else if (supportFragmentManager.findFragmentById(container.id) == null) {
            mountFragment(routePath)
        }
    }

    override fun onStart() {
        super.onStart()
        // JS announces its selectTab listener is live. Re-post the selected
        // tab: a tap in the window after the event emitter wired up but before
        // that listener subscribed was emitted into the void (no NPE, so the
        // postSelectTab fallback never fired), which would strand the shell on
        // the mount-time route. Re-posting is idempotent on the JS side.
        TabsReadyRelay.listener = {
            runOnUiThread {
                if (!isFinishing) {
                    currentRoute.path?.let { postSelectTab(it) }
                }
            }
        }
    }

    override fun onStop() {
        TabsReadyRelay.listener = null
        super.onStop()
    }

    /**
     * Adds or removes the Toolbar's Settings action to match [currentRoute]
     * (Developer only). Called on every tab change so the action appears and
     * disappears without recreating the Activity.
     */
    private fun updateToolbarChrome() {
        toolbar.menu.removeItem(R.id.action_settings)
        if (currentRoute == HostRoute.DEVELOPER) {
            toolbar.menu
                .add(Menu.NONE, R.id.action_settings, Menu.NONE, getString(R.string.action_settings))
                .setIcon(android.R.drawable.ic_menu_preferences)
                .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
        }
    }

    /** Mounts a FRESH RN surface for [path] in the shell's content container. */
    private fun mountFragment(path: String) {
        val fragment = ReactNativeFragment.createReactNativeFragment(
            Brownfield.RN_MODULE_NAME,
            bundleOf(
                "initialUrl" to path,
                // Persisted component state (host-state seam); lets a
                // remounted surface resume e.g. the spinner mid-coast.
                Brownfield.SAVED_STATE_PROP to HostStateStore.readAllJson(this),
                // Tab surfaces resume their last in-surface path; pushed
                // screens (RNScreenActivity) deliberately do NOT set this.
                Brownfield.RESTORE_NAV_STATE_PROP to true,
                // Wall-clock instant these props were minted. nav-restore only
                // honors a `nav:activeTab` override when the user's selection
                // POST-DATES this stamp -- i.e. an in-place OTA reload reusing
                // these STALE props. A genuinely fresh mount (More -> RN tab)
                // carries a current stamp, so it is never hijacked back to the
                // old tab.
                Brownfield.MOUNTED_AT_PROP to System.currentTimeMillis(),
            ),
        )
        supportFragmentManager.beginTransaction()
            .replace(container.id, fragment)
            .commit()
    }

    /** Removes the currently mounted RN fragment, if any (synchronously). */
    private fun removeMountedFragment() {
        supportFragmentManager.findFragmentById(container.id)?.let { fragment ->
            supportFragmentManager.beginTransaction().remove(fragment).commitNow()
        }
    }

    /** Shows the native More menu in the content container. */
    private fun showMoreMenu() {
        val menu = moreMenuView ?: buildMoreMenu().also { moreMenuView = it }
        if (menu.parent == null) {
            container.addView(menu)
        }
    }

    /** Removes the native More menu from the content container, if present. */
    private fun removeMoreMenu() {
        moreMenuView?.let { container.removeView(it) }
        moreMenuView = null
    }

    /** One row of the More tab's native menu (mirrors iOS MoreMenuViewController.Row). */
    private data class MoreMenuRow(val rowId: Int, val labelRes: Int, val onClick: () -> Unit)

    /**
     * The More tab's native menu. Test 1 / Test 2 push RN screens, Test 3 a
     * native screen -- each a dedicated activity sharing the pushed-screen
     * chrome ([PushedScreenShell]), demonstrating native and RN screens mixed
     * on one back stack.
     */
    private fun buildMoreMenu(): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            listOf(
                MoreMenuRow(R.id.item_test_one, R.string.test_one_title) {
                    RNScreenActivity.start(
                        this@RNHostActivity,
                        Brownfield.TEST_ONE_ROUTE,
                        getString(R.string.test_one_title),
                    )
                },
                MoreMenuRow(R.id.item_test_two, R.string.test_two_title) {
                    RNScreenActivity.start(
                        this@RNHostActivity,
                        Brownfield.TEST_TWO_ROUTE,
                        getString(R.string.test_two_title),
                    )
                },
                MoreMenuRow(R.id.item_test_three, R.string.test_three_title) {
                    NativeTestActivity.start(this@RNHostActivity)
                },
            ).forEach { row ->
                addView(
                    buildMoreMenuRow(row.rowId, getString(row.labelRes), row.onClick),
                    LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT),
                )
            }
        }

    private fun buildMoreMenuRow(rowId: Int, label: String, onClick: () -> Unit) =
        TextView(this).apply {
            id = rowId
            text = label
            textSize = 18f
            setPadding(48, 48, 48, 48)
            isClickable = true
            isFocusable = true
            val outValue = TypedValue()
            theme.resolveAttribute(android.R.attr.selectableItemBackground, outValue, true)
            setBackgroundResource(outValue.resourceId)
            setOnClickListener { onClick() }
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
            menu.add(Menu.NONE, R.id.nav_more, Menu.NONE, getString(R.string.tab_more))
                .setIcon(android.R.drawable.ic_menu_more)
            // Reflect the mounted route without triggering navigation; the
            // listener also guards on currentRoute, so no navigation loop starts.
            selectedItemId = menuIdFor(currentRoute)
            setOnItemSelectedListener { item ->
                routeForMenuId(item.itemId)
                    ?.takeIf { it != currentRoute }
                    ?.let { navigateTo(it) }
                true
            }
        }

    /**
     * Applies a tab selection against the persistent RN root:
     * - RN tab -> RN tab: keep the live fragment, update native chrome, and
     *   post a `selectTab` message so the RN app swaps the visible route.
     * - RN tab -> More: remove the RN fragment and show the native More menu.
     * - More -> RN tab: remove the menu and mount a FRESH fragment (the shell
     *   surface is torn down while More is selected -- one live RN root).
     *
     * The route is persisted first so a recreation/process death/OTA relaunch
     * restores the selected tab.
     */
    private fun navigateTo(route: HostRoute) {
        val previous = currentRoute
        HostRoutePrefs.setSelectedRoute(this, route)
        currentRoute = route
        updateToolbarChrome()

        val path = route.path
        when {
            path == null -> {
                // -> More: tear down the RN surface, show the native menu.
                removeMountedFragment()
                showMoreMenu()
            }
            previous == HostRoute.MORE -> {
                // More -> RN tab: mount a fresh surface for the selected route.
                removeMoreMenu()
                mountFragment(path)
            }
            else -> {
                // RN tab -> RN tab: keep the one live surface; let JS swap route.
                postSelectTab(path)
            }
        }
    }

    /**
     * Posts `{"type":"selectTab","route":"<path>"}` to the RN app over the
     * brownfield bridge. The JS listener re-points the single live surface at
     * the selected route (router.navigate; slice attribution derives from the
     * observed pathname).
     *
     * Best-effort by design: it does NOT remount on failure. Early in a cold
     * start (before JS wires the TurboModule event emitter) the upstream
     * `emitOnBrownfieldMessage` throws instead of no-oping, and the post is
     * lost -- but that lost tap is recovered by the `tabsReady` handshake:
     * once the JS `selectTab` listener subscribes it posts `tabsReady`, and
     * [onStart]'s relay re-posts [currentRoute] (already updated to the tapped
     * tab by [navigateTo] BEFORE this call), which the JS side applies
     * idempotently. Crucially the emitter cannot throw AFTER `tabsReady` has
     * been sent (JS subscribes its message listener before announcing), so an
     * emitter-not-ready failure here ALWAYS has a pending handshake to recover
     * it.
     *
     * The previous NPE fallback remounted a fresh fragment
     * (`removeMountedFragment()` + `mountFragment()`), which mounted a SECOND,
     * transient ExpoRoot in the same JS runtime while the first was torn down.
     * expo-router 55's router store is a single module-global slot shared by
     * every ExpoRoot (see TabSelectGuard); two concurrent mounts clobber it, so
     * the guard's `navigationRef.isReady()` could read a detached container and
     * poll forever -- stranding the shell on its mount-time tab. Dropping the
     * remount keeps the one-ExpoRoot rule (matching iOS, which never remounts
     * here) and lets the handshake do the recovery. Do NOT reintroduce it.
     */
    private fun postSelectTab(path: String) {
        val message = JSONObject()
            .put("type", Brownfield.SELECT_TAB_MESSAGE_TYPE)
            .put("route", path)
            .toString()
        try {
            ReactNativeBrownfield.shared.postMessage(message)
        } catch (e: RuntimeException) {
            // JS emitter not wired yet: the tap is recovered by the tabsReady
            // handshake (see the KDoc above and onStart). Do not remount.
            Log.w("RNHostActivity", "selectTab post failed (JS emitter not ready); awaiting tabsReady", e)
        }
    }

    private fun menuIdFor(route: HostRoute): Int =
        when (route) {
            HostRoute.DEVELOPER -> R.id.nav_developer
            HostRoute.SKY -> R.id.nav_sky
            HostRoute.SPINNER -> R.id.nav_spinner
            HostRoute.MORE -> R.id.nav_more
        }

    private fun routeForMenuId(menuId: Int): HostRoute? =
        when (menuId) {
            R.id.nav_developer -> HostRoute.DEVELOPER
            R.id.nav_sky -> HostRoute.SKY
            R.id.nav_spinner -> HostRoute.SPINNER
            R.id.nav_more -> HostRoute.MORE
            else -> null
        }
}
