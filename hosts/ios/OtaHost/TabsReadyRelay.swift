import Foundation

/// Relays the JS `tabsReady` handshake (see `BrownfieldBootstrap`) to the
/// host shell. `HostShellViewController` registers itself; on notify it
/// re-posts the currently selected tab so a `selectTab` emitted before the JS
/// listener subscribed (the cold-start lost-message window) is recovered. The
/// JS side treats a re-post idempotently, so a spurious notify (e.g. the
/// surface was mounted directly at the right tab) is a no-op.
///
/// The bridge callback may fire off the main thread; the registered listener
/// is responsible for hopping to the main queue.
enum TabsReadyRelay {
    static var listener: (() -> Void)?

    static func notify() {
        listener?()
    }
}
