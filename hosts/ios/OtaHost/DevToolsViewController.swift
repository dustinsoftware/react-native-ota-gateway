import OtaGatewayLib
import ReactBrownfield
import UIKit

/// Native developer-tools page. It is the navigation root and the screen a
/// pushed RN screen returns to. Built programmatically (no storyboard) to keep
/// the host minimal.
///
/// Shows the OTA URL per environment, an environment segmented control
/// (persisted to `UserDefaults`, "restart required"), and buttons to open RN
/// screens (through the reloader ONLY) and to reload RN.
///
/// expo-updates configuration is fixed for the process lifetime, so the
/// environment selection only takes effect after a relaunch -- hence the
/// "restart required" note.
final class DevToolsViewController: UIViewController {
    private let segmentedControl = UISegmentedControl(items: ["development", "production"])
    private let otaUrlLabel = UILabel()
    private let restartLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "OTA Gateway Host"
        view.backgroundColor = .systemBackground

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)

        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
        ])

        stack.addArrangedSubview(sectionTitle("Environment (restart required)"))

        segmentedControl.accessibilityIdentifier = "env-control"
        segmentedControl.selectedSegmentIndex = HostEnvironmentPreference.current == .development ? 0 : 1
        segmentedControl.addTarget(self, action: #selector(environmentChanged), for: .valueChanged)
        stack.addArrangedSubview(segmentedControl)

        restartLabel.accessibilityIdentifier = "restart-required-label"
        restartLabel.font = .systemFont(ofSize: 13)
        restartLabel.textColor = .secondaryLabel
        restartLabel.numberOfLines = 0
        restartLabel.text = "Relaunch the app to apply an environment change."
        stack.addArrangedSubview(restartLabel)

        stack.addArrangedSubview(sectionTitle("OTA endpoint (selected environment)"))
        otaUrlLabel.accessibilityIdentifier = "ota-url-label"
        otaUrlLabel.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        otaUrlLabel.numberOfLines = 0
        stack.addArrangedSubview(otaUrlLabel)

        stack.addArrangedSubview(sectionTitle("Actions"))
        stack.addArrangedSubview(actionButton(
            title: "Open RN /",
            identifier: "open-rn-home",
            action: #selector(openHome)
        ))
        stack.addArrangedSubview(actionButton(
            title: "Open RN /developer",
            identifier: "open-rn-developer",
            action: #selector(openDeveloper)
        ))
        stack.addArrangedSubview(actionButton(
            title: "Reload RN",
            identifier: "reload-rn",
            action: #selector(reloadRN)
        ))

        updateOtaUrlLabel()
    }

    @objc private func environmentChanged() {
        let environment: ReactNativeBrownfield.OtaUpdatesEnvironment =
            segmentedControl.selectedSegmentIndex == 0 ? .development : .production
        HostEnvironmentPreference.set(environment)
        updateOtaUrlLabel()
    }

    private func updateOtaUrlLabel() {
        otaUrlLabel.text = otaUrl(for: HostEnvironmentPreference.current)
    }

    /// The OTA manifest URL for an environment, read from `Expo.plist` in the
    /// main bundle (written at prebuild by plugins/withBrownfieldUpdates.js).
    private func otaUrl(for environment: ReactNativeBrownfield.OtaUpdatesEnvironment) -> String {
        let key = environment == .production
            ? "OtaUpdatesURLProduction"
            : "OtaUpdatesURLDevelopment"
        guard let path = Bundle.main.path(forResource: "Expo", ofType: "plist"),
              let plist = NSDictionary(contentsOfFile: path),
              let url = plist[key] as? String
        else {
            return "\(key): (not found in Expo.plist)"
        }
        return url
    }

    // Open RN screens ONLY through the reloader so an OTA reload can rebuild
    // them in place (an untracked screen would be left on a dead runtime).
    @objc private func openHome() {
        pushRoute(Brownfield.homeRoute)
    }

    @objc private func openDeveloper() {
        pushRoute(Brownfield.developerRoute)
    }

    private func pushRoute(_ route: String) {
        let viewController = BrownfieldReloader.shared.makeViewController(
            moduleName: Brownfield.moduleName,
            initialProperties: [Brownfield.initialUrlKey: route],
            title: route
        )
        navigationController?.pushViewController(viewController, animated: true)
    }

    @objc private func reloadRN() {
        BrownfieldReloader.shared.reload()
    }

    // --- tiny view helpers ---

    private func sectionTitle(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: 16, weight: .semibold)
        return label
    }

    private func actionButton(title: String, identifier: String, action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.accessibilityIdentifier = identifier
        button.contentHorizontalAlignment = .center
        button.titleLabel?.font = .systemFont(ofSize: 17)
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }
}
