import UIKit

/// The More tab's NATIVE Test menu. Rows push dedicated screens onto the
/// shell's navigation stack -- Test 1 / Test 2 are React Native screens
/// (built through `BrownfieldReloader.makeViewController` so an OTA reload can
/// account for them), Test 3 is fully native -- demonstrating native and RN
/// screens mixed on one back stack with the standard navigation-bar back
/// button. While More is selected the shell mounts NO tab RN surface, so a
/// pushed Test screen is the only live RN surface.
final class MoreMenuViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private struct Row {
        let title: String
        let accessibilityIdentifier: String
        let makeViewController: () -> UIViewController
    }

    private let tableView = UITableView(frame: .zero, style: .insetGrouped)

    private lazy var rows: [Row] = [
        Row(title: "Test 1", accessibilityIdentifier: "item-test-one") {
            Self.makeReactNativeTestScreen(route: Brownfield.testOneRoute, title: "Test 1")
        },
        Row(title: "Test 2", accessibilityIdentifier: "item-test-two") {
            Self.makeReactNativeTestScreen(route: Brownfield.testTwoRoute, title: "Test 2")
        },
        Row(title: "Test 3", accessibilityIdentifier: "item-test-three") {
            NativeTestViewController()
        },
    ]

    /// Builds a pushed RN Test screen. Kept here (not in the reloader) so the
    /// menu is the single list of what the Test rows do.
    static func makeReactNativeTestScreen(route: String, title: String) -> UIViewController {
        BrownfieldReloader.shared.makeViewController(
            moduleName: Brownfield.moduleName,
            initialProperties: [
                Brownfield.initialUrlKey: route,
                // Persisted component state (host-state seam), matching the
                // shell's tab surfaces.
                Brownfield.savedStateKey: HostStateStore.readAllJson(),
            ],
            title: title
        )
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.dataSource = self
        tableView.delegate = self
        view.addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: view.topAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    // MARK: - UITableViewDataSource

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        rows.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let row = rows[indexPath.row]
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        cell.textLabel?.text = row.title
        cell.accessoryType = .disclosureIndicator
        cell.accessibilityIdentifier = row.accessibilityIdentifier
        return cell
    }

    // MARK: - UITableViewDelegate

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        // Double-tap guard: a rapid second tap fires didSelect again before the
        // push transition completes, which would stack the screen twice. Only
        // push while the SHELL (this menu's parent) is still top of the stack
        // -- the Android side gets the same dedup from singleTop.
        guard let navigation = navigationController, navigation.topViewController === parent else {
            return
        }
        navigation.pushViewController(rows[indexPath.row].makeViewController(), animated: true)
    }
}
