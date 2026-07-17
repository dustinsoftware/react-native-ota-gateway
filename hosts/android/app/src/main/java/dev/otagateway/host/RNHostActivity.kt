package dev.otagateway.host

import android.os.Bundle
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.os.bundleOf
import com.callstack.reactnativebrownfield.ReactNativeFragment

/**
 * Hosts a single React Native brownfield screen. The route to open is passed as
 * the [EXTRA_ROUTE] intent extra and handed to the RN app via the initialUrl
 * prop; the RN module name is always "OtaGatewayApp" (the whole Expo Router app
 * boots and navigates to initialUrl).
 *
 * Hardware back from an RN screen returns to the native dev-tools page rather
 * than blanking, because the brownfield tab layout uses backBehavior="none"
 * under a host (see docs/brownfield.md).
 */
class RNHostActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val container = FrameLayout(this).apply {
            // Stable id (not generateViewId()) so the RN child fragment restores
            // into the same container after recreation/process death.
            id = R.id.rn_host_container
        }
        setContentView(container)

        if (savedInstanceState == null) {
            val route = intent.getStringExtra(EXTRA_ROUTE) ?: "/"
            val fragment = ReactNativeFragment.createReactNativeFragment(
                RN_MODULE_NAME,
                bundleOf("initialUrl" to route),
            )
            supportFragmentManager.beginTransaction()
                .replace(container.id, fragment)
                .commit()
        }
    }

    companion object {
        const val EXTRA_ROUTE = "route"
        private const val RN_MODULE_NAME = "OtaGatewayApp"
    }
}
