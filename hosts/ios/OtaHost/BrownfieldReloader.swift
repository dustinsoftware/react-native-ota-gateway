import ReactBrownfield
import UIKit

/// Identifies a React Native brownfield screen so it can be rebuilt after an OTA reload.
struct BrownfieldScreen {
    let moduleName: String
    let initialProperties: [String: Any]?
    let title: String?
}

/// The native surface owner the reloader asks to rebuild the active RN surface.
///
/// The host shell owns EXACTLY ONE mounted RN surface at a time (in its content
/// slot), so the reloader cannot swap it in place the way a navigation stack
/// allows. Instead the host conforms to this protocol and, on reload, recreates
/// its active surface (through `BrownfieldReloader.makeViewController`) while
/// leaving the selected tab and any presented settings untouched.
protocol BrownfieldReloadHost: AnyObject {
    /// Recreate the active RN surface after the runtime has restarted. Called on
    /// the main thread, after `stopReactNative()` / `startReactNative()`.
    func rebuildActiveSurface()
}

/// Reloads React Native brownfield screens when the JS side requests it.
///
/// expo-updates' own `reloadAsync()` crashes in a brownfield app because the
/// native host -- not expo-updates -- owns the RN view lifecycle. So when an OTA
/// update is downloaded, the JS posts a `{ "type": "reload" }` message instead
/// of calling `reloadAsync()`, and we rebuild the live RN surface here: tear
/// down the runtime, start it again, and ask the host to recreate its currently
/// mounted surface so the freshly-downloaded bundle is loaded.
///
/// The host runs a single mounted surface at a time (`HostShellViewController`).
/// The reloader weakly tracks every RN view controller it creates
/// (`makeViewController`) and prunes deallocated ones, so a reload is a no-op
/// when nothing is on screen and never orphans a surface on a dead runtime. The
/// actual re-mount is delegated to the registered `BrownfieldReloadHost`, which
/// preserves the native selected tab and host settings presentation.
final class BrownfieldReloader {
    static let shared = BrownfieldReloader()

    /// The surface owner rebuilt on reload. Weak -- the host owns the reloader
    /// relationship, not the reverse.
    weak var host: BrownfieldReloadHost?

    /// Restarts the RN runtime. Injected so tests can substitute it.
    private let restartRuntime: () -> Void

    /// Builds the view controller for a screen. Injected so tests can substitute it.
    private let makeScreenViewController: (BrownfieldScreen) -> UIViewController

    init(
        restartRuntime: @escaping () -> Void = {
            ReactNativeBrownfield.shared.stopReactNative()
            ReactNativeBrownfield.shared.startReactNative()
        },
        makeScreenViewController: @escaping (BrownfieldScreen) -> UIViewController = { screen in
            let viewController = ReactNativeViewController(
                moduleName: screen.moduleName,
                initialProperties: screen.initialProperties
            )
            viewController.title = screen.title
            return viewController
        }
    ) {
        self.restartRuntime = restartRuntime
        self.makeScreenViewController = makeScreenViewController
    }

    /// Weakly tracks a live RN screen with the metadata needed to rebuild it.
    private final class Entry {
        weak var viewController: UIViewController?
        let screen: BrownfieldScreen

        init(_ viewController: UIViewController, _ screen: BrownfieldScreen) {
            self.viewController = viewController
            self.screen = screen
        }
    }

    private var entries: [Entry] = []

    /// Number of tracked screens. Exposed for unit tests to assert pruning.
    var trackedScreenCount: Int { entries.count }

    /// Build a tracked RN view controller. ALWAYS use this instead of
    /// constructing a `ReactNativeViewController` directly -- an untracked RN
    /// screen is silently left on a dead runtime after an OTA reload (blank/
    /// frozen), because `reload()` restarts the global RN runtime and only
    /// rebuilds tracked screens.
    @discardableResult
    func makeViewController(
        moduleName: String,
        initialProperties: [String: Any]?,
        title: String? = nil
    ) -> UIViewController {
        dispatchPrecondition(condition: .onQueue(.main))

        // Drop screens that have since been dismissed and deallocated so the
        // tracking list does not accumulate dead entries between reloads.
        entries.removeAll { $0.viewController == nil }

        let screen = BrownfieldScreen(
            moduleName: moduleName,
            initialProperties: initialProperties,
            title: title
        )
        let viewController = makeScreenViewController(screen)
        entries.append(Entry(viewController, screen))
        return viewController
    }

    /// Restart the RN runtime and rebuild the live RN surface so a
    /// freshly-downloaded OTA update is picked up. Safe to call from any thread;
    /// no-op if no tracked RN surface is currently alive.
    func reload() {
        DispatchQueue.main.async { [weak self] in
            self?.performReload()
        }
    }

    /// Synchronous reload body. Internal only so tests can drive it directly;
    /// production reaches it through `reload()`, which guarantees the main thread.
    func performReload() {
        dispatchPrecondition(condition: .onQueue(.main))

        entries.removeAll { $0.viewController == nil }

        // Only restart when a surface is actually on screen and a host can
        // rebuild it; otherwise a reload would tear down the runtime with no
        // surface to bring back.
        guard let host, entries.contains(where: { $0.viewController != nil }) else {
            return
        }

        restartRuntime()
        host.rebuildActiveSurface()

        entries.removeAll { $0.viewController == nil }
    }
}
