import UIKit

/// App entry point. Runs the brownfield bootstrap on launch and hands the window
/// setup to `SceneDelegate`.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    /// The `onMessage` subscription token from `BrownfieldBootstrap`. RETAINED
    /// for the app's lifetime -- if it deallocates, the OTA reload message is
    /// silently dropped. Do not remove this property.
    private var brownfieldMessageSubscription: NSObjectProtocol?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Boot RN + expo-updates and subscribe to the reload bridge before any
        // RN screen is created (SceneDelegate builds the dev-tools root next).
        brownfieldMessageSubscription = BrownfieldBootstrap.start()
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: "Default",
            sessionRole: connectingSceneSession.role
        )
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

/// Owns the window; its root is a `UINavigationController` wrapping the native
/// dev-tools page. RN screens are pushed onto this nav stack (push-only, so the
/// reloader can rebuild them in place).
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UINavigationController(
            rootViewController: DevToolsViewController()
        )
        self.window = window
        window.makeKeyAndVisible()
    }
}
