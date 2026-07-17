---
name: verify-ios
description: Verify the iOS brownfield host in both testing modes -- Mode A (local hot reload, JS from Metro) and Mode B (release artifact, JS from OTA/embedded). Use when asked to verify, test, or smoke-check the iOS app/host, run the iOS OTA flow, or switch the iOS host between dev and release modes.
---

# Verify iOS (Mode A / Mode B)

Step-by-step verification of the iOS brownfield host. The canonical source is
`docs/development-workflow.md` (Mode A/B sections + runbook) and
`docs/brownfield.md` (iOS packaging); this skill is the operational checklist.
If a step here ever conflicts with those docs, the docs win -- and update them.

iOS is **simulator-only** in this repo (`CODE_SIGNING_ALLOWED=NO`).

> **Scope:** this skill verifies the **brownfield host**. The standalone web
> (`:3000` in a browser) and standalone native (`npx expo run:ios`) targets are
> separate and verified per the runbook's steps 4/4b in
> `docs/development-workflow.md`.

## The two modes

| | Mode A -- local hot reload (dev) | Mode B -- release artifact (OTA) |
| --- | --- | --- |
| JS source | Metro (`:8081`), Fast Refresh | OTA manifest / embedded bundle |
| Framework | Debug-built (`--configuration Debug`) | Release-built (default) |
| Switch cost | Rebuild framework + host | Rebuild framework + host |
| Use it to | Iterate on RN/JS fast | Verify the real artifact + OTA delivery |

**There is no runtime Metro toggle on iOS.** A Release framework's enabled
expo-updates owns the bundle URL and always beats a host override; it can only be
disabled in a Debug build. So you switch modes by rebuilding the framework, not
by flipping a setting (this is the key iOS-vs-Android difference).

## Preconditions (both modes)

1. `pnpm install`
2. `pnpm typecheck && pnpm test` -- the CI gate; must be green first.
3. `pnpm --filter @ota-gateway/mobile export` -- exports all platforms and
   regenerates the OTA manifest. **Never run `npx expo export` directly** (Metro
   never exits and it hangs).
4. Servers up: `pnpm server:dev & pnpm server:prod` (`:3000` dev / `:3001` prod).
5. Tooling present: `xcodegen`, Xcode CLT, `ccache` (`brew install xcodegen ccache`).
   The first `package-ios.sh` builds RN from source -- **cold builds run 30-60+
   min**; ~2-6 min with a warm ccache. It is not hung; let it finish.
6. The iOS simulator reaches `localhost:3000/:3001/:8081` directly -- no `adb
   reverse` equivalent needed. Cleartext to localhost is allowed via
   `NSAllowsLocalNetworking` in `Info.plist`.
7. Check for a stray Metro before starting one: `lsof -i :8081 -i :3000 -i :3001`.
   A Metro from another checkout on `:8081` silently feeds the host the wrong bundle.

## Mode B -- release artifact + OTA flow (do this first)

This mirrors what ships; verify it before touching Mode A.

```
xcrun simctl boot 'iPhone 16' 2>/dev/null; open -a Simulator   # ensure a simulator is booted first
cd apps/mobile && ./scripts/package-ios.sh                 # Release framework (selects Mode B)
cd ../../hosts/ios && xcodegen                             # generate .xcodeproj from project.yml
xcodebuild -project OtaHost.xcodeproj -scheme OtaHost \
  -sdk iphonesimulator -configuration Release \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build     # host app; framework is embedded at build time
xcrun simctl install booted build/Build/Products/Release-iphonesimulator/OtaHost.app
xcrun simctl launch booted dev.otagateway.host
```

Metro need not run in Mode B. The host **target** config (Debug/Release) is
independent of the mode -- the mode is selected by the *framework* config baked
in by `package-ios.sh`. `-derivedDataPath build` pins the `.app` output path so
`simctl install` can find it.

**Pass criteria:**
- App boots and renders the RN screen inside the native host.
- Home screen shows the current `OTA marker` and an update id.
- Manifest curl returns `200 multipart/mixed` and the `:3000` vs `:3001` ids
  differ for identical bytes (see below).

### OTA delivery proof (the DONE demo)

Do **not** relaunch the host between capturing v1 and the manual Restart --
`checkAutomatically: ALWAYS` means a relaunch auto-applies the update and you
never see the transition.

1. With a fresh launch, note `OTA marker: v1` and the update id.
2. Edit `apps/mobile/src/constants/marker.ts` to `v2`, then re-run
   `pnpm --filter @ota-gateway/mobile export`.
3. In-app: **Check for update** -> true -> **Download** -> **Restart** (the
   brownfield bridge reload, not a process relaunch).
4. Home screen now shows `OTA marker: v2`, `isEmbeddedLaunch false`, and a new id.
5. Flip the environment (the segmented control on the dev-tools screen) and
   relaunch: the other instance serves a **different update id** for identical
   bytes (assets dedupe by content hash -> no re-download).

> Update ids are not stable across exports of identical source (Hermes bytecode
> isn't byte-identical build to build). Record ids from the export you are
> actually serving.

## Mode A -- local hot reload

One framework build per dev session; after that, JS Fast-Refreshes on save.

```
pnpm --filter @ota-gateway/mobile start                          # Metro on :8081 (own terminal)
cd apps/mobile && ./scripts/package-ios.sh --configuration Debug # disables expo-updates; installs #if DEBUG bundleURLOverride -> :8081
cd ../../hosts/ios && xcodegen \
  && xcodebuild -project OtaHost.xcodeproj -scheme OtaHost -sdk iphonesimulator \
       -configuration Release -derivedDataPath build CODE_SIGNING_ALLOWED=NO build  # rebuild host against Debug framework
xcrun simctl install booted build/Build/Products/Release-iphonesimulator/OtaHost.app \
  && xcrun simctl launch booted dev.otagateway.host
```

- On the simulator with Metro on the **default** port, nothing else to configure.
- Non-default port or physical device: set the packager host via the RN dev menu
  ("Configure Bundler"); the override honors an explicit `RCT_jsLocation`.
- **Pass criteria:** edit any JS under `apps/mobile/src` -> the change Fast-
  Refreshes in the running app without a rebuild.
- Rebuilding the host without repackaging changes nothing -- frameworks are
  embedded at build time.

**Return to Mode B:** repackage Release (`./scripts/package-ios.sh`) and rebuild
the host.

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
- A stray Metro on `:8081` from another checkout feeds the wrong bundle -- check
  `lsof` first.
- Relaunching between v1 capture and Restart silently self-applies the update.
- Opening the `/developer` RN screen as the **second** pushed surface can
  intermittently come up blank (known, not fixed -- see `docs/brownfield.md`).
  This is not a host failure: reopen the surface (the reloader rebuilds it), or
  open `/developer` first.
- `simctl install booted` fails if no simulator is booted -- boot one first
  (`xcrun simctl boot ...; open -a Simulator`).

## Related

- `docs/development-workflow.md` -- Mode A/B, runbook, OTA proof (canonical).
- `docs/brownfield.md` -- iOS packaging, reloader, dev-tools screen.
- `docs/architecture.md` -- Mode A/B matrix and topology.
- Android equivalent: the `verify-android` skill.
