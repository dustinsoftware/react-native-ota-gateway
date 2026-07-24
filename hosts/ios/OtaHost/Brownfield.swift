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
    /// RN route for the developer OTA tools page.
    static let developerRoute = "/developer"
    /// RN route for the Sky screen.
    static let skyRoute = "/sky"
    /// RN route for the Spinner screen.
    static let spinnerRoute = "/spinner"
    /// RN route for the More tab's Test 1 pushed screen.
    static let testOneRoute = "/test-one"
    /// RN route for the More tab's Test 2 pushed screen.
    static let testTwoRoute = "/test-two"
    /// Message `type` the JS side posts after an OTA update download.
    static let reloadMessageType = "reload"
    /// Message `type` the JS side posts to checkpoint component state into the
    /// host's native store (see HostStateStore).
    static let saveStateMessageType = "saveState"
    /// Message `type` the JS side posts to navigate INTO a native screen.
    static let navigateMessageType = "navigate"
    /// The `navigate` destination for the native Host Settings screen.
    static let settingsDestination = "settings"
    /// Key of the initial property carrying the persisted component-state
    /// store into every mounted RN surface.
    static let savedStateKey = "savedStateJson"
}

/// A native host tab. RN tabs (`route != nil`) mount exactly one RN surface at
/// their route; the host shell keeps only the active tab's surface alive (see
/// `HostShellViewController`). `more` is a NATIVE tab: it mounts the native
/// Test menu, whose rows PUSH dedicated screens on the navigation stack.
enum HostTab: Int, CaseIterable {
    case developer
    case sky
    case spinner
    case more

    var title: String {
        switch self {
        case .developer: return "Developer"
        case .sky: return "Sky"
        case .spinner: return "Spinner"
        case .more: return "More"
        }
    }

    /// RN route this tab mounts, passed as the surface's `initialUrl`.
    /// `nil` for the native More tab, which mounts no RN surface.
    var route: String? {
        switch self {
        case .developer: return Brownfield.developerRoute
        case .sky: return Brownfield.skyRoute
        case .spinner: return Brownfield.spinnerRoute
        case .more: return nil
        }
    }

    /// SF Symbol name for the tab bar item.
    var systemImageName: String {
        switch self {
        case .developer: return "wrench.and.screwdriver"
        case .sky: return "cloud"
        case .spinner: return "arrow.triangle.2.circlepath"
        case .more: return "ellipsis"
        }
    }
}

/// A message the React Native brownfield JS bridge can post to the native host.
enum BrownfieldMessage: Equatable {
    /// Posted after an OTA update is downloaded, asking the host to rebuild the
    /// RN screens so the freshly-downloaded bundle is loaded.
    case reload
    /// Checkpoints a component-state slice into the host's native store
    /// (HostStateStore); `stateJson` is the slice re-serialized as JSON.
    case saveState(key: String, stateJson: String)
    /// Asks the host to navigate to a native screen (e.g. Test 2's "Open
    /// native Settings" button) -- the reverse of the More tab pushing RN.
    case navigate(destination: String)
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

/// The host's selected tab, persisted to `UserDefaults`.
///
/// Stored so the host shell can restore the same surface on scene restoration
/// and after an OTA reload. Defaults to the Developer tab.
enum HostTabPreference {
    private static let key = "OtaHostSelectedTab"

    static var current: HostTab {
        let stored = UserDefaults.standard.object(forKey: key) as? Int
        return stored.flatMap(HostTab.init(rawValue:)) ?? .developer
    }

    static func set(_ tab: HostTab) {
        UserDefaults.standard.set(tab.rawValue, forKey: key)
    }
}
