# Configuration & Environment Model

This demo has two distinct notions of "environment", and keeping them apart is
the whole point of the dual-gateway seam.

- **`OTA_ENVIRONMENT`** -- a **build-time** selector that picks which gateway the
  build defaults to and which gateway a running server instance advertises.
- **The runtime host-environment seam** -- how a *brownfield host* tells the
  running app, before React Native boots, which environment it is pointed at.
  This overrides the baked default.

There are no real secrets in this demo (no APIM key, no CMS token), so the
`.env`-file machinery of a production hybrid app is intentionally absent. The two
gateways are local ports.

## The gateway map

The single source of truth is `app.json` under `extra.gatewayUrls`:

| Environment | Gateway host |
| --- | --- |
| development | `http://localhost:3000` |
| production | `http://localhost:3001` |

The manifest and any BFF routes are served under `<gateway>/api/v2/`.

## `OTA_ENVIRONMENT` (build-time)

`app.config.ts` reads `OTA_ENVIRONMENT` to select the build-time default gateway.

**Polarity: fail toward production.** Only an explicit
`OTA_ENVIRONMENT=development` bakes the dev gateway; anything else (unset,
`production`, a typo) bakes production. This is the deliberate *opposite* of the
server-side strict `=== 'production'` checks: a misconfigured **server** should
degrade to dev / withhold, but a misbaked **client** pointing real users at dev
is an outage, so the client fails toward production.

`app.config.ts` writes:

- **`updates.url`** = `<selected gateway>/api/v2/updates/manifest` -> baked into
  the native projects by `expo prebuild` (iOS `Expo.plist` `EXUpdatesURL`,
  Android `EXPO_UPDATE_URL`).
- **`extra.gatewayUrl`** (the selected host) -> the standalone fallback for the
  runtime resolution below.
- **`extra.updatesUrls`** (**both** environments' manifest URLs, derived from
  `extra.gatewayUrls`) -> consumed at prebuild by
  `plugins/withBrownfieldUpdates.js` to write the per-environment plist keys /
  Kotlin enum.

Independently of `app.config.ts`, `app.json`'s static `updates` block carries the
**code-signing** config (`codeSigningCertificate: "./certs/certificate.pem"`,
`codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" }`). `expo prebuild`
bakes it into iOS `Expo.plist` (`EXUpdatesCodeSigningCertificate` /
`EXUpdatesCodeSigningMetadata`) and the Android manifest meta-data
(`expo.modules.updates.CODE_SIGNING_CERTIFICATE` /
`...CODE_SIGNING_METADATA`), so every host verifies manifest signatures against
the certificate it shipped with. See [ota-updates.md](./ota-updates.md#code-signing).

| Variable | Effect |
| --- | --- |
| `OTA_ENVIRONMENT` | `development` -> the dev gateway; anything else (incl. unset / `production`) -> production. |
| `OTA_GATEWAY_URL` | Explicit gateway base URL for the build-selected default (`updates.url` + `extra.gatewayUrl`); trailing slash trimmed. Does **not** change `extra.updatesUrls` -- the runtime-selectable endpoints always come from `app.json`. An escape hatch for pinning a one-off export to a concrete host. |

**Framework releases always bake production.** `scripts/package-ios.sh` exports
`OTA_ENVIRONMENT=production` (and unsets `OTA_GATEWAY_URL`), and the Android
publish sets it inline, so the brownfield artifacts' embedded bundles can never
carry a dev gateway regardless of the caller's shell. Dev traffic in the host
apps is selected at runtime (below), never by the bake.

## The runtime host-environment seam

The brownfield host apps have their own environment selector in native Host
Settings (opened from the Developer tab), so the app must resolve its gateway
from the *live host selection*, not from whatever was baked or OTA-cached.

`modules/host-environment` is a small native module. Its native side is written
by the two config-plugin entry points (`initializeUpdates(environment:)` on iOS,
`ReactNativeHostManager.initialize(app, env)` on Android), which publish the
host's environment **before React Native boots**. `src/api/gateway-url.ts` then
resolves the BFF/gateway base with this precedence:

1. **Host-selected environment** (brownfield) -- authoritative. The host stashed
   `development` | `production` in `modules/host-environment`; the app resolves it
   against `extra.gatewayUrls`. This must win because the single-valued
   `extra.gatewayUrl` is whatever environment the bundle was exported for, and on
   OTA launches it is the *cached manifest's* value -- both wrong across a host
   environment switch.
2. **Build-selected bake** (`extra.gatewayUrl`) -- used when no host environment
   is published (standalone native builds).
3. **Production, never dev** -- a build that reaches the last resort is
   misconfigured, and a misconfigured build must land on production.

## Where each value lives

| Value | Location | Set by |
| --- | --- | --- |
| Gateway map (`{dev, prod}`) | `app.json` `extra.gatewayUrls` | Source of truth |
| Baked default gateway | `app.json`/prebuild: `updates.url`, `extra.gatewayUrl` | `app.config.ts` from `OTA_ENVIRONMENT` / `OTA_GATEWAY_URL` |
| Both env manifest URLs (iOS) | `Expo.plist`: `OtaUpdatesURLDevelopment`, `OtaUpdatesURLProduction` (+ default `EXUpdatesURL`) | `plugins/withBrownfieldUpdates.js` |
| Both env manifest URLs (Android) | generated `ReactNativeHostManager.kt`: `OtaUpdatesEnvironment` enum | `plugins/withBrownfieldUpdates.js` |
| Code-signing keypair + cert | `apps/mobile/certs/` (`private-key.pem`, `certificate.pem`; gitignored) | `scripts/generate-code-signing-keys.mjs` |
| Baked verify cert (iOS) | `Expo.plist`: `EXUpdatesCodeSigningCertificate`, `EXUpdatesCodeSigningMetadata` | `expo prebuild` from `app.json` `updates` |
| Baked verify cert (Android) | manifest meta-data: `expo.modules.updates.CODE_SIGNING_CERTIFICATE`, `...CODE_SIGNING_METADATA` | `expo prebuild` from `app.json` `updates` |
| Live host environment | `modules/host-environment` (native -> JS) | Host, via the plugin-injected init entry point |
| Runtime gateway resolution | `src/api/gateway-url.ts` | Reads host env first, then bake, then prod |

## Code-signing keys

The OTA manifest is signed so hosts can prove it was authored by whoever holds
the private key, not merely that its asset hashes are self-consistent (the threat
model is in [ota-updates.md](./ota-updates.md#code-signing)). The keys are a
**required, per-clone** setup step, not a secret shared through this repo:

- `scripts/generate-code-signing-keys.mjs` generates an RSA keypair + self-signed
  certificate into `apps/mobile/certs/` (`private-key.pem`, `certificate.pem`).
  Run it **once after cloning**.
- **Both files are gitignored.** This is a public template with no shared key, so
  every clone signs with its own pair; a host only ever verifies against the
  certificate baked into *its own* build.
- `private-key.pem` signs manifests at export time and must never leave the
  export machine (dev box / CI). `certificate.pem` is baked into the binary at
  prebuild and does the on-device verification.
- keyid is `main`, algorithm is `rsa-v1_5-sha256`.
- **Export and prebuild fail loudly** -- pointing at the setup script -- when the
  key material is missing. There is no unsigned mode.

## Server environment variables

The demo backend (`apps/mobile/server`) reads exactly two:

| Variable | Purpose |
| --- | --- |
| `PORT` | Which port the instance listens on. `server:dev` sets `3000`, `server:prod` sets `3001`; the Docker `gateway-dev`/`gateway-prod` services (the required Mode B serving) set the same values in `docker-compose.yml`. |
| `OTA_ENVIRONMENT` | Which pre-signed manifest variant the route serves (and thus which gateway host and update id the client sees). `production` -> the prod variant; anything else -> dev (strict `=== 'production'`). `server:prod` sets `production`; `server:dev` leaves it unset/`development`. |

Both instances read the **same** `dist/` export. `OTA_ENVIRONMENT` is the only
difference between them, and flipping it flips which pre-signed variant is served
-- and therefore both the gateway host baked into the manifest **and** the update
id (each derived and signed at export time) -- which is exactly the seam this
demo exists to prove. The manifest store is read per request, so re-exporting
needs no server restart. The server leaves the listen host unspecified so Node
uses a dual-stack socket where available; this is required because iOS Simulator
resolves `localhost` to `::1`, while Android port reversal and physical-device
access use IPv4.

## Runtime gateway resolution for the OTA manifest

This is the server-side half of "one build serves both environments", covered in
full in [ota-updates.md](./ota-updates.md):

- **Build.** `scripts/generate-update-manifest.mjs` stamps the placeholder
  `__OTA_GATEWAY_BASE_URL__` everywhere a base URL appears, then materializes both
  environment variants (placeholder replaced, per-environment update id derived --
  SHA-256 of the baked id + resolved base -> UUID) and **signs each variant** with
  the private key into `dist/server/update-manifest.json` (storeVersion 3).
  `OTA_ENVIRONMENT` has no effect at this step.
- **Serve.** `src/app/api/v2/updates/manifest+api.ts` resolves the environment
  from `OTA_ENVIRONMENT` per request, selects that pre-signed variant, and serves
  its stored bytes verbatim with the matching `expo-signature` header. No
  placeholder swap or id derivation happens at serve time. No variant resolves ->
  the update is withheld (204) rather than served broken.

## Related docs

- [ota-updates.md](./ota-updates.md) -- placeholder stamping, per-env id
  derivation, export-time code signing, the manifest route in detail.
- [brownfield.md](./brownfield.md) -- how the host publishes its environment and
  how the plugin wires the per-environment update URLs.
- [architecture.md](./architecture.md) -- the two-server topology.
