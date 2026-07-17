import ReactBrownfield
import UIKit

/// Identifies a React Native brownfield screen so it can be rebuilt after an OTA reload.
struct BrownfieldScreen {
    let moduleName: String
    let initialProperties: [String: Any]?
    let title: String?
}

/// Reloads React Native brownfield screens when the JS side requests it.
///
/// expo-updates' own `reloadAsync()` crashes in a brownfield app because the
/// native host -- not expo-updates -- owns the RN view lifecycle. So when an OTA
/// update is downloaded, the JS posts a `{ "type": "reload" }` message instead
/// of calling `reloadAsync()`, and we rebuild every live RN screen here: tear
/// down the runtime, start it again, and re-create each currently-presented RN
/// screen in place so the freshly-downloaded bundle is loaded. This restarts the
/// RN runtime and rebuilds the tracked RN screens; it does not touch the
/// `UIWindow` root view controller.
///
/// Create RN screens via `makeViewController(...)` so the reloader can rebuild
/// them. Every live screen is tracked (not just the most recent one) so a reload
/// never orphans a second RN screen with a dead runtime.
///
/// PUSH-ONLY: `performReload()` can only rebuild screens that live in a
/// `UINavigationController` stack. Do NOT present a tracked RN screen modally or
/// install one as a tab root until the reloader is extended to rebuild those
/// presentations too.
final class BrownfieldReloader {
    static let shared = BrownfieldReloader()

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

    /// Restart the RN runtime and rebuild every live RN screen in place so a
    /// freshly-downloaded OTA update is picked up. Safe to call from any thread;
    /// no-op if no tracked RN screen is currently in a navigation stack.
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

        // Snapshot the screens that are live in a navigation stack right now,
        // holding the view controller and its nav controller (not a positional
        // index, which the runtime restart below could invalidate).
        let rebuildable = entries.compactMap { entry -> (nav: UINavigationController, viewController: UIViewController, screen: BrownfieldScreen)? in
            guard let viewController = entry.viewController,
                  let navigationController = viewController.navigationController,
                  navigationController.viewControllers.contains(viewController)
            else {
                return nil
            }
            return (navigationController, viewController, entry.screen)
        }

        guard !rebuildable.isEmpty else { return }

        restartRuntime()

        for item in rebuildable {
            // Re-resolve the index after the restart rather than trusting a
            // pre-restart snapshot, in case the stack shifted in between.
            guard let index = item.nav.viewControllers.firstIndex(of: item.viewController) else {
                continue
            }
            let fresh = makeViewController(
                moduleName: item.screen.moduleName,
                initialProperties: item.screen.initialProperties,
                title: item.screen.title
            )
            var stack = item.nav.viewControllers
            stack[index] = fresh
            item.nav.setViewControllers(stack, animated: false)
        }

        entries.removeAll { $0.viewController == nil }
    }
}
