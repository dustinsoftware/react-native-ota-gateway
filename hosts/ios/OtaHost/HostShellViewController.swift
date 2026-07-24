import ReactBrownfield
import UIKit

/// The native host shell and the app's navigation root.
///
/// It owns a bottom `UITabBar` (Developer / Sky / Spinner / More) and a single
/// content slot that hosts at most ONE React Native surface at a time.
/// Selecting an RN tab tears down and deallocates the previous surface and
/// mounts a fresh one for the tab's route through `BrownfieldReloader`, so
/// there are never two concurrent ExpoRoot surfaces. The More tab is NATIVE
/// (`MoreMenuViewController`): it mounts no RN surface, and its Test rows push
/// dedicated screens onto the navigation stack -- so a pushed RN Test screen
/// is the only live RN surface while More is selected.
///
/// A deliberate `UITabBar` (not a `UITabBarController`) is used so the shell
/// does not retain an RN root per tab -- only the active surface exists. The shell
/// also provides the native navigation context: a title per tab and, on the
/// Developer tab, a Settings action that presents `HostSettingsViewController`.
///
/// The selected tab is persisted (`HostTabPreference`) for scene restoration and
/// so an OTA reload rebuilds the same surface. The shell is the
/// `BrownfieldReloader` host: on reload it rebuilds the active surface in place,
/// preserving the selected tab and any presented settings.
final class HostShellViewController: UIViewController, BrownfieldReloadHost {
    private let tabBar = UITabBar()
    private let contentContainer = UIView()
    private var currentSurface: UIViewController?
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
        selectTab(selectedTab, persist: false)
    }

    // MARK: - BrownfieldReloadHost

    /// Rebuild the active RN surface after the runtime restarted (OTA reload or
    /// manual reload). The reloader has already restarted the runtime; here we
    /// only recreate the surface for the current tab, leaving the selected tab
    /// and any presented settings untouched. Any PUSHED screen (the More tab's
    /// Tests) is popped first: a pushed RN screen predating the restart sits on
    /// the torn-down runtime and cannot be rebuilt in place on the stack.
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
        mountSurface(for: tab)
    }

    private func updateNavigationItem() {
        navigationItem.title = selectedTab.title
        navigationItem.rightBarButtonItem = selectedTab == .developer ? settingsButton : nil
    }

    /// Mount a tab's content in the single content slot, tearing down the
    /// previous surface first. RN tabs mount one RN surface (so only one
    /// ExpoRoot surface is ever live); the native More tab mounts the Test
    /// menu and leaves NO RN surface mounted -- its rows push dedicated
    /// screens on the navigation stack instead.
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
            ],
            title: tab.title
        )
        embedSurface(controller)
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
