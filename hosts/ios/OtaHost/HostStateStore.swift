import Foundation

/// The native store behind the RN saved-state seam (apps/mobile
/// src/brownfield/host-state.ts).
///
/// RN components checkpoint state slices by posting
/// `{ "type": "saveState", "key": <slice>, "state": <object> }` over the
/// brownfield message bridge; `BrownfieldBootstrap` routes those here and each
/// slice is written into `UserDefaults`. Every RN surface the host mounts gets
/// the WHOLE store back as the `savedStateJson` initial property
/// (`readAllJson`), so a dismissed component -- the fidget spinner mid-coast,
/// say -- resumes exactly where it left off, across tab switches, pushed
/// screens, and process death.
///
/// Slices are stored as JSON strings keyed by the RN-side slice key; malformed
/// slices are dropped on read (never propagated to a fresh surface).
enum HostStateStore {
    private static let defaultsKey = "OtaHostSavedState"

    /// Persist one slice (already-serialized JSON object string).
    static func write(sliceKey: String, stateJson: String) {
        var slices = UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
        slices[sliceKey] = stateJson
        UserDefaults.standard.set(slices, forKey: defaultsKey)
    }

    /// The whole store as a JSON object of slices: `{"spinner": {...}, ...}`.
    static func readAllJson() -> String {
        let slices = UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
        var all: [String: Any] = [:]
        for (key, json) in slices {
            guard let data = json.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            all[key] = parsed
        }
        guard let data = try? JSONSerialization.data(withJSONObject: all),
              let string = String(data: data, encoding: .utf8)
        else { return "{}" }
        return string
    }
}
