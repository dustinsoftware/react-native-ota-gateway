import ReactBrownfield
import UIKit

/// The native host shell and the app's navigation root.
///
/// It owns a bottom `UITabBar` (Developer / Sky / Spinner / More) and a single
/// content slot that hosts at most ONE React Native surface at a time.
///
/// RN tabs keep ONE persistent surface: switching between Developer / Sky /
/// Spinner does NOT tear down and remount. Instead the shell updates its native
/// chrome and posts a `selectTab` bridge message
/// (`{ "type": "selectTab", "route": <path> }`) to the live surface, whose JS
/// listener calls `router.navigate(route)` -- so there is no per-tab-switch flash
/// (see docs/brownfield.md and docs/single-root-tabs-experiment.md). This
/// replaces the older teardown-per-tab design.
///
/// The More tab is NATIVE (`MoreMenuViewController`): selecting it TEARS DOWN
/// the RN surface (the one-ExpoRoot rule forbids leaving it mounted, even
/// hidden, while More's Test rows push their own RN screens), so a pushed RN
/// Test screen is the only live RN surface while More is selected. Returning
/// from More to an RN tab deliberately mounts a FRESH surface for that tab.
///
/// A deliberate `UITabBar` (not a `UITabBarController`) is used so the shell
/// does not retain an RN root per tab -- only the active surface exists. The shell
/// also provides the native navigation context: a title per tab and, on the
/// Developer tab, a Settings action that presents `HostSettingsViewController`.
///
/// The selected tab is persisted (`HostTabPreference`) for scene restoration and
/// so an OTA reload rebuilds the same surface. The shell is the
/// `BrownfieldReloader` host: an OTA reload restarts the runtime, so on reload it
/// rebuilds (real teardown + mount) the active surface in place, preserving the
/// selected tab and any presented settings -- a rebuild is never a message post,
/// because the old surface sits on the dead runtime.
final class HostShellViewController: UIViewController, BrownfieldReloadHost {
    private let tabBar = UITabBar()
    private let contentContainer = UIView()
    private var currentSurface: UIViewController?
    /// Whether the content slot currently holds a LIVE RN surface (as opposed
    /// to the native More menu, or nothing). Drives the mount-vs-post decision
    /// in `selectTab`: a soft route swap is only valid when a persistent RN
    /// surface is actually mounted to receive the `selectTab` bridge message.
    /// Keyed off surface identity, not the previous tab, so returning from More
    /// (native, no RN surface) to an RN tab correctly mounts fresh.
    private var hasMountedReactSurface = false
    private var selectedTab: HostTab = HostTabPreference.current

    private lazy var settingsButton = UIBarButtonItem(
        image: UIImage(systemName: "gearshape"),
        style: .plain,
        target: self,
        action: #selector(openSettings)
    )

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        BrownfieldReloader.shared.host = self

        setupTabBar()
        setupContentContainer()

        // Register the tabsReady relay BEFORE mounting the initial surface, so a
        // handshake posted as JS boots can never arrive before the listener
        // exists. `notify()` marshals to the main queue, so this runs on main.
        //
        // JS announces its selectTab listener is live; re-post the selected
        // tab: a tap in the window after the event emitter wired up but before
        // that listener subscribed was emitted into the void, which would
        // strand the shell on the mount-time route. Idempotent JS-side. Guarded
        // on a live RN surface AND no restart in flight -- mirroring the soft
        // `selectTab` path -- so we never post to a stopped/rebuilding runtime
        // (the selection is materialized by `rebuildActiveSurface` instead).
        TabsReadyRelay.listener = { [weak self] in
            guard let self,
                  self.hasMountedReactSurface,
                  !BrownfieldReloader.shared.isRestartInFlight,
                  let route = self.selectedTab.route
            else { return }
            self.postSelectTab(route: route)
        }

        selectTab(selectedTab, persist: false)
    }

    // MARK: - BrownfieldReloadHost

    /// Rebuild the active RN surface after the runtime restarted (OTA reload or
    /// manual reload). The reloader has already restarted the runtime; here we
    /// only recreate the surface for the current tab, leaving the selected tab
    /// and any presented settings untouched. This is a REAL teardown + mount
    /// (never a `selectTab` post): the runtime restarted, so the old surface is
    /// dead and a bridge message would be lost. Any PUSHED screen (the More
    /// tab's Tests) is popped first: a pushed RN screen predating the restart
    /// sits on the torn-down runtime and cannot be rebuilt in place on the stack.
    func rebuildActiveSurface() {
        navigationController?.popToRootViewController(animated: false)
        mountSurface(for: selectedTab)
    }

    // MARK: - Setup

    private func setupTabBar() {
        tabBar.translatesAutoresizingMaskIntoConstraints = false
        tabBar.delegate = self
        tabBar.items = HostTab.allCases.map { tab in
            let item = UITabBarItem(
                title: tab.title,
                image: UIImage(systemName: tab.systemImageName),
                tag: tab.rawValue
            )
            item.accessibilityIdentifier = "tab-\(tab.title.lowercased())"
            return item
        }
        view.addSubview(tabBar)
        NSLayoutConstraint.activate([
            tabBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tabBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tabBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    private func setupContentContainer() {
        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(contentContainer)
        NSLayoutConstraint.activate([
            contentContainer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            contentContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            contentContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            contentContainer.bottomAnchor.constraint(equalTo: tabBar.topAnchor),
        ])
    }

    // MARK: - Tabs

    private func selectTab(_ tab: HostTab, persist: Bool = true) {
        selectedTab = tab
        if persist {
            HostTabPreference.set(tab)
        }
        tabBar.selectedItem = tabBar.items?.first { $0.tag == tab.rawValue }
        updateNavigationItem()

        // Soft switch (RN tab -> RN tab): a persistent RN surface is already
        // mounted and the runtime is up, so keep the surface and drive the
        // route change over the bridge instead of tearing it down -- no flash.
        // The JS listener handles the posted message with router.navigate.
        if let route = tab.route,
           hasMountedReactSurface,
           !BrownfieldReloader.shared.isRestartInFlight {
            postSelectTab(route: route)
            return
        }

        // Hard mount otherwise. This covers: target is the native More tab; no
        // live RN surface is mounted (first mount, or returning from More); or a
        // restart is in flight. In the restart case `mountSurface` skips the
        // mount AND we skip the post above -- the runtime is down, so the
        // message would be lost -- and the selection we just persisted is
        // materialized by `rebuildActiveSurface` once the restart completes.
        mountSurface(for: tab)
    }

    /// Post the `selectTab` bridge message so the persistent RN surface swaps
    /// its route in place. Serialized with `JSONSerialization` (never string
    /// interpolation) so a route can't break the JSON payload.
    private func postSelectTab(route: String) {
        let payload: [String: Any] = [
            "type": Brownfield.selectTabMessageType,
            "route": route,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else { return }
        ReactNativeBrownfield.shared.postMessage(json)
    }

    private func updateNavigationItem() {
        navigationItem.title = selectedTab.title
        navigationItem.rightBarButtonItem = selectedTab == .developer ? settingsButton : nil
    }

    /// Hard-mount a tab's content in the single content slot, tearing down the
    /// previous surface first. This is the teardown+mount path used for the
    /// FIRST mount, for returning from the native More tab to an RN tab, and by
    /// `rebuildActiveSurface` after a runtime restart -- NOT for RN tab -> RN
    /// tab switches, which `selectTab` handles as a soft route swap over the
    /// bridge. RN tabs mount one RN surface (so only one ExpoRoot surface is
    /// ever live); the native More tab mounts the Test menu and leaves NO RN
    /// surface mounted -- its rows push dedicated screens on the navigation
    /// stack instead.
    private func mountSurface(for tab: HostTab) {
        guard let route = tab.route else {
            removeCurrentSurface()
            embedSurface(MoreMenuViewController())
            return
        }

        // While a runtime restart is in flight the RN runtime is down; a
        // surface mounted now (e.g. a tab switch landing in that window)
        // would sit on a dead runtime. Skip it -- the restart completion
        // calls rebuildActiveSurface(), which mounts the selected tab fresh.
        guard !BrownfieldReloader.shared.isRestartInFlight else { return }

        removeCurrentSurface()

        let controller = BrownfieldReloader.shared.makeViewController(
            moduleName: Brownfield.moduleName,
            initialProperties: [
                Brownfield.initialUrlKey: route,
                // Persisted component state (host-state seam); lets a
                // remounted surface resume e.g. the spinner mid-coast.
                Brownfield.savedStateKey: HostStateStore.readAllJson(),
                // Tab surfaces resume their last in-surface path across tab
                // switches; pushed screens deliberately do NOT set this.
                Brownfield.restoreNavStateKey: true,
                // Wall-clock instant (ms since epoch) these props were minted.
                // nav-restore honors a `nav:activeTab` override only when the
                // user's selection post-dates this stamp (an in-place OTA
                // reload reusing STALE props), so a genuinely fresh mount is
                // never hijacked back to a previously-selected tab.
                Brownfield.mountedAtKey: Date().timeIntervalSince1970 * 1000,
            ],
            title: tab.title
        )
        embedSurface(controller)
        hasMountedReactSurface = true
    }

    private func embedSurface(_ controller: UIViewController) {
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        contentContainer.addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            controller.view.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),
            controller.view.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
        ])
        controller.didMove(toParent: self)
        currentSurface = controller
    }

    private func removeCurrentSurface() {
        guard let current = currentSurface else { return }
        current.willMove(toParent: nil)
        current.view.removeFromSuperview()
        current.removeFromParent()
        currentSurface = nil
        // The slot no longer holds a live RN surface. The RN mount path sets
        // this back to true after re-embedding; the More path leaves it false.
        hasMountedReactSurface = false
    }

    // MARK: - Settings

    @objc private func openSettings() {
        let settings = HostSettingsViewController()
        let navigation = UINavigationController(rootViewController: settings)
        present(navigation, animated: true)
    }
}

extension HostShellViewController: UITabBarDelegate {
    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard let tab = HostTab(rawValue: item.tag), tab != selectedTab else { return }
        selectTab(tab)
    }
}
