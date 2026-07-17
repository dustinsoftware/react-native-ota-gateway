package dev.otagateway.host

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton

/**
 * Test 3: a fully NATIVE pushed screen with the same toolbar/back chrome as
 * the pushed RN screens ([PushedScreenShell]), demonstrating that native and
 * React Native screens mix on one back stack. Its button pushes RN Test 1 on
 * top -- native menu -> native screen -> RN screen is the mix-and-match point
 * of the More tab demo.
 */
class NativeTestActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val container = PushedScreenShell.install(this, getString(R.string.test_three_title))

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(RN_DARK_BACKGROUND)

            addView(
                TextView(context).apply {
                    text = getString(R.string.test_three_headline)
                    textSize = 28f
                    setTextColor(Color.WHITE)
                    gravity = Gravity.CENTER
                },
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT),
            )
            addView(
                TextView(context).apply {
                    text = getString(R.string.test_three_body)
                    textSize = 16f
                    setTextColor(Color.LTGRAY)
                    gravity = Gravity.CENTER
                    setPadding(48, 16, 48, 32)
                },
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT),
            )
            addView(
                MaterialButton(context).apply {
                    id = R.id.button_push_rn_test_one
                    text = getString(R.string.test_three_push_rn)
                    setOnClickListener {
                        RNScreenActivity.start(
                            this@NativeTestActivity,
                            Brownfield.TEST_ONE_ROUTE,
                            getString(R.string.test_one_title),
                        )
                    }
                },
                LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT),
            )
        }
        container.addView(content, MATCH_PARENT, MATCH_PARENT)
    }

    companion object {
        /**
         * Mirrors the RN palette's Colors.dark.background (#222428,
         * apps/mobile/src/constants/theme.ts) so the native screen blends with
         * the always-dark RN Test screens beside it on the stack.
         */
        private val RN_DARK_BACKGROUND = Color.rgb(0x22, 0x24, 0x28)

        fun start(activity: Activity) {
            activity.startActivity(Intent(activity, NativeTestActivity::class.java))
        }
    }
}
