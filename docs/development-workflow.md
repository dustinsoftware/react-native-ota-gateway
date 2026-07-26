# Development Workflow

How to build, run, and verify the whole stack. All JS commands run from the repo
root with `pnpm`; native builds run from the host directories.

## Prerequisites

| Tool | Why | Notes |
| --- | --- | --- |
| Node (LTS) | Runs the app, server, and scripts | Uses built-ins (`process.loadEnvFile`, `node:crypto`); no `dotenv`. |
| pnpm | Workspace package manager | `nodeLinker: hoisted` in `pnpm-workspace.yaml` (RN autolinking needs a hoisted layout). |
| ccache | Caches C/C++/ObjC across iOS builds | RN builds from source; cold builds are slow. `brew install ccache`. |
| XcodeGen | Generates the iOS host `.xcodeproj` from `project.yml` | `brew install xcodegen`. iOS host is simulator-only. |
| Xcode + command-line tools | iOS packaging + host build | Simulator only; ad-hoc signed (identity `-`, no certificates needed). Do **not** pass `CODE_SIGNING_ALLOWED=NO` -- an unsigned host breaks keychain/SecureStore (see [brownfield.md](./brownfield.md)). |
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
  **Standalone-web iteration only; never for Mode B** (see below).
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

## Mode B serving: the Docker gateway containers

**Mode B testing must be served from the standalone Docker containers, never
from host-run dev servers.** The container is a release artifact -- a baked
`dist/` export behind `server/index.ts` with only the server runtime installed
(express / expo-server / tsx; no RN or Expo dev tree) -- so what the host app
receives is exactly what production serving looks like. Mode A always uses the
Expo/Metro dev server (`pnpm --filter @ota-gateway/mobile start`); the
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
reverse in Mode A the bundle may load (RN dev support special-cases the emulator)
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

> The per-platform Mode A/B procedures below are also packaged as the
> `/verify-ios` and `/verify-android` Claude Code skills
> (`.claude/skills/`), which restate this section as an operational checklist.
> This doc remains canonical; keep the skills in sync if the flow changes.

## Mode A -- local hot reload (JS from Metro)

Iterate on RN/JS with Fast Refresh, no per-change artifact rebuild. Start Metro
first: `pnpm --filter @ota-gateway/mobile start`.

### Android (runtime toggle -- no framework rebuild)

1. On the Developer tab, open native Settings, enable **"Use Metro dev
   server"**, then relaunch.
   This inits RN via `ReactNativeDevHostManager` (`useDevSupport = true`).
2. `adb reverse tcp:8081 tcp:8081`.
3. Edit JS -> Fast Refresh applies instantly. The toggle persists in prefs;
   default off, so a normal build always uses the OTA/embedded bundle.

### iOS (Debug-built framework -- one build per dev session)

No runtime Metro toggle exists on iOS (a Release framework's enabled expo-updates
owns the bundle URL and always beats a host override; it can only be Disabled in
a Debug build). So:

1. `cd apps/mobile && ./scripts/package-ios.sh --configuration Debug` -- disables
   expo-updates and installs the `#if DEBUG` `bundleURLOverride` -> `:8081`.
2. Rebuild the host against the Debug artifacts (frameworks are embedded at build
   time -- swapping files without rebuilding the host changes nothing).
3. On the simulator with Metro on the default port, nothing else to configure.
   For a non-default port or a physical device, set the packager host via the RN
   dev menu ("Configure Bundler"); the override honors an explicit
   `RCT_jsLocation`.

After that one build, JS Fast-Refreshes on save. To return to Mode B, repackage
Release and rebuild the host.

## Mode B -- release artifact (JS from OTA / embedded)

The default state; mirrors what ships. expo-updates is enabled; JS comes from the
OTA manifest or the embedded bundle, not Metro. Use it to verify the real
artifact and the OTA flow.

- **iOS:** `./scripts/package-ios.sh` (Release), rebuild + reinstall the host.
  Metro need not run.
- **Android:** the host build with the Metro toggle **off** (the default). Metro
  not required. Note `adb install -r` preserves prefs -- only an uninstall clears
  the toggle.

Switching Mode A <-> Mode B is just swapping which framework/toggle is active
(rebuild + reinstall on iOS; flip the toggle on Android) -- no app code changes.

The hosts have a Maestro suite covering the mix-and-match matrix (see
[brownfield.md](./brownfield.md)); run it as part of Mode B verification
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

## The canonical runbook

End-to-end verification order:

```
0  cd apps/mobile && node scripts/generate-code-signing-keys.mjs  # once per clone, before first export/prebuild
1  pnpm install
1b pnpm typecheck && pnpm test                     # type check + Vitest unit suites (the CI gate)
2  pnpm --filter @ota-gateway/mobile export        # export-web.mjs (all platforms) + signed manifest
3  docker compose up --build -d              # gateway containers (Mode B serving)
4  browser: standalone web on :3000; curl manifests on :3000/:3001 -- distinct update ids
4b standalone native spot-check: npx expo run:ios / run:android
5  cd apps/mobile && node scripts/prebuild.mjs --android
6  OTA_ENVIRONMENT=production pnpm exec brownfield publish:android --module-name otagatewaylib
7  cd hosts/android && ./gradlew :app:assembleDebug && install on emulator
8  adb reverse tcp:3000 tcp:3000; adb reverse tcp:3001 tcp:3001; adb reverse tcp:8081 tcp:8081
9  Android Mode B: check/download/reload; env toggle -> different update id
10 Android Mode A: Metro toggle + relaunch + pnpm --filter @ota-gateway/mobile start
11 cd apps/mobile && ./scripts/package-ios.sh                  # Release
12 cd hosts/ios && xcodegen && xcodebuild (simulator) && simctl install/launch
13 iOS Mode B: same OTA flow
14 ./scripts/package-ios.sh --configuration Debug -> rebuild host -> iOS Mode A
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

1. Gateway containers up; a host in Mode B shows `OTA marker: v1` and its
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
| Unit tests + CI | `pnpm typecheck` and `pnpm test` pass locally and in `.github/workflows/ci.yml`; the drift-guard suite ties plugin constants, `app.json`, the native host sources, and the Android AAR coordinate together, so a cross-layer rename fails here. |
| Demo backend | Export -> `docker compose up --build -d` -> web loads on `:3000`/`:3001`; curl manifests (above) -- 200 multipart, ids differ, launch asset 200s, wrong runtime -> 204, missing platform -> 400. Standalone native boots via `expo run:ios`/`run:android`; standalone reload uses `Updates.reloadAsync()`. |
| Android artifact + host | assembleDebug -> install -> reverses -> Mode B (embedded bundle loads; check/download/restart lands); env toggle + relaunch -> different update id; Mode A (toggle + relaunch + Metro, Fast Refresh works). |
| iOS packaging + host | xcodegen -> xcodebuild simulator (ad-hoc signed; no `CODE_SIGNING_ALLOWED=NO`) -> simctl install/launch -> Mode B OTA flow; repackage Debug -> Mode A. |
| OTA delivery proof | The marker-bump procedure above, on both platforms. |

For both native hosts, also cycle Developer -> Sky -> Spinner -> Developer and
confirm each selection replaces the one RN surface with the correct route, the
RN tab bar stays hidden, no previous route bleeds through, and no surface is
blank. Android tab changes recreate the host Activity by design; verify Back is
handled by the visible route and use "Don't keep activities" to exercise
restoration without duplicate fragments.

## Related docs

- [architecture.md](./architecture.md) -- the Mode A/B matrix and topology.
- [ota-updates.md](./ota-updates.md) -- what the manifest curl is exercising.
- [brownfield.md](./brownfield.md) -- packaging and host build details.
- [configuration.md](./configuration.md) -- `OTA_ENVIRONMENT`, ports, the seam.
