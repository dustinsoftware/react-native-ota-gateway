import Foundation

/// Relays the JS `tabsReady` handshake (see `BrownfieldBootstrap`) to the
/// host shell. `HostShellViewController` registers itself; on notify it
/// re-posts the currently selected tab so a `selectTab` emitted before the JS
/// listener subscribed (the cold-start lost-message window) is recovered. The
/// JS side treats a re-post idempotently, so a spurious notify (e.g. the
/// surface was mounted directly at the right tab) is a no-op.
///
/// The bridge callback may fire off the main thread. `notify()` therefore
/// hops to the main queue before reading/invoking the listener, and the
/// listener is only ever assigned on the main thread (in `viewDidLoad`), so
/// access to the shared `listener` is confined to the main queue -- no data
/// race, and the registered closure runs on the main thread.
enum TabsReadyRelay {
    static var listener: (() -> Void)?

    static func notify() {
        DispatchQueue.main.async {
            listener?()
        }
    }
}
