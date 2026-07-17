---
name: verify-ios
description: Verify the iOS brownfield host in both runtime modes -- Metro mode (local hot reload, JS from Metro) and Shipping mode (release artifact, JS from OTA/embedded). Use when asked to verify, test, or smoke-check the iOS app/host, run the iOS OTA flow, or switch the iOS host between Metro mode and Shipping mode.
---

# Verify iOS (Metro mode / Shipping mode)

Step-by-step verification of the iOS brownfield host. The canonical source is
`docs/development-workflow.md` (runtime-mode sections + runbook) and
`docs/brownfield.md` (iOS packaging); this skill is the operational checklist.
If a step here ever conflicts with those docs, the docs win -- and update them.

This skill verifies iOS on the **simulator**, ad-hoc signed (identity `-`; no
certificates needed). **Never pass `CODE_SIGNING_ALLOWED=NO` to xcodebuild** --
it overrides the project's ad-hoc signing, strips the keychain entitlements,
and silently breaks SecureStore persistence (the OTA gate then treats every
launch as stale; see docs/brownfield.md). Device and App Store builds are
possible via per-build overrides but are out of scope here -- see
docs/brownfield.md, "Running on a physical device".

If a previous `dev.otagateway.host` build is still installed, uninstall it once
(`xcrun simctl uninstall booted dev.otagateway.host`). The app id changed, so
the old build is a separate app with its own container -- leaving it installed
means two icons and an empty SecureStore on first launch of the new one, which
reads as an OTA staleness regression but is not.

> **Scope:** this skill verifies the **brownfield host**. The standalone web
> (`:3000` in a browser) and standalone native (`npx expo run:ios`) targets are
> separate and verified per the runbook's steps 4/4b in
> `docs/development-workflow.md`.

## The two runtime modes

| | Metro mode -- local hot reload (dev) | Shipping mode -- release artifact (OTA) |
| --- | --- | --- |
| JS source | Metro (`:8081`), Fast Refresh | OTA manifest / embedded bundle |
| Framework | Debug-built | Release-built |
| Install it with | `pnpm install:ios --debug` (release asset) or `--local --debug` (the `build-debug/` mirror) | `pnpm install:ios`, or `./scripts/package-ios.sh --configuration Release` |
| Switch cost | Install the other variant + rebuild the host. **No React Native compile** | same |
| Use it to | Iterate on RN/JS fast | Verify the real artifact + OTA delivery |

**There is no runtime Metro toggle on iOS.** A Release framework's enabled
expo-updates owns the bundle URL and always beats a host override; only a Debug
build leaves it out of the way (its `#if DEBUG` `bundleURLOverride` is what points
the runtime at Metro). So you switch modes by swapping the installed framework and
rebuilding the host, not by flipping a setting (the key iOS-vs-Android difference).
Whether that framework was downloaded (prebuilt) or built here (source build) is a
separate axis -- see `docs/development-workflow.md`.

## Preconditions (both modes)

1. `pnpm install`
2. Code-signing keys exist (`apps/mobile/certs/`): once per clone, run
   `cd apps/mobile && node scripts/generate-code-signing-keys.mjs`. Export and
   prebuild fail loudly without them (see docs/ota-updates.md, Code signing).
3. `pnpm typecheck && pnpm test` -- the CI gate; must be green first.
4. `pnpm --filter @ota-gateway/mobile export` -- exports all platforms and
   regenerates the OTA manifest. **Never run `npx expo export` directly** (Metro
   never exits and it hangs).
5. Gateway containers up: `docker compose up --build -d` (`gateway-dev` :3000 /
   `gateway-prod` :3001). **Shipping mode is served ONLY from these Docker
   containers** -- never from host-run `pnpm server:*` (those are for
   standalone-web iteration). The images bake `dist/`, so re-run with
   `--build` after every export. Metro mode always uses the Expo/Metro dev server.
6. Tooling present: `xcodegen`, Xcode CLT, `ccache` (`brew install xcodegen ccache`).
   The first `package-ios.sh` builds RN from source -- **cold builds run 30-60+
   min**; ~2-6 min with a warm ccache. It is not hung; let it finish.
7. The iOS simulator reaches `localhost:3000/:3001/:8081` directly -- no `adb
   reverse` equivalent needed. Cleartext to localhost is allowed via
   `NSAllowsLocalNetworking` in `Info.plist`.
8. Check for a stray Metro before starting one: `lsof -i :8081 -i :3000 -i :3001`.
   A Metro from another checkout on `:8081` silently feeds the host the wrong bundle.
9. `package-ios.sh` with no `--configuration` builds **both** variants (Debug,
   then Release) -- roughly double the time. Pass `--configuration Release` or
   `Debug` to build just one. It ends with an App Store versioning gate on every
   configuration, Debug included -- the packaged `OtaGatewayLib.framework` must
   carry `CFBundleShortVersionString` matching `app.json`'s `expo.version`
   (ITMS-90057 class). On a gate failure the generated `ios/` dir is stale:
   run `pnpm --filter @ota-gateway/mobile prebuild --ios` (or delete
   `apps/mobile/ios/`) and repackage. See `docs/brownfield.md` ->
   "iOS: scripts/package-ios.sh".

## Shipping mode -- release artifact + OTA flow (do this first)

This mirrors what ships; verify it before touching Metro mode.

```
xcrun simctl boot 'iPhone 16' 2>/dev/null; open -a Simulator   # ensure a simulator is booted first
cd apps/mobile && ./scripts/package-ios.sh --configuration Release   # Release framework (selects Shipping mode)
cd ../../hosts/ios && xcodegen                             # generate .xcodeproj from project.yml
xcodebuild -project OtaHost.xcodeproj -scheme OtaHost \
  -sdk iphonesimulator -configuration Release \
  -derivedDataPath build build                             # host app; framework is embedded at build time
xcrun simctl install booted build/Build/Products/Release-iphonesimulator/OtaHost.app
xcrun simctl launch booted com.regalcinemas.reactnativetest
```

Metro need not run in Shipping mode. The host **target** config (Debug/Release) is
independent of the mode -- the mode is selected by the *framework* config baked
in by `package-ios.sh`. `-derivedDataPath build` pins the `.app` output path so
`simctl install` can find it.

**Pass criteria:**
- App boots and renders the RN screen inside the native host.
- Developer shows the current `OTA marker` and an update id.
- The native Developer/Sky/Spinner/More tab bar is visible; the RN tab bar is
  hidden.
- Manifest curl returns `200 multipart/mixed` and the `:3000` vs `:3001` ids
  differ for identical bytes (see below).
- Host packaging is intact (nothing else checks this -- CI never builds the
  host). On `build/Build/Products/Release-iphonesimulator/OtaHost.app`:
  `plutil -p Info.plist` shows `CFBundleIconName` (nested under
  `CFBundleIcons.CFBundlePrimaryIcon`), four `UISupportedInterfaceOrientations`
  and `UILaunchScreen.UIColorName`; `PrivacyInfo.xcprivacy` is present at the
  bundle root and `plutil -lint` passes; the home-screen icon is the blue Expo
  icon, not the generic placeholder.
- The Maestro suite passes, in the documented order (self-warming flows first;
  see docs/development-workflow.md): `verify-more-tab-ios.yaml`,
  `verify-spinner-persistence-ios.yaml`, `verify-spinner-survives-push-ios.yaml`,
  `verify-double-tap-ios.yaml`, `verify-nav-restore-ios.yaml`,
  `verify-reload-while-pushed-ios.yaml`
  (`maestro --device <udid> test .maestro/<flow>`).

### OTA delivery proof (the DONE demo)

Do **not** relaunch the host between capturing v1 and the manual Restart --
`checkAutomatically: ALWAYS` means a relaunch auto-applies the update and you
never see the transition.

1. With a fresh launch, note `OTA marker: v1` and the update id.
2. Edit `apps/mobile/src/constants/marker.ts` to `v2`, then re-run
   `pnpm --filter @ota-gateway/mobile export` and
   `docker compose up --build -d` (containers bake `dist/`; rebuild to serve
   the new export).
3. In-app: **Check for update** -> true -> **Download** -> **Restart** (the
   brownfield bridge reload, not a process relaunch).
4. Developer now shows `OTA marker: v2`, `isEmbeddedLaunch false`, and a new id.
5. Open native Settings from Developer, flip the environment, and relaunch: the
   other instance serves a **different update id** for identical bytes (assets
   dedupe by content hash -> no re-download).

> Update ids are not stable across exports of identical source (Hermes bytecode
> isn't byte-identical build to build). Record ids from the export you are
> actually serving.

## Metro mode -- local hot reload

Install Debug-built frameworks into `apps/mobile/ios/.brownfield/package/build/`
(the only tree the host embeds) and rebuild the host against them once; after
that, JS Fast-Refreshes on save. **No React Native compile is needed** -- pick
whichever install source you already have.

```
pnpm --filter @ota-gateway/mobile start                          # Metro on :8081 (own terminal)
# Either: download the pinned release's Debug asset
pnpm install:ios --debug
# Or: install the build-debug/ mirror a previous package-ios.sh run left behind
pnpm install:ios --local --debug
# Source build (only for a native change the artifact lacks, or a release with no Debug asset):
#   cd apps/mobile && ./scripts/package-ios.sh --configuration Debug   # installs #if DEBUG bundleURLOverride -> :8081
# Own derived-data path per variant -- reusing the Shipping-mode one fails with
# "missing required module 'SwiftOnoneSupport'" (see Footguns).
cd hosts/ios && xcodegen \
  && xcodebuild -project OtaHost.xcodeproj -scheme OtaHost -sdk iphonesimulator \
       -configuration Release -derivedDataPath build-metro build
xcrun simctl install booted build-metro/Build/Products/Release-iphonesimulator/OtaHost.app \
  && xcrun simctl launch booted com.regalcinemas.reactnativetest
```

- On the simulator with Metro on the **default** port, nothing else to configure.
- Non-default port or physical device: set the packager host via the RN dev menu
  ("Configure Bundler"); the override honors an explicit `RCT_jsLocation`.
- **Pass criteria:** edit any JS under `apps/mobile/src` -> the change Fast-
  Refreshes in the running app without a rebuild.
- Rebuilding the host without repackaging changes nothing -- frameworks are
  embedded at build time.

- Confirm which variant is installed: `cat
  apps/mobile/ios/.brownfield/package/build/.install-info.json`. It is present
  only after `install:ios`, and its `variant` is authoritative -- an installed
  tree also carries a copied `.build-info.json`, which describes the build the
  frameworks came FROM, not a build that happened here. A tree with only
  `.build-info.json` is a local source build. Maestro proves the RN screen
  rendered, not which JS source served it -- the Metro log is the discriminator.

**Return to Shipping mode:** `pnpm install:ios` (the release's Release asset) --
or `./scripts/package-ios.sh --configuration Release` -- then rebuild the host.

## Manifest curl (protocol v1 requires three headers)

```
curl -sD - -o /dev/null http://localhost:3000/api/v2/updates/manifest \
  -H 'expo-platform: ios' -H 'expo-runtime-version: 1' -H 'expo-protocol-version: 1'
curl -sD - -o /dev/null http://localhost:3001/api/v2/updates/manifest \
  -H 'expo-platform: ios' -H 'expo-runtime-version: 1' -H 'expo-protocol-version: 1'
```

- Both `200 multipart/mixed`; manifest `id` differs between `:3000` and `:3001`.
- Launch-asset URL `200`s; its host matches the serving port.
- Wrong `expo-runtime-version` -> `204`; missing/invalid `expo-platform` -> `400`.

## Footguns

- Swapping framework files without rebuilding the host does nothing (embedded at
  build time).
- **Stale host derived data after a framework swap.** Reusing a
  `-derivedDataPath` that was previously built against the other framework
  variant can fail with `<unknown>:0: error: missing required module
  'SwiftOnoneSupport'` (a Debug framework's unoptimized `.swiftmodule` lingering
  in the explicit-module cache). Reproduced 2026-07-28: the same command
  succeeded immediately with a fresh path. Use one derived-data path per variant
  (this repo's flows use `build` for Shipping mode and `build-metro` for Metro
  mode) or delete
  `hosts/ios/build*` after swapping. Nothing about the frameworks themselves is
  wrong when this happens.
- A stray Metro on `:8081` from another checkout feeds the wrong bundle -- check
  `lsof` first.
- Relaunching between v1 capture and Restart silently self-applies the update.
- Cycle Developer -> Sky -> Spinner -> Developer repeatedly. The shell mounts
  one RN surface at a time, but a historical later-mount blank is still tracked
  in `docs/brownfield.md`; do not consider the tab flow verified if any route is
  blank or restores the previous route.
- `simctl install booted` fails if no simulator is booted -- boot one first
  (`xcrun simctl boot ...; open -a Simulator`).

## Related

- `docs/development-workflow.md` -- the procedures, runbook and OTA proof (canonical for those).
- `docs/brownfield.md` -- iOS packaging, native tab shell, reloader, Host Settings.
- `docs/architecture.md` -- runtime modes and artifact source defined (canonical), plus the per-platform matrix and topology.
- Android equivalent: the `verify-android` skill.
