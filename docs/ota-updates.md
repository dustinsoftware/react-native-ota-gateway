# OTA Updates

This app ships over-the-air JavaScript updates with **`expo-updates`** against a
**self-hosted implementation of the Expo Updates Protocol v1** -- no EAS, no
Expo-hosted service. The manifest is served by the app's own Express server (the
same one that hosts the standalone web build), and bundle assets are served as
static files from that server. `expo-updates` is pinned exact at `55.0.20` (no
`~`, matching the rest of the expo family -- see the exact-pin gotcha in
[brownfield.md](./brownfield.md)) for the iOS brownfield reload fix.

Genericized names used throughout: manifest route `/api/v2/updates/manifest`,
static prefix `/api/v2/updates/static`, base-URL placeholder
`__OTA_GATEWAY_BASE_URL__`, `runtimeVersion "1"`, gateways `http://localhost:3000`
(dev) / `http://localhost:3001` (prod).

## Pieces

| Piece | Location | Role |
| --- | --- | --- |
| Export | `scripts/export-web.mjs` | Runs `expo export` for all platforms (web server output + native), then kills the process (Metro never exits on its own). |
| Code-signing keys | `scripts/generate-code-signing-keys.mjs` | Generates the RSA keypair + self-signed certificate into `certs/` (`private-key.pem`, `certificate.pem`). A one-time per-clone setup step; both files are gitignored. See [Code signing](#code-signing). |
| Manifest generator | `scripts/generate-update-manifest.mjs` | Turns the native export's `metadata.json` into the storeVersion-3 update store (`dist/server/update-manifest.json`): for each retained update it **materializes and signs the final per-environment manifest variants** (development + production) with the private key. The new update plus retained previous updates (`.ota-archive/`, default 3, `OTA_RETAIN_UPDATES`) and per-environment channel pointers repointed at the new export; copies every retained update's bundle + assets into `dist/client/`. |
| Manifest route | `src/app/api/v2/updates/manifest+api.ts` | `expo-router` `+api.ts` route that selects this instance's pre-signed environment variant and serves its exact stored bytes verbatim, adding the `expo-signature` header. No request-time stamping or id derivation. |
| Static mount | `server/index.ts` | `express.static` on `/api/v2/updates/static` (1-year `immutable`; safe via `?h=` busters). |
| Launch gate | `src/components/ota-gate.tsx` + `src/utils/attempt-ota-update.ts` | Blocks first render while an update is fetched, iff the last OTA attempt is missing or >24h old -- once per 24h, once per JS runtime. |
| Reload | `src/utils/reload-app.ts` | Bridge reload under a brownfield host; `Updates.reloadAsync()` standalone. |

## The manifest route

`src/app/api/v2/updates/manifest+api.ts` implements the Protocol v1 handshake.
It is a **verbatim server**: the environment-specific manifest bytes and their
signature are produced at export time (see [Code signing](#code-signing) and
[Single build, two environments](#single-build-two-environments)), so the route
does no stamping, id derivation, or signing of its own -- it selects the right
pre-signed variant and streams its stored bytes untouched.

On `GET` it reads the request headers `expo-platform`, `expo-runtime-version`,
`expo-protocol-version`, then:

- `expo-platform` not `ios`/`android` -> **400** (`Unsupported platform`).
- `expo-protocol-version` not `1` -> **406** (`Unsupported protocol version`).
- No `dist/server/update-manifest.json` on disk -> **204** (no update; normal on
  first deploy).
- Store `storeVersion` != 3 -> **500** (a deploy bug: the image is rebuilt with
  every export, so there is no migration case). Empty `updates` -> **204**.
- **Update selection**: `OTA_UPDATE_PIN` (a per-instance override naming a
  retained update key -- the rollback/canary lever) wins; otherwise this
  environment's channel pointer (`channels.development` / `.production`, same
  strict-`production` polarity as gateway resolution). A dangling key falls
  back to the newest retained update, loudly logged.
- Selected update's `runtimeVersion` != the client's `expo-runtime-version` ->
  **204** (the client's native runtime is incompatible with this bundle).
- No manifest for the requested platform -> **204**.
- No stored variant for this instance's environment -> **204**, loudly logged
  (the same withhold polarity as the pre-signing era's missing-gateway case; the
  export fails before shipping a store that lacks a required variant).
- Otherwise -> **200** `multipart/mixed` with the manifest part
  (`Content-Disposition: form-data; name="manifest"`) carrying the stored body
  **byte-for-byte**, boundary `expo-update-response`, and the protocol response
  headers (`expo-protocol-version: 1`, `expo-sfv-version: 0`,
  `cache-control: private, max-age=0`). The **`expo-signature`** header
  (structured field `sig="<base64>", keyid="main"`) that authenticates the served
  bytes is emitted **on the manifest part itself** -- for multipart responses the
  expo-updates client reads the signature from the part headers, not the
  top-level HTTP headers (it only consults the HTTP header for non-multipart
  responses). The route also mirrors it as an HTTP header for `curl`
  convenience. The body must be served exactly as stored -- re-serializing it
  would change the bytes the signature covers and fail client verification.

## Single build, two environments

The core design constraint: **one exported build serves both environments**. The
dev server (`:3000`) and prod server (`:3001`) read the *same* `dist/`. Baking a
concrete gateway host at export time would make an export correct for only one
environment. The generator therefore materializes, for each retained update and
each platform, **both pre-resolved environment variants** and the route picks the
one matching its `OTA_ENVIRONMENT`.

Because a signature must cover the *exact* bytes served (see
[Code signing](#code-signing)), the two mechanisms that used to run per request
-- placeholder stamping and per-environment id derivation -- both move to **export
time**, where the private key is present. The route no longer transforms the
manifest at all; it serves stored bytes verbatim.

### 1. Placeholder stamping at export time

`generate-update-manifest.mjs` builds each platform manifest once with the
placeholder token `__OTA_GATEWAY_BASE_URL__` everywhere a base URL appears --
launch-asset URL, every asset URL, `updates.url`, and `extra.gatewayUrl` in the
embedded expo config. It then reads the `gatewayUrls` map (`{ development:
http://localhost:3000, production: http://localhost:3001 }`, from `app.json`) and,
for **each** environment, replaces every occurrence of the placeholder with that
environment's host, producing a final manifest JSON string. Each variant's exact
bytes are then signed with the private key and stored as `{ body, signature }`.

At serve time the manifest route resolves the environment from `OTA_ENVIRONMENT`
(`production` -> the prod variant, anything else -> dev; the same strict
`=== 'production'` polarity used server-side) and returns that variant's stored
`body` and `signature` untouched. A bundle applied via OTA therefore talks to the
same environment that served it, and the served bytes match their signature
exactly.

The export **fails** if `gatewayUrls` is missing either environment, so a store
is never shipped that lacks a variant the route might be asked for. If -- despite
that -- no variant exists for the running environment, the route logs and
**withholds the update (204)** rather than hand out an unsigned or wrong-host body
(the same withhold polarity as before).

`OTA_GATEWAY_URL` (build-time) remains an escape hatch for one-off exports pinned
to a concrete host: the generator emits a **single** pre-signed variant with the
placeholder already replaced by that host, and the route serves it regardless of
`OTA_ENVIRONMENT`.

### 2. Per-environment update-id derivation

The **baked** update id identifies bundle *content*, so both environments would
otherwise carry the *same* id with *different* gateway URLs. **expo-updates
treats update ids as globally unique.** A client that cached an update while
pointed at one environment and then receives the same id from the other logs
"this is a server error", rewrites the stored update's scope key, and relaunches
the **cached** manifest -- so the embedded config (including the gateway URL)
never follows a host-environment switch.

To prevent that, the generator derives each variant's served id per environment,
before signing, so the id is part of the signed bytes:

```
deriveEnvironmentUpdateId(bakedId, base) =
    SHA-256( bakedId + "\n" + resolvedGatewayBase )  -> first 128 bits -> UUID
```

The formula is unchanged from the request-time era; only its location moved (from
the route into the generator). It is deterministic per `(build, environment)`, and
the two environments can never share one id. Assets are still deduplicated
client-side by content hash, so re-pointing to the other environment only inserts
a new update row on the device -- it does **not** re-download the bundle.

The baked id itself is `hashToUUID(bundleContentHash)` in the generator:
same bundle content always yields the same baked id (avoids needless
re-downloads); each variant's id derives from it.

Retained/archived updates are **re-materialized and re-signed on every export**
(the key is present at export time), so a rollback target's variants stay
correctly signed even though its bundle was built by an earlier export.

## Code signing

The manifest and its assets already carry SHA-256 hashes: the client checks each
downloaded asset's bytes against the hash in the manifest. That is **integrity**
-- the assets match the manifest -- but not **authenticity**: it says nothing
about *who authored the manifest*. Anyone who controls the serving path (the
gateway container, the deploy pipeline, a CDN in front, DNS) can compose a
self-consistent malicious manifest -- correct hashes over attacker-chosen bytes --
and every device that fetches it runs the attacker's JS. Hash integrity cannot
detect this, because the attacker recomputes the hashes.

Code signing closes that gap using the **Expo Updates Protocol v1
`expo-signature`** mechanism. The generator signs each served manifest with an
RSA private key; every host verifies the signature against a certificate baked
into the binary at build time. The trust anchor shrinks to a single private key
that lives only where exports run (a dev machine or CI) and **never touches the
serving containers, the CDN, or DNS** -- so compromising the serving path is no
longer enough to push code to devices.

The failure mode keeps the design's freeze-not-break polarity: if a signature
does not verify (wrong key, tampered bytes, no signature), the client **rejects
the update and keeps running its current bundle** -- the same outcome as a
`runtimeVersion` mismatch or an offline check.

### Keys are required

`scripts/generate-code-signing-keys.mjs` generates an RSA keypair and a
self-signed certificate into `apps/mobile/certs/`:

| File | Purpose |
| --- | --- |
| `certs/private-key.pem` | Signs manifests at export time. Never leaves the machine that exports. |
| `certs/certificate.pem` | Baked into the binary; verifies signatures on-device. |

**Both files are gitignored.** This is a public template with no shared key, so
every clone generates its own pair (run the setup script once after cloning; see
[development-workflow.md](./development-workflow.md)). The keyid is `main` and the
algorithm is `rsa-v1_5-sha256`. Export **and** prebuild fail loudly, pointing at
the setup script, when the key material is missing -- there is no unsigned mode.

### Client side

`app.json`'s `updates` block carries:

```jsonc
"codeSigningCertificate": "./certs/certificate.pem",
"codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" }
```

`expo prebuild` bakes these into the native projects:

- **iOS `Expo.plist`**: `EXUpdatesCodeSigningCertificate` (the certificate PEM)
  and `EXUpdatesCodeSigningMetadata` (the keyid/alg dictionary).
- **Android manifest meta-data**: `expo.modules.updates.CODE_SIGNING_CERTIFICATE`
  and `expo.modules.updates.CODE_SIGNING_METADATA`.

With a certificate configured, expo-updates sends an `expo-expect-signature`
request header (`sig, keyid="main", alg="rsa-v1_5-sha256"`) on every update
request and **rejects any manifest whose `expo-signature` does
not verify** against the embedded certificate. For the multipart responses this
server always produces, the client reads `expo-signature` from the **manifest
part's headers**, not the top-level HTTP response headers.

### Export-time pre-signing

Because the signature covers the exact served bytes, signing happens where the
private key lives -- at export time, not per request. For each retained update and
each platform, `generate-update-manifest.mjs`:

1. materializes the two pre-resolved environment variants (development and
   production) -- final manifest JSON strings with the placeholder already
   replaced and the per-environment update id already derived (see
   [Single build, two environments](#single-build-two-environments));
2. signs each variant's exact bytes with the private key;
3. stores, per variant, `{ body, signature }` -- `body` being the exact JSON
   string and `signature` its base64 RSA signature.

The store bumps to **storeVersion 3** to carry these per-variant bodies +
signatures. A concrete `OTA_GATEWAY_URL` export produces a single pre-signed
variant instead of two.

The manifest route then does no cryptography: it selects this instance's variant,
serves `body` verbatim in the multipart part, and emits `expo-signature:
sig="<the stored base64>", keyid="main"` as a **part header** on that manifest
part (where the client looks for it in multipart responses; it is mirrored as an
HTTP header too). Serving the stored bytes untouched is essential --
any re-serialization would change the signed bytes and fail verification on every
device.

## Content-addressed launch asset

The launch asset's `key` is derived from the **content** hash, not Metro's
`entry-<hash>` filename:

```
launchAsset.key = "entry-<first 16 base64url chars of the bundle's SHA-256>"
```

Why: expo-updates' on-device store dedupes and names downloaded assets by `key`
**without re-hashing** files already on disk, and Metro's `entry-<hash>` filename
is not reliably content-addressed across builds (it appears to be derived before
Hermes compilation, and two builds have produced the same filename with different
`.hbc` bytes). A filename-derived key let a device silently reuse a previous
build's stale bundle bytes for a new update. A content-derived key makes new
bytes a new asset on-device.

Regular (non-launch) assets keep Metro's key: those filenames *are* content
hashes, and the bundle resolves embedded assets by that exact key at runtime.

## Edge cache-busters (`?h=`)

The static mount serves assets with `public, max-age=31536000, immutable`, which
is only safe if the URL changes whenever the bytes do. Every asset URL in the
manifest therefore carries a content-hash query buster:

```
<base>/api/v2/updates/static/<path>?h=<first 16 base64url chars of the file SHA-256>
```

The same filename-reuse hazard that motivates the content-addressed key exists at
the edge: without the buster, a deploy that changes the bytes under an unchanged
filename can leave a cache serving the old file, and every client then fails
expo-updates' SHA-256 integrity check. Keying the query string on the actual
content hash makes each cached entry genuinely immutable. The server ignores the
query string when resolving the file on disk; expo-updates dedupes by `key`, not
URL. (In front of a CDN this relies on the edge cache key including the query
string -- the common default; an "ignore query string" rule would silently
disable the buster.)

## Launch gating: `OtaGate`

`OtaGate` wraps the route stack (in `_layout.tsx`) and runs identically in
standalone and brownfield modes. Its policy is **unconditional staleness** of
the last OTA *attempt* -- a 24h window tracked in `ota-timestamp.ts` under the
SecureStore key `ota_gateway_last_updated` (its meaning is now "last OTA
attempt", not "last confirmed update"):

1. **Attempt-based throttle.** `attempt-ota-update.ts` saves the timestamp once
   per real attempt **regardless of outcome** -- success (`reloading`),
   `no-update`, or `error`. (The `__DEV__` / Updates-disabled early return saves
   nothing.) A failed attempt therefore also starts the 24h window, so the gate
   will not retry until the window elapses.
2. **Gate iff stale.** `OtaGate` blocks rendering (showing the "Updating" screen)
   and runs an attempt **iff the last attempt timestamp is missing or >24h old**.
   There is no `isEmbeddedLaunch` special case. A first-ever launch has no
   timestamp -> stale -> gates once; after that a user sees "Updating" at most
   once per 24h window (the next launch or surface mount after the window
   elapses), never on remounts in between.
3. **Once per JS runtime, single-flight.** Gate resolution lives in a
   module-scoped store, `ota-gate-state.ts` (`OtaGate` consumes it via
   `useSyncExternalStore`): the whole resolution -- timestamp read, staleness
   decision, and the attempt itself -- runs behind a single shared promise, so
   it executes **at most once per runtime** and concurrent mounts join the
   in-flight resolution instead of racing duplicate reads or attempts. Once
   resolved `ready`, later surface mounts in the same runtime render children
   immediately and synchronously -- no async timestamp read, no blank frame, no
   "Updating" flash. This matters in **brownfield hosts, where surface mounts
   still recur** -- More <-> RN-tab returns, pushed Test screens, and OTA
   reloads all mount an RN surface (all mounts share one JS runtime; RN-tab ->
   RN-tab switches no longer remount under the single-root design, but the other
   paths do). Without the shared store each remount would re-run the check and
   flash "Updating", and a fast surface mount during the first gate could start
   two concurrent attempts. An OTA reload restarts the runtime (resetting the
   store), but the freshly saved timestamp keeps that remount gate-free.

`attempt-ota-update.ts` performs the check/fetch and then calls the reload
helper. `ota-app-version.ts` exposes the human-readable build identifier for the
diagnostics screen (read from `Updates.manifest.extra.otaAppVersion`).

## `useEmbeddedUpdate: false` (must stay false)

`app.json`'s `updates` block sets `useEmbeddedUpdate: false`. Keep it false.
The flag's actual mechanism (verified in expo-updates'
`AppLauncherWithDatabase`): when false, the **embedded update is excluded from
the launcher's launchable candidates**, so expo-updates only ever selects a
downloaded OTA; when true (the expo default), the embedded update competes in
launch selection alongside cached OTAs. The historical reason for pinning it
false -- the old `OtaGate` branched on `Updates.isEmbeddedLaunch` -- is gone
(the gate no longer consults it), but keep it false anyway: this is the
on-device-proven configuration, the brownfield release path has its own
embedded-bundle fallback (the `bundleURLOverride` seam, see
[brownfield.md](./brownfield.md)) so excluding the embedded update from the
launcher costs nothing, and flipping it changes which bundle the launcher
selects around first install / post-install states -- re-verify the whole OTA
matrix before ever changing it. `Updates.isEmbeddedLaunch` remains surfaced on
the Developer screen as a diagnostic; its observed values also shift if the
flag flips.

## Reload: bridge-based in brownfield, `reloadAsync` standalone

`Updates.reloadAsync()` **crashes in a brownfield app**: its relaunch procedure
cannot restart a React Native root that the native host owns. So `reloadApp()`
(`src/utils/reload-app.ts`) branches:

- **Brownfield host** (detected via `markBrownfieldHost()` in
  `src/brownfield/runtime.ts`): post a `{ type: 'reload' }` message over the
  Callstack bridge. The native host receives it and rebuilds the RN root so the
  downloaded bundle loads (iOS `BrownfieldReloader`, Android
  `BrownfieldReloadHandler` -- see [brownfield.md](./brownfield.md)).
- **Standalone / web**: call `Updates.reloadAsync()`.

The `reload` message type is part of the native <-> RN message contract and must
match on both sides.

## What OTA cannot do

- OTA replaces the **JS bundle** only. Native changes (new native modules, a
  dependency bump that changes the native surface) require a **new artifact** and
  a `runtimeVersion` bump; expo-updates only applies an update whose
  `runtimeVersion` matches the running native runtime.
- The manifest gates compatibility by `runtimeVersion`; mismatches return 204.

## Proving delivery

The Developer screen renders a `BUNDLE_MARKER` constant
(`src/constants/marker.ts`, initially `OTA marker: v1`) alongside the current
update id and `isEmbeddedLaunch`. The delivery proof (bump the marker,
re-export, Check -> Download -> Restart, watch it change to `v2` with
`isEmbeddedLaunch false` and a new update id) is the DONE demo; the exact steps are in
[development-workflow.md](./development-workflow.md).

## Related docs

- [configuration.md](./configuration.md) -- `OTA_ENVIRONMENT`, the gateway map,
  the code-signing key/cert locations and required-keys policy, the runtime
  host-environment seam that decides which gateway the app's own requests use.
- [brownfield.md](./brownfield.md) -- how the host rebuilds the RN root on a
  reload message, how expo-updates config is overridden per environment, and how
  the code-signing keys survive the `Expo.plist` override / AAR manifest merge.
- [architecture.md](./architecture.md) -- where the servers sit in the system.
- [version-skew.md](./version-skew.md) -- what happens when the JS bundle and
  the host binary are at different versions: current freeze/fail-open
  behavior, code-signing certificate rotation, and the (design-only)
  conditional-fallback and update-required strategies.
