package dev.otagateway.host

/**
 * Literals that form the contract between the native host and the RN
 * brownfield bundle (apps/mobile): the RN module name and the PUSHED test
 * screens' routes. The shell TAB routes live in [HostRoute] instead (Android
 * couples path + tab + menu id in one enum; iOS declares all routes in
 * Brownfield.swift and maps tabs in HostTab). The route strings are
 * drift-guarded against the RN route files by
 * apps/mobile/plugins/__tests__/drift-guard.test.ts.
 */
object Brownfield {
    /** Name of the RN module registered by the brownfield bundle. */
    const val RN_MODULE_NAME = "OtaGatewayApp"

    /** RN route for the More tab's Test 1 pushed screen. */
    const val TEST_ONE_ROUTE = "/test-one"

    /** RN route for the More tab's Test 2 pushed screen. */
    const val TEST_TWO_ROUTE = "/test-two"

    /**
     * Key of the initial property carrying the persisted component-state store
     * into every mounted RN surface (shared contract with iOS and the JS
     * host-state module).
     */
    const val SAVED_STATE_PROP = "savedStateJson"

    /**
     * Initial property opting a surface into resuming its last in-surface
     * path (tab mounts only; shared contract with iOS and nav-restore.ts).
     */
    const val RESTORE_NAV_STATE_PROP = "restoreNavState"

    /** Message `type` the JS posts after an OTA download (shared contract with iOS). */
    const val RELOAD_MESSAGE_TYPE = "reload"

    /** Message `type` for component-state checkpoints (shared contract with iOS). */
    const val SAVE_STATE_MESSAGE_TYPE = "saveState"

    /** Message `type` for RN -> native navigation (shared contract with iOS). */
    const val NAVIGATE_MESSAGE_TYPE = "navigate"

    /** The `navigate` destination for the native Host Settings screen. */
    const val SETTINGS_DESTINATION = "settings"
}
