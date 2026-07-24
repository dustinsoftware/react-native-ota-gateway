# Architecture

This repository is a pnpm monorepo that demonstrates a self-hosted Expo OTA
stack and a Callstack brownfield integration end to end. It is deliberately
small: one Expo app, one demo backend (the app's own server), and two minimal
native host apps.

## Monorepo layout

```
react-native-ota-gateway/
|- pnpm-workspace.yaml        # workspaces apps/*, packages/*; nodeLinker: hoisted (RN autolinking)
|- package.json               # root orchestration scripts (export, server:dev, server:prod, ...)
|- docker-compose.yml         # standalone gateway containers -- REQUIRED serving for Mode B (dev :3000, prod :3001)
|- README.md, .gitignore      # ignores generated ios/, android/, dist/, hosts/ios/*.xcodeproj
|- docs/                      # canonical reference (this folder)
|- apps/
|  \- mobile/                 # @ota-gateway/mobile -- the Expo app (the whole product)
|     |- app.json             # Expo config (slug ota-gateway-app, plugins, updates block)
|     |- app.config.ts        # OTA_* env vars, fail-toward-production polarity
|     |- src/                 # routes (expo-router), brownfield entry, OTA JS, api client
|     |- server/              # Express + expo-server adapter (standalone web + manifest)
|     |- modules/host-environment/   # native module: host publishes its env before RN boot
|     |- plugins/             # withBrownfieldUpdates.js, withBrownfieldAndroidPublishing.js
|     |- patches/             # 2 Android patches applied to the generated android/ tree
|     \- scripts/             # prebuild, export-web, generate-update-manifest, package-ios.sh
\- hosts/
   |- ios/                    # Swift host app, XcodeGen (project.yml checked in) -- not a pnpm package
   \- android/                # Kotlin host app, standalone Gradle -- not a pnpm package
```

`apps/mobile` is the only pnpm package (`@ota-gateway/mobile`). The two hosts are
native projects that *consume* the artifacts the app produces; they are not part
of the JS workspace.

## The dual-target model

One source tree produces every target. There is no stripped-down "brownfield
variant" of the app -- the same `_layout.tsx`, routes, providers, and components
serve all of them.

```
                       apps/mobile (one Expo/RN tree)
                                   |
        +--------------------------+---------------------------+
        |                          |                           |
   standalone web            standalone native            brownfield artifacts
   (expo export web +        (expo run:ios /              (XCFramework + AAR that
    Express server)           run:android)                a native host embeds)
```

- **Standalone web** is served by `apps/mobile/server` (Express +
  `expo-server/adapter/express`). That server is *also* the OTA backend: the
  Expo Updates manifest is an `expo-router` `+api.ts` route
  (`src/app/api/v2/updates/manifest+api.ts`), so the demo backend and the
  standalone web host are the same process. Visiting a server instance in a
  browser demonstrates standalone web.
- **Standalone native** boots the app directly, with `expo-updates` enabled, so
  `reload-app.ts` uses `Updates.reloadAsync()` on this path.
- **Brownfield artifacts** are built by the packaging pipeline (see
  [brownfield.md](./brownfield.md)). A native host registers the RN module
  `OtaGatewayApp` and renders any route by passing an `initialUrl` prop. The
  demo hosts own a four-item native tab bar (Developer, Sky, Spinner, More) and
  mount at most one RN surface at a time (the native More tab mounts none; its
  Test rows push RN/native screens instead). Selecting a native tab replaces that
  surface with the selected route while the shared RN runtime stays initialized.

The brownfield entry (`src/brownfield/entry.tsx`) is an *addition*: it registers
`OtaGatewayApp` for the native host while `registerRootComponent` still registers
the standalone/web `main` key. Adding a new brownfield screen is a native-side
change only (pass a different URL); no RN code changes.

## Who talks to whom

```
                      +---------------------------------------+
                      |            apps/mobile (RN)           |
                      |  routes, OtaGate, api/gateway-url.ts  |
                      +-------------------+-------------------+
                                          |
              OTA manifest + static assets|  BFF/api routes (this demo has few)
                          (Expo Updates)  |
             +----------------------------+----------------------------+
             |                                                         |
   +---------v---------+                                    +----------v--------+
   | server (dev)      |   same exported dist/, different   | server (prod)     |
   | OTA_ENVIRONMENT   |   OTA_ENVIRONMENT per instance     | OTA_ENVIRONMENT   |
   | = development     |                                    | = production      |
   | http://localhost  |                                    | http://localhost  |
   |        :3000      |                                    |        :3001      |
   +---------+---------+                                    +----------+--------+
             |                                                         |
             |  Mode B: embedded/OTA JS bundle          Mode A: Metro (:8081)
             |                                                         |
   +---------v-----------------------------+   +-------------------v---------------+
   | hosts/android (Kotlin)                |   | hosts/ios (Swift)                 |
   | embeds otagatewaylib AAR              |   | embeds OtaGatewayLib.xcframework  |
   | native tabs + one RN surface          |   | native tabs + one RN surface      |
   +---------------------------------------+   +-----------------------------------+
```

The native tab selection is the navigation state being demonstrated. The RN
tab bar is hidden in brownfield mode, and the host passes `/developer`, `/sky`,
or `/spinner` when it creates the one active surface. Route-local RN state is
discarded on a native tab change unless a component opts into the host-state
seam, which round-trips its state through the host's native store (the fidget
spinner's coast and the Test 1 counter survive tab changes and process death;
see [brownfield.md](./brownfield.md)). RN screens can also navigate INTO
native screens over the message bridge (the navigate seam, same doc).
Host-only environment, Metro, and relaunch controls live behind the Developer
tab's native Settings action.

Both server instances read the **same** `dist/` export. The only difference is
`OTA_ENVIRONMENT`, which flips (a) the gateway host stamped into the served
manifest and (b) the per-environment update id. See
[configuration.md](./configuration.md) and [ota-updates.md](./ota-updates.md).

## Mode A / Mode B

The brownfield RN runs in a host one of two ways. Know which you are in.

| | Mode A -- local hot reload (dev) | Mode B -- release artifact (OTA) |
| --- | --- | --- |
| JS source | Local Metro dev server (`localhost:8081`) | OTA manifest / bundle embedded in the artifact |
| Use for | Iterating on RN/JS with Fast Refresh | Verifying the shippable artifact + OTA behavior |
| Metro running? | Required (`pnpm --filter @ota-gateway/mobile start`) | Not needed |
| Edits appear | Instantly (Fast Refresh) | Only after rebuilding / republishing the artifact |

### Per-platform mechanism (they differ)

| Platform | Mode A mechanism | Mode B mechanism |
| --- | --- | --- |
| **iOS** | **Debug-built framework** -- `./scripts/package-ios.sh --configuration Debug`. expo-updates is disabled in a Debug build, so a `bundleURLOverride` (injected under `#if DEBUG`) points at Metro. **There is no runtime Metro toggle on iOS**: a Release framework's enabled expo-updates owns the bundle URL and always wins, so you switch modes by rebuilding the framework. | Release-built framework; expo-updates enabled; JS from the OTA manifest / embedded bundle. |
| **Android** | **Runtime toggle** -- a "Use Metro dev server" pref in native Host Settings (opened from Developer). When on, the host inits RN via a dev host manager (`useDevSupport = true`); no framework rebuild needed. | Release AAR (or the toggle off); JS from OTA / embedded bundle. |

Why the asymmetry: on iOS an enabled expo-updates controller resolves the bundle
URL during startup and beats any host-set override, and it can only be Disabled
in a Debug build (compile-time), so the mode is a build-time property. Android's
bundle resolution honors `useDevSupport` at runtime, so a toggle works. This is
covered in detail under [development-workflow.md](./development-workflow.md).

## Related docs

- [ota-updates.md](./ota-updates.md) -- the OTA protocol implementation.
- [brownfield.md](./brownfield.md) -- packaging and host integration.
- [configuration.md](./configuration.md) -- the environment model.
- [development-workflow.md](./development-workflow.md) -- how to run it all.
