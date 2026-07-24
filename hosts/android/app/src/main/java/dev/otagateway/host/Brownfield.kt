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
}
