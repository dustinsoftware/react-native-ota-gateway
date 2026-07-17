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
| Manifest generator | `scripts/generate-update-manifest.mjs` | Turns the native export's `metadata.json` into `dist/server/update-manifest.json`; copies bundle + assets into `dist/client/`. |
| Manifest route | `src/app/api/v2/updates/manifest+api.ts` | `expo-router` `+api.ts` route that serves the Protocol v1 manifest per request. |
| Static mount | `server/index.ts` | `express.static` on `/api/v2/updates/static` (1-year `immutable`; safe via `?h=` busters). |
| Launch gate | `src/components/ota-gate.tsx` + `src/utils/attempt-ota-update.ts` | Blocks first render while an update is fetched, per the embedded/stale/fresh policy. |
| Reload | `src/utils/reload-app.ts` | Bridge reload under a brownfield host; `Updates.reloadAsync()` standalone. |

## The manifest route

`src/app/api/v2/updates/manifest+api.ts` implements the Protocol v1 handshake.
On `GET` it reads the request headers `expo-platform`, `expo-runtime-version`,
`expo-protocol-version`, then:

- `expo-platform` not `ios`/`android` -> **400** (`Unsupported platform`).
- `expo-protocol-version` not `1` -> **406** (`Unsupported protocol version`).
- No `dist/server/update-manifest.json` on disk -> **204** (no update; normal on
  first deploy).
- Stored `runtimeVersion` != the client's `expo-runtime-version` -> **204** (the
  client's native runtime is incompatible with this bundle).
- No manifest for the requested platform -> **204**.
- Otherwise -> **200** `multipart/mixed` with the manifest part
  (`Content-Disposition: form-data; name="manifest"`), boundary
  `expo-update-response`, and the protocol response headers
  (`expo-protocol-version: 1`, `expo-sfv-version: 0`,
  `cache-control: private, max-age=0`).

## Single build, two environments

The core design constraint: **one exported build serves both environments**. The
dev server (`:3000`) and prod server (`:3001`) read the *same* `dist/`. Baking a
concrete gateway host at export time would make an export correct for only one
environment. Two mechanisms keep one build correct for both.

### 1. Placeholder stamping at request time

`generate-update-manifest.mjs` never resolves a concrete host. Everywhere a base
URL appears -- launch-asset URL, every asset URL, `updates.url`, and
`extra.gatewayUrl` in the embedded expo config -- it stamps the placeholder
token `__OTA_GATEWAY_BASE_URL__`. It also bakes, into
`dist/server/update-manifest.json`, the placeholder plus the full
`gatewayUrls` map (`{ development: http://localhost:3000, production:
http://localhost:3001 }`, from `app.json`).

At request time the manifest route resolves the base from `OTA_ENVIRONMENT`
(`production` -> the prod host, anything else -> dev; the same strict
`=== 'production'` polarity used server-side) and replaces **every** occurrence
of the placeholder before responding. A bundle applied via OTA therefore talks
to the same environment that served it.

If a manifest carries the placeholder but no gateway resolves for the running
environment, the route logs and **withholds the update (204)** rather than hand
out a broken host. The export itself fails if `gatewayUrls` is missing either
environment, so a placeholder is never shipped that can never resolve.

`OTA_GATEWAY_URL` (build-time) remains an escape hatch for one-off exports pinned
to a concrete host: it omits the placeholder, and the route then serves the
manifest verbatim.

### 2. Per-environment update-id derivation

The **baked** update id identifies bundle *content*, so both environments would
otherwise serve the *same* id with *different* gateway URLs. **expo-updates
treats update ids as globally unique.** A client that cached an update while
pointed at one environment and then receives the same id from the other logs
"this is a server error", rewrites the stored update's scope key, and relaunches
the **cached** manifest -- so the embedded config (including the gateway URL)
never follows a host-environment switch.

To prevent that, the route re-derives the served id per environment:

```
deriveEnvironmentUpdateId(bakedId, base) =
    SHA-256( bakedId + "\n" + resolvedGatewayBase )  -> first 128 bits -> UUID
```

Deterministic per `(build, environment)`, and the two environments can never
share one id. Assets are still deduplicated client-side by content hash, so
re-pointing to the other environment only inserts a new update row on the device
-- it does **not** re-download the bundle.

The baked id itself is `hashToUUID(bundleContentHash)` in the generator:
same bundle content always yields the same baked id (avoids needless
re-downloads); the route derives from it.

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
standalone and brownfield modes. Its policy, based on how long since the last
applied update (a 24h window tracked in `ota-timestamp.ts`):

1. **Embedded launch** (first install, no cached OTA yet): block rendering,
   download the latest bundle, reload.
2. **Stale launch** (last update > 24h ago): block rendering, check for an
   update, apply if available.
3. **Fresh launch** (last update < 24h ago): render immediately; the native
   `checkAutomatically` policy handles background updates.

`attempt-ota-update.ts` performs the check/fetch and then calls the reload
helper. `ota-app-version.ts` exposes the human-readable build identifier for the
diagnostics screen (read from `Updates.manifest.extra.otaAppVersion`).

## `useEmbeddedUpdate: false` (must stay false)

`app.json`'s `updates` block sets `useEmbeddedUpdate: false`. Keep it false.
Setting it `true` makes `Updates.isEmbeddedLaunch` true on every launch, so
`OtaGate` treats every launch as an embedded launch and auto-reloads -- which,
in a brownfield host, fires the crashing reload path (see below) before the
host-message reload can help.

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
  the runtime host-environment seam that decides which gateway the app's own
  requests use.
- [brownfield.md](./brownfield.md) -- how the host rebuilds the RN root on a
  reload message, and how expo-updates config is overridden per environment.
- [architecture.md](./architecture.md) -- where the servers sit in the system.
