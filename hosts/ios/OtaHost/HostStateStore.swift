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
    private static let maxSliceBytes = 16 * 1024

    /// Persist one slice (already-serialized JSON object string).
    ///
    /// NOTE: read-modify-write of the whole slice dictionary. Safe today
    /// because brownfield `onMessage` delivery is serialized and only one RN
    /// surface checkpoints at a time; if a second CONCURRENT writer ever
    /// appears, wrap this in a serial queue or a sibling slice can be lost
    /// (Android's per-key SharedPreferences write does not have this hazard).
    static func write(sliceKey: String, stateJson: String) {
        // Size cap mirroring the JS-side guard (host-state.ts); the
        // secret-name denylist lives on the JS side.
        guard stateJson.utf8.count <= maxSliceBytes else {
            print("[HostStateStore] Dropping oversized saved-state slice \(sliceKey)")
            return
        }
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
