package dev.otagateway.host

import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar

/**
 * Chrome for a PUSHED host screen: a toolbar with a back arrow + title above a
 * content container, mirroring how product hosts present a pushed screen (a
 * dedicated activity with the standard toolbar, not an in-place fragment
 * swap).
 *
 * The back arrow deliberately routes through [AppCompatActivity]'s
 * OnBackPressedDispatcher instead of calling finish(): for a screen hosting a
 * [com.callstack.reactnativebrownfield.ReactNativeFragment] that keeps the
 * arrow on the same path as the hardware/gesture back, so the brownfield
 * callback offers the press to RN JS first (an RN-internal push pops before
 * the native screen closes).
 */
object PushedScreenShell {
    /**
     * Builds the toolbar + container root, sets it as the activity's content
     * view, and returns the content container (stable id
     * [R.id.pushed_screen_container]) for the caller to fill.
     */
    fun install(activity: AppCompatActivity, title: CharSequence): FrameLayout {
        val toolbar = Toolbar(activity).apply {
            id = R.id.pushed_screen_toolbar
            this.title = title
            setNavigationIcon(androidx.appcompat.R.drawable.abc_ic_ab_back_material)
            setNavigationContentDescription(activity.getString(R.string.navigate_up))
            setNavigationOnClickListener {
                activity.onBackPressedDispatcher.onBackPressed()
            }
        }

        val container = FrameLayout(activity).apply {
            // Stable id so an RN child fragment restores into the same
            // container after recreation/process death.
            id = R.id.pushed_screen_container
        }

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
            addView(toolbar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(container, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        }
        activity.setContentView(root)
        return container
    }
}
