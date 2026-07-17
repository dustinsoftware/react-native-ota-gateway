import UIKit

/// Test 3: a fully NATIVE pushed screen, presented exactly like the pushed RN
/// Test screens (navigation-bar title + back chevron + push transition). Its
/// button pushes RN Test 1 on top -- native menu -> native screen -> RN screen
/// is the mix-and-match point of the More tab demo.
final class NativeTestViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Test 3"
        view.backgroundColor = .systemBackground

        let headline = UILabel()
        headline.text = "Test 3"
        headline.font = .systemFont(ofSize: 28, weight: .bold)
        headline.textAlignment = .center

        let body = UILabel()
        body.text = "This screen is fully native. It shares the pushed-screen "
            + "presentation with the React Native Test screens, and can push one itself."
        body.font = .systemFont(ofSize: 16)
        body.textColor = .secondaryLabel
        body.textAlignment = .center
        body.numberOfLines = 0

        let pushButton = UIButton(type: .system)
        pushButton.setTitle("Push RN Test 1", for: .normal)
        pushButton.accessibilityIdentifier = "button-push-rn-test-one"
        pushButton.addTarget(self, action: #selector(pushReactNativeTestOne), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [headline, body, pushButton])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    @objc private func pushReactNativeTestOne() {
        let controller = MoreMenuViewController.makeReactNativeTestScreen(
            route: Brownfield.testOneRoute,
            title: "Test 1"
        )
        navigationController?.pushViewController(controller, animated: true)
    }
}
