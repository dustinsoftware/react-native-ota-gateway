import Foundation
import OtaGatewayLib
import ReactBrownfield

/// Boots the React Native brownfield runtime and wires the OTA reload bridge.
///
/// The ordering is load-bearing:
/// 1. point the runtime at the framework's JS bundle (`ReactNativeBundle`);
/// 2. register the Expo modules provider so expo-modules are available;
/// 3. `initializeUpdates(environment:)` BEFORE `startReactNative` -- it provides
///    the bundle URL to expo-updates and publishes the host environment to the
///    JS layer (modules/host-environment) so `gateway-url.ts` resolves the live
///    host selection rather than a baked/OTA-cached value. The environment comes
///    from `HostEnvironmentPreference` (the dev-tools segmented control);
/// 4. `startReactNative`;
/// 5. subscribe to `onMessage`: the JS posts `{ "type": "reload" }` after an OTA
///    download (expo-updates' `reloadAsync()` crashes in brownfield), and the
///    host rebuilds its live RN screens via `BrownfieldReloader`.
enum BrownfieldBootstrap {
    /// Returns the `onMessage` subscription token. THE CALLER MUST RETAIN IT for
    /// the app's lifetime -- if it deallocates, the subscription is torn down and
    /// the OTA reload message is silently dropped.
    static func start() -> NSObjectProtocol {
        let runtime = ReactNativeBrownfield.shared
        runtime.bundle = ReactNativeBundle
        runtime.ensureExpoModulesProvider()
        runtime.initializeUpdates(environment: HostEnvironmentPreference.current)
        runtime.startReactNative()
        return runtime.onMessage { message in
            switch parseMessage(message) {
            case .reload:
                BrownfieldReloader.shared.reload()
            case let .saveState(key, stateJson):
                HostStateStore.write(sliceKey: key, stateJson: stateJson)
            case .none:
                break
            }
        }
    }

    /// Parse a raw JSON bridge message. Returns `nil` for malformed JSON or an
    /// unrecognized `type` (both ignored -- the bridge is an untrusted input).
    static func parseMessage(_ message: String) -> BrownfieldMessage? {
        guard let data = message.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else { return nil }

        switch type {
        case Brownfield.reloadMessageType:
            return .reload
        case Brownfield.saveStateMessageType:
            guard let key = json["key"] as? String, !key.isEmpty,
                  let state = json["state"] as? [String: Any],
                  let stateData = try? JSONSerialization.data(withJSONObject: state),
                  let stateJson = String(data: stateData, encoding: .utf8)
            else { return nil }
            return .saveState(key: key, stateJson: stateJson)
        default:
            return nil
        }
    }
}
