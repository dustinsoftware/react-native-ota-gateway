import Foundation
import OtaGatewayLib
import ReactBrownfield

/// Literals that form the contract between the native host and the RN
/// brownfield bundle (apps/mobile). One source of truth for the host.
enum Brownfield {
    /// Name of the RN module registered by the brownfield bundle.
    static let moduleName = "OtaGatewayApp"
    /// Key of the initial-URL entry in an RN screen's `initialProperties`.
    static let initialUrlKey = "initialUrl"
    /// RN route for the home screen.
    static let homeRoute = "/"
    /// RN route for the developer OTA tools page.
    static let developerRoute = "/developer"
    /// Message `type` the JS side posts after an OTA update download.
    static let reloadMessageType = "reload"
}

/// A message the React Native brownfield JS bridge can post to the native host.
enum BrownfieldMessage: Equatable {
    /// Posted after an OTA update is downloaded, asking the host to rebuild the
    /// RN screens so the freshly-downloaded bundle is loaded.
    case reload
}

/// The host's selected OTA environment, persisted to `UserDefaults`.
///
/// expo-updates configuration is fixed for the process lifetime once
/// `initializeUpdates` runs, so a change here only takes effect on the next
/// launch ("restart required"). Defaults to production (fail toward production,
/// matching the baked default in app.config.ts).
enum HostEnvironmentPreference {
    private static let key = "OtaHostEnvironment"
    private static let developmentValue = "development"
    private static let productionValue = "production"

    static var current: ReactNativeBrownfield.OtaUpdatesEnvironment {
        let stored = UserDefaults.standard.string(forKey: key)
        return stored == developmentValue ? .development : .production
    }

    static func set(_ environment: ReactNativeBrownfield.OtaUpdatesEnvironment) {
        let value = environment == .development ? developmentValue : productionValue
        UserDefaults.standard.set(value, forKey: key)
    }
}
