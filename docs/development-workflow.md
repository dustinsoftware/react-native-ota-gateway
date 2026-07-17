# Development Workflow

How to build, run, and verify the whole stack. All JS commands run from the repo
root with `pnpm`; native builds run from the host directories.

## Prerequisites

| Tool | Why | Notes |
| --- | --- | --- |
| Node (LTS) | Runs the app, server, and scripts | Uses built-ins (`process.loadEnvFile`, `node:crypto`); no `dotenv`. |
| pnpm | Workspace package manager | `nodeLinker: hoisted` in `pnpm-workspace.yaml` (RN autolinking needs a hoisted layout). |
| ccache | Caches C/C++/ObjC across iOS builds | RN builds from source; cold builds are slow. `brew install ccache`. |
| XcodeGen | Generates the iOS host `.xcodeproj` from `project.yml` | `brew install xcodegen`. |
| Xcode + command-line tools | iOS packaging + host build | Simulator by default; ad-hoc signed (identity `-`, no certificates needed). Do **not** pass `CODE_SIGNING_ALLOWED=NO` for a host you intend to run -- an unsigned host breaks keychain/SecureStore. Device and App Store builds are per-build overrides (see [brownfield.md](./brownfield.md), "Running on a physical device"). |
| JDK 17 | Android build | The host mirrors the generated project's toolchain. |
| Android SDK (compileSdk 36, an emulator) | Android host build + run | Gradle 8.14.4, minSdk 24. |

### First-time setup: code-signing keys

Before the **first export or prebuild**, generate the OTA code-signing keys:

```
cd apps/mobile && node scripts/generate-code-signing-keys.mjs
```

This writes `apps/mobile/certs/private-key.pem` + `certificate.pem` (both
gitignored -- every clone makes its own pair; there is no shared key). The
manifest generator signs each export with the private key and prebuild bakes the
certificate into the hosts, so **export and prebuild fail loudly** until the keys
exist. Run it once per clone; see [ota-updates.md](./ota-updates.md#code-signing)
and [configuration.md](./configuration.md#code-signing-keys).

## Root scripts

- `pnpm --filter @ota-gateway/mobile start` -- Metro dev server (`:8081`).
- `pnpm --filter @ota-gateway/mobile export` -- export all platforms (via
  `scripts/export-web.mjs`) and generate the OTA manifest. Also the step that
  publishes a new update for the OTA delivery proof. **Never run
  `npx expo export` directly** -- Metro never exits after bundling, so it hangs;
  `export-web.mjs` watches for the completion marker and kills the process.
- `pnpm server:dev` -- run the server with `PORT=3000`, development.
  **Standalone-web iteration only; never for Shipping-mode testing** (see below).
- `pnpm server:prod` -- run the server with `PORT=3001`, production.
  Same restriction.
- `pnpm typecheck` -- `tsc --noEmit` over `apps/mobile`.
- `pnpm test` -- the Vitest unit suites (`vitest run`). Both root scripts
  delegate to `@ota-gateway/mobile`; the same two commands are the CI merge gate
  (`.github/workflows/ci.yml`). A second, **manual-only** workflow
  (`.github/workflows/ios-framework-verify.yml`, `workflow_dispatch`) packages
  the Release iOS frameworks on a macOS runner and runs the App Store
  versioning gate -- dispatch it before merging a packaging-affecting change
  (see [brownfield.md](./brownfield.md)); it never runs automatically because
  an RN-from-source iOS build takes 1-2 hours of runner time.

The unit suites cover the config plugins' pure transforms (run against the real
`@callstack/react-native-brownfield` templates in `node_modules`), the manifest
API route, `generate-update-manifest.mjs`, the server's static-mount topology,
`app.config` gateway resolution and iOS `MARKETING_VERSION` stamping, the App
Store versioning gate script (macOS-only; skipped on the Linux CI runner), the
brownfield bridge/runtime, the host-state store client (including the
secret/size checkpoint guards), the OTA journey lock, the spinner physics
helpers, and a drift guard that pins the cross-layer coupling constants
(plugin constants vs `app.json` vs the native host sources, the Android AAR
coordinate, the message-contract literals, and every Maestro id selector).

Both server instances run `tsx server/index.ts` from `apps/mobile` (so
`process.cwd()` is `apps/mobile`, where the manifest route reads
`dist/server/update-manifest.json`). They read the same `dist/`; only
`OTA_ENVIRONMENT` differs. See [configuration.md](./configuration.md).

> The root `server:*` scripts delegate with `pnpm --filter @ota-gateway/mobile
> **run** server`. The explicit `run` is required: `server` is also a pnpm
> built-in subcommand, so `pnpm --filter ... server` (no `run`) fails with
> `Unknown option: 'recursive'` instead of invoking the package script.

## Shipping-mode serving: the Docker gateway containers

**Shipping-mode testing must be served from the standalone Docker containers,
never from host-run dev servers.** The container is a release artifact -- a baked
`dist/` export behind `server/index.ts` with only the server runtime installed
(express / expo-server / tsx; no RN or Expo dev tree) -- so what the host app
receives is exactly what production serving looks like. Metro mode always uses
the Expo/Metro dev server (`pnpm --filter @ota-gateway/mobile start`); the
host-run `pnpm server:*` scripts remain only for quick standalone-web
iteration in a browser.

```
pnpm --filter @ota-gateway/mobile export   # produce dist/ first
docker compose up --build -d               # gateway-dev :3000, gateway-prod :3001
docker compose down                        # stop
```

Defined by the root `docker-compose.yml` building `apps/mobile/Dockerfile`.
Because `dist/` is baked into the image, **every re-export requires
`docker compose up --build`** -- the running containers do not see host-side
exports (that staleness is deliberate; it is what makes the artifact
trustworthy). Each container exposes `/healthz`; `docker ps` shows
`(healthy)` when serving. Ports/environments match the old host-run layout
(`:3000` development, `:3001` production), so the app-side configuration is
unchanged.

## Networking

The iOS simulator reaches `http://localhost:3000` / `:3001` / `:8081` directly.
The Android emulator does not; reverse the ports:

```
adb reverse tcp:3000 tcp:3000
adb reverse tcp:3001 tcp:3001
adb reverse tcp:8081 tcp:8081
```

Do this on the **emulator too**, not just physical devices. Without the `:8081`
reverse in Metro mode the bundle may load (RN dev support special-cases the emulator)
but the app's own `localhost` requests die; without `:3000`/`:3001` OTA against
the local servers fails. Cleartext must be permitted (iOS
`NSAllowsLocalNetworking`, Android `network_security_config.xml`; see
[brownfield.md](./brownfield.md)).

### Port collisions (known footgun)

Metro on `:8081` must serve **this** tree. Before starting anything, check:

```
lsof -i :8081 -i :3000 -i :3001
```

Only start Metro from `apps/mobile`. A stray Metro from another checkout serving
`:8081` will silently feed the host the wrong bundle.

> The per-platform procedures below are also packaged as the `/verify-ios` and
> `/verify-android` Claude Code skills (`.claude/skills/`), which restate this
> section as an operational checklist. This doc is canonical for the procedures
> (the definitions live in [architecture.md](./architecture.md#runtime-modes-and-artifact-source));
> keep the skills in sync if the flow changes.

## The two axes

How the brownfield RN runs is decided by two independent axes -- **runtime mode**
(`Metro mode` / `Shipping mode`) and **artifact source** (`prebuilt` /
`source build`). [architecture.md](./architecture.md#runtime-modes-and-artifact-source)
defines them and owns the per-platform matrix; this doc covers the procedures.

The everyday loop is Metro mode on a prebuilt asset; packaging is validated as
Shipping mode on a source build. Switching runtime modes needs no React Native
compile **as long as the variant you want is installable** -- both release assets
are, and a `package-ios.sh` run leaves the Debug variant in the `build-debug/`
mirror. The one asymmetry: there is no `build-release/` mirror, so returning to
Shipping mode from a local Debug build means either installing the release asset
(`pnpm install:ios`) or rebuilding Release. During work on an unreleased version
bump, where no matching release exists, that rebuild is the only route.

## Metro mode -- local hot reload (JS from Metro)

Iterate on RN/JS with Fast Refresh, no per-change artifact rebuild. Start Metro
first: `pnpm --filter @ota-gateway/mobile start`.

### Android (runtime toggle -- no framework rebuild)

1. On the Developer tab, open native Settings, enable **"Use Metro dev
   server"**, then relaunch.
   This inits RN via `ReactNativeDevHostManager` (`useDevSupport = true`).
2. `adb reverse tcp:8081 tcp:8081`.
3. Edit JS -> Fast Refresh applies instantly. The toggle persists in prefs;
   default off, so a normal build always uses the OTA/embedded bundle.

### iOS (install Debug-built frameworks -- no React Native compile)

No runtime Metro toggle exists on iOS (a Release framework's enabled expo-updates
owns the bundle URL and always beats a host override; it can only be Disabled in
a Debug build), so Metro mode means installing Debug-built frameworks into
`apps/mobile/ios/.brownfield/package/build/` -- the one tree the host links and
embeds (`hosts/ios/project.yml`). Every published release carries a prebuilt
Debug asset (`ota-gateway-ios-frameworks-<tag>-debug.zip`), so this is normally a
**download**, never a recompile:

1. Install the Debug frameworks with `scripts/install-ios-frameworks.mjs`:
   - `pnpm install:ios --debug` -- download the pinned release's Debug asset.
   - `pnpm install:ios --local --debug` -- install the `build-debug/` mirror a
     previous `package-ios.sh` run left behind (`--configuration Debug` or the
     `Both` default). This is how you get back into Metro mode after a release
     cut **without rebuilding the frameworks**.
   - A source build is only needed when your RN change touches NATIVE code the
     pinned artifact lacks, or the release predates the Debug asset:
     `cd apps/mobile && ./scripts/package-ios.sh --configuration Debug` (which
     leaves the Debug output in both `build/` and the `build-debug/` mirror).
2. Rebuild the host against the Debug artifacts (frameworks are embedded at build
   time -- swapping files without rebuilding the host changes nothing). Give each
   variant **its own** derived-data path:

   ```
   cd hosts/ios && xcodegen && xcodebuild -project OtaHost.xcodeproj \
     -scheme OtaHost -sdk iphonesimulator -configuration Release \
     -derivedDataPath build-metro build
   ```

   Reusing a path last built against the other variant fails with `missing
   required module 'SwiftOnoneSupport'` (an unoptimized `.swiftmodule` left in the
   explicit-module cache). Deleting `hosts/ios/build*` works too; separate paths
   just make the swap free. `hosts/ios/build*` is gitignored.
3. On the simulator with Metro on the default port, nothing else to configure.
   For a non-default port or a physical device, set the packager host via the RN
   dev menu ("Configure Bundler"); the override honors an explicit
   `RCT_jsLocation`.

Once the Debug frameworks are installed, JS Fast-Refreshes on save. To return to
Shipping mode: `pnpm install:ios` (the release's Release asset) or
`./scripts/package-ios.sh --configuration Release`, then rebuild the host.

## Shipping mode -- release artifact (JS from OTA / embedded)

The default state; mirrors what ships. expo-updates is enabled; JS comes from the
OTA manifest or the embedded bundle, not Metro. Use it to verify the real
artifact and the OTA flow.

- **iOS:** `pnpm install:ios` installs the pinned release's Release frameworks;
  or `./scripts/package-ios.sh --configuration Release` builds them locally
  (a bare `package-ios.sh` builds both configurations and leaves Release in
  `build/`). Then rebuild + reinstall the host. Metro need not run.
- **Android:** the host build with the Metro toggle **off** (the default). Metro
  not required. Note `adb install -r` preserves prefs -- only an uninstall clears
  the toggle.

Switching Metro mode <-> Shipping mode is just swapping which framework/toggle is
active (install the other variant + rebuild the host on iOS; flip the toggle on
Android) -- no app code changes and no React Native compile.

## Artifact source: prebuilt vs source build

A source build is the second axis, not a third mode: it changes where the
artifact came from, not how JS loads. Both runtime modes normally run on the
**prebuilt** assets attached to a release; a source build compiles React Native
from source here to produce those same artifacts (cold: 30-60+ min on iOS).
Build Debug and you land in Metro mode; build Release and you land in Shipping
mode.

Reach for a source build only when:

- the RN change adds or alters **native** code or a native dependency, so the
  pinned artifact cannot contain it (Fast Refresh can never deliver that);
- the pinned release predates the asset you need (iOS releases cut before the
  Debug asset carry only the Release zip);
- you are validating the packaging pipeline itself (the App Store versioning
  gate, the release stamps) before cutting a release.

| Platform | Source build | Install it |
| --- | --- | --- |
| **iOS** | `./scripts/package-ios.sh` (Debug then Release), or `--configuration Debug` / `Release` for one | Release already sits in `build/` where the host reads it; `pnpm install:ios --local --debug` installs the Debug mirror |
| **Android** | from `apps/mobile`: `node scripts/prebuild.mjs --android`, then `pnpm exec brownfield publish:android --module-name otagatewaylib` (to `mavenLocal()`) | rebuild the host; Gradle resolves the local AAR |

Android's Metro toggle works against a released AAR too, so a source build there
is for native changes or packaging validation -- never just to get hot reload.

The hosts have a Maestro suite covering the mix-and-match matrix (see
[brownfield.md](./brownfield.md)); run it as part of Shipping-mode verification
(`maestro test <flow>`; pass `--device <udid>` when both a simulator and an
emulator are connected). **Order matters after a fresh export**: expo-updates
downloads the new bundle in the background on the first launch and applies it
on the second, so the SELF-WARMING flows (which launch/settle/relaunch) must
run before the ones marked `no self-warm cycle`:

1. `verify-more-tab-{ios,android}.yaml` -- self-warming; pushed RN/native
   screens, persisted counter, RN->native Settings, double-visit back, 3x
   tab-cycle stress.
2. `verify-spinner-persistence-{ios,android}.yaml` -- self-warming; spin ->
   tab roundtrip resumes -> process death resumes.
3. `verify-spinner-survives-push-{ios,android}.yaml` -- spinner coast survives
   a pushed-screen detour (independent state slices).
4. `verify-double-tap-{ios,android}.yaml` -- menu-row double taps open one
   screen, not two.
5. `verify-nav-restore-{ios,android}.yaml` -- a tab surface resumes its last
   in-surface path after a tab roundtrip (the nav-restore seam).
6. iOS only: `verify-reload-while-pushed-ios.yaml` -- a manual RN reload with
   a pushed RN screen on the stack pops to root and re-mounts the tab (the
   pushed surface predates the restarted runtime).
7. Android only: `./.maestro/run-rotation-android.sh` -- orchestrates
   `verify-rotation-android-part{1,2}.yaml` around an adb rotation (Maestro
   cannot rotate); the ephemeral "Session" counter is the in-place-survival
   discriminator.

The same flows drive either runtime mode -- Metro mode exercises your live edits,
Shipping mode the JS baked into / OTA'd to the artifact. They assert that the RN
screen mounted and rendered; they do **not** prove which JS source served it. Pin
that with the Metro log (Metro mode) or the expo-updates log (Shipping mode).

## The canonical runbook

End-to-end verification order:

```
0  cd apps/mobile && node scripts/generate-code-signing-keys.mjs  # once per clone, before first export/prebuild
1  pnpm install
1b pnpm typecheck && pnpm test                     # type check + Vitest unit suites (the CI gate)
2  pnpm --filter @ota-gateway/mobile export        # export-web.mjs (all platforms) + signed manifest
3  docker compose up --build -d              # gateway containers (Shipping-mode serving)
4  browser: standalone web on :3000; curl manifests on :3000/:3001 -- distinct update ids
4b standalone native spot-check: npx expo run:ios / run:android
5  cd apps/mobile && node scripts/prebuild.mjs --android
6  OTA_ENVIRONMENT=production pnpm exec brownfield publish:android --module-name otagatewaylib
7  cd hosts/android && ./gradlew :app:assembleDebug && install on emulator
8  adb reverse tcp:3000 tcp:3000; adb reverse tcp:3001 tcp:3001; adb reverse tcp:8081 tcp:8081
9  Android Shipping mode: check/download/reload; env toggle -> different update id
10 Android Metro mode: Metro toggle + relaunch + pnpm --filter @ota-gateway/mobile start
11 cd apps/mobile && ./scripts/package-ios.sh     # Debug then Release; Release lands in build/
12 cd hosts/ios && xcodegen && xcodebuild (simulator) && simctl install/launch
13 iOS Shipping mode: same OTA flow
14 pnpm install:ios --local --debug -> rebuild host (-derivedDataPath build-metro)
   -> iOS Metro mode (no repackage)
15 OTA proof: bump marker -> step 2 -> Check/Download/Restart -> new marker (both platforms)
```

### Manifest curl (step 4)

Protocol v1 requires three request headers. Assert distinct ids across ports:

```
curl -sD - -o /dev/null http://localhost:3000/api/v2/updates/manifest \
  -H 'expo-platform: ios' -H 'expo-runtime-version: 1' -H 'expo-protocol-version: 1'
curl -sD - -o /dev/null http://localhost:3001/api/v2/updates/manifest \
  -H 'expo-platform: ios' -H 'expo-runtime-version: 1' -H 'expo-protocol-version: 1'
```

Both should return `200 multipart/mixed`, and the manifest `id` fields **must
differ** between `:3000` and `:3001` for identical bytes (the per-environment id
seam). Each response also carries an `expo-signature` value
(`sig="<base64>", keyid="main"`) authenticating the served bytes -- on the
manifest part's headers (where the expo-updates client reads it for multipart
responses) and mirrored as an HTTP header. The launch-asset
URL should `200`, and its host should match the port that served it. A wrong
`expo-runtime-version` returns `204`; a missing/invalid `expo-platform` returns
`400`.

## OTA delivery proof

The DONE demo -- an actual JS change delivered over the air:

1. Gateway containers up; a host in Shipping mode shows `OTA marker: v1` and its
   update id.
2. Edit `src/constants/marker.ts` to `OTA marker: v2`, then
   `pnpm --filter @ota-gateway/mobile export` and
   `docker compose up --build -d` (the containers bake `dist/`, so they must be
   rebuilt to serve the new export).
3. In the app: **Check for update** -> true -> **Download** -> **Restart**. The
   Developer shows `OTA marker: v2`, `isEmbeddedLaunch false`, and a new update
   id.
4. Flip the environment and restart: the other instance serves a **different
   update id** for identical bytes (assets dedupe by content hash, so no
   re-download).
5. Repeat on both platforms.

> **Do not relaunch the host between the v1 baseline (step 1) and the manual
> Check/Download/Restart (step 3).** `app.json` sets `checkAutomatically:
> ALWAYS`, so every launch background-fetches the newest update and expo-updates
> applies it on the *next* launch. Relaunch after bumping to v2 and the app
> silently comes up on v2 on its own -- the manual buttons then just report
> `Check: false` (already latest), and you never see the v1 -> v2 transition. The
> manual **Restart** applies a fetched update via the brownfield bridge reload
> (no process relaunch), so the correct sequence is: capture v1 -> bump + export
> -> Check/Download/Restart, all without killing the app. (The env-flip in step 4
> *does* require a relaunch, which is fine -- there the goal is the re-scoped id,
> not a marker change.)
>
> Update ids are **not stable across exports of identical source**: Hermes
> bytecode is not byte-identical build to build, so each `export` yields a fresh
> bundle content hash and therefore fresh baked/derived ids (consistent with the
> content-addressed-key caveat in [ota-updates.md](./ota-updates.md)). Record the
> ids from the export you are actually serving; do not expect them to match a
> previous run.

## Per-phase verification checklist

Each implementation phase is traceable to a doc section; verify against it.

| Phase | Verify |
| --- | --- |
| Scaffold + app port | `pnpm install`; `pnpm typecheck`; `pnpm test` (all unit suites green); prebuild both platforms; grep generated Swift for `initializeUpdates` + `bundleURLOverride`, Kotlin for `OtaUpdatesEnvironment` + private `bootReactNative`, `build.gradle.kts` for `singleVariant("release")` + brotli; `Expo.plist` has both `OtaUpdatesURL*` keys and the `EXUpdatesCodeSigningCertificate` / `EXUpdatesCodeSigningMetadata` keys (Android manifest meta-data has the matching `expo.modules.updates.CODE_SIGNING_*` entries). |
| Unit tests + CI | `pnpm typecheck` and `pnpm test` pass locally and in `.github/workflows/ci.yml`; the drift-guard suite ties plugin constants, `app.json`, the native host sources, the Android AAR coordinate, and the host app id together, so a cross-layer rename fails here. Note CI is Linux-only -- it never builds either host, so nothing there covers the hosts' packaging (icons, orientations, privacy manifest). |
| Demo backend | Export -> `docker compose up --build -d` -> web loads on `:3000`/`:3001`; curl manifests (above) -- 200 multipart, ids differ, launch asset 200s, wrong runtime -> 204, missing platform -> 400. Standalone native boots via `expo run:ios`/`run:android`; standalone reload uses `Updates.reloadAsync()`. |
| Android artifact + host | assembleDebug -> install -> reverses -> Shipping mode (embedded bundle loads; check/download/restart lands); env toggle + relaunch -> different update id; Metro mode (toggle + relaunch + Metro, Fast Refresh works). |
| iOS packaging + host | xcodegen -> xcodebuild simulator (ad-hoc signed; no `CODE_SIGNING_ALLOWED=NO` on the HOST build) -> simctl install/launch -> Shipping-mode OTA flow; `pnpm install:ios --local --debug` + rebuild host -> Metro mode. |
| Host branding + App Store validation | On the built `.app`: `plutil -p Info.plist` shows `CFBundleIconName` (nested under `CFBundleIcons.CFBundlePrimaryIcon`), four `UISupportedInterfaceOrientations`, and `UILaunchScreen.UIColorName`; `PrivacyInfo.xcprivacy` exists at the bundle root and passes `plutil -lint`. An unsigned `-sdk iphoneos` build additionally surfaces the orientation warning the simulator build hides (see [brownfield.md](./brownfield.md), "App Store distribution"). On Android: `aapt2 dump badging` reports the adaptive `ic_launcher`. |
| OTA delivery proof | The marker-bump procedure above, on both platforms. |

For both native hosts, also cycle Developer -> Sky -> Spinner -> Developer and
confirm each selection replaces the one RN surface with the correct route, the
RN tab bar stays hidden, no previous route bleeds through, and no surface is
blank. Android tab changes recreate the host Activity by design; verify Back is
handled by the visible route and use "Don't keep activities" to exercise
restoration without duplicate fragments.

## Related docs

- [architecture.md](./architecture.md) -- the runtime-mode matrix and topology.
- [ota-updates.md](./ota-updates.md) -- what the manifest curl is exercising.
- [brownfield.md](./brownfield.md) -- packaging and host build details.
- [configuration.md](./configuration.md) -- `OTA_ENVIRONMENT`, ports, the seam.
