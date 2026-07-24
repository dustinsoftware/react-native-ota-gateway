---
name: verify-android
description: Verify the Android brownfield host in both testing modes -- Mode A (local hot reload, JS from Metro via the runtime toggle) and Mode B (release artifact, JS from OTA/embedded). Use when asked to verify, test, or smoke-check the Android app/host, run the Android OTA flow, or switch the Android host between dev and release modes.
---

# Verify Android (Mode A / Mode B)

Step-by-step verification of the Android brownfield host. The canonical source is
`docs/development-workflow.md` (Mode A/B sections + runbook) and
`docs/brownfield.md` (Android AAR + host); this skill is the operational
checklist. If a step here ever conflicts with those docs, the docs win -- and
update them.

## The two modes

| | Mode A -- local hot reload (dev) | Mode B -- release artifact (OTA) |
| --- | --- | --- |
| JS source | Metro (`:8081`), Fast Refresh | OTA manifest / embedded bundle |
| Switch mechanism | **Runtime toggle** ("Use Metro dev server") + relaunch | Toggle off (the default) |
| Rebuild needed? | No -- toggle only | No -- toggle only |
| Use it to | Iterate on RN/JS fast | Verify the real artifact + OTA delivery |

**Android has a runtime Metro toggle** (unlike iOS). When on, the host inits RN
via `ReactNativeDevHostManager` (`useDevSupport = true`); Android bundle
resolution honors `useDevSupport` at runtime, so no framework rebuild is needed
to switch modes. The toggle defaults **off** and persists in prefs.

> **Scope:** this skill verifies the **brownfield host**. The standalone web
> (`:3000` in a browser) and standalone native (`npx expo run:android`) targets
> are separate and verified per the runbook's steps 4/4b in
> `docs/development-workflow.md`.

> **Two distinct Host Settings controls, don't conflate them:** the **"Use Metro
> dev server" toggle** selects Mode A vs Mode B (JS source); the **environment
> radio** selects dev vs prod gateway (`:3000` vs `:3001`) and is a Mode B
> concern. Open both from the Developer tab's native Settings action.

## Preconditions (both modes)

1. `pnpm install`
2. `pnpm typecheck && pnpm test` -- the CI gate; must be green first.
3. `pnpm --filter @ota-gateway/mobile export` -- exports all platforms + manifest.
   **Never run `npx expo export` directly** (Metro never exits -> hangs).
4. Gateway containers up: `docker compose up --build -d` (`gateway-dev` :3000 /
   `gateway-prod` :3001). **Mode B is served ONLY from these Docker
   containers** -- never from host-run `pnpm server:*` (those are for
   standalone-web iteration). The images bake `dist/`, so re-run with
   `--build` after every export. Mode A always uses the Expo/Metro dev server.
5. Tooling: JDK 17, Android SDK (compileSdk 36, an emulator), Gradle 8.14.4
   (wrapper), minSdk 24. Have an emulator **running** (or a device connected)
   before the `adb` / install steps (`adb devices` should list one).
6. **Port reversing (emulator too, not just physical devices):**
   ```
   adb reverse tcp:3000 tcp:3000
   adb reverse tcp:3001 tcp:3001
   adb reverse tcp:8081 tcp:8081
   ```
   Without `:8081` in Mode A the app's own `localhost` requests die even if the
   bundle loads; without `:3000`/`:3001`, OTA against the local servers fails.
   Cleartext is permitted via `network_security_config.xml`.
7. Check for a stray Metro first: `lsof -i :8081 -i :3000 -i :3001`.

## Build + install the host (both modes)

```
cd apps/mobile && node scripts/prebuild.mjs --android
OTA_ENVIRONMENT=production pnpm exec brownfield publish:android --module-name otagatewaylib
cd ../../hosts/android && ./gradlew :app:assembleDebug          # host app embeds dev.otagateway:otagatewaylib
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> `adb install -r` **preserves prefs** -- the Metro toggle survives a reinstall.
> Only an uninstall clears it back to the default (off = Mode B).

## Mode B -- release artifact + OTA flow (do this first)

Toggle **off** (the default). Metro need not run.

1. Launch the host on the Developer native tab.
2. **Pass criteria:** the embedded bundle loads; Developer shows the current
   `OTA marker` and an update id; the RN tab bar is hidden. The Maestro suite
   passes, in the documented order (self-warming flows first; see
   docs/development-workflow.md): `verify-more-tab-android.yaml`,
   `verify-spinner-persistence-android.yaml`,
   `verify-spinner-survives-push-android.yaml`, `verify-double-tap-android.yaml`,
   then `./.maestro/run-rotation-android.sh` (rotation via adb between parts).
3. OTA flow: **Check for update** -> **Download** -> **Restart** (the brownfield
   reload relaunches the RN root; no process kill).
4. Open native Settings, flip the **environment radio**, and relaunch -> a
   **different update id** for identical bytes (the per-environment id seam).

### OTA delivery proof (the DONE demo)

Do **not** relaunch the host between capturing v1 and the manual Restart --
`checkAutomatically: ALWAYS` auto-applies the update on relaunch and you miss
the transition.

1. Fresh launch: note `OTA marker: v1` and the update id.
2. Edit `apps/mobile/src/constants/marker.ts` to `v2`, re-run
   `pnpm --filter @ota-gateway/mobile export` and
   `docker compose up --build -d` (containers bake `dist/`; rebuild to serve
   the new export).
3. In-app: **Check** -> true -> **Download** -> **Restart**.
4. Developer shows `OTA marker: v2`, `isEmbeddedLaunch false`, new id.
5. Flip the environment radio + relaunch: different id, identical bytes
   (content-hash dedupe -> no re-download).

> Update ids are not stable across exports of identical source (Hermes bytecode
> isn't byte-identical). Record ids from the export you're actually serving.

## Mode A -- local hot reload (no rebuild)

1. Start Metro (own terminal): `pnpm --filter @ota-gateway/mobile start`.
2. On Developer, open native Settings, enable **"Use Metro dev server"**, then
   **relaunch** the app (inits RN with `useDevSupport = true`).
3. `adb reverse tcp:8081 tcp:8081` (and `:3000`/`:3001` if the JS hits the servers).
4. **Pass criteria:** edit any JS under `apps/mobile/src` -> Fast Refresh applies
   instantly, no rebuild.

**Return to Mode B:** turn the toggle off and relaunch. (Note: Mode A leaves
`HostEnvironment.current` unset -- the native env radio is a Mode B concern; Metro
owns the bundle in Mode A.)

## Manifest curl (protocol v1 requires three headers)

```
curl -sD - -o /dev/null http://localhost:3000/api/v2/updates/manifest \
  -H 'expo-platform: android' -H 'expo-runtime-version: 1' -H 'expo-protocol-version: 1'
curl -sD - -o /dev/null http://localhost:3001/api/v2/updates/manifest \
  -H 'expo-platform: android' -H 'expo-runtime-version: 1' -H 'expo-protocol-version: 1'
```

- Both `200 multipart/mixed`; manifest `id` differs between `:3000` and `:3001`.
- Launch-asset URL `200`s; its host matches the serving port.
- Wrong `expo-runtime-version` -> `204`; missing/invalid `expo-platform` -> `400`.

## Footguns

- Forgetting `adb reverse` on the **emulator**: the bundle may load (RN dev
  special-cases the emulator) but the app's own `localhost` calls fail.
- `adb install -r` keeps the toggle state -- an unexpected Mode A/B can persist
  across reinstalls; uninstall to reset.
- A stray Metro on `:8081` from another checkout feeds the wrong bundle.
- Relaunching between v1 capture and Restart silently self-applies the update.
- Cycle Developer -> Sky -> Spinner -> Developer. Each tap recreates the host
  Activity intentionally so Callstack's Activity-scoped Back callback and the
  prior RN root are destroyed. Confirm the selected route renders, the RN tab
  bar stays hidden, and hardware Back never targets a previous tab.

## Related

- `docs/development-workflow.md` -- Mode A/B, runbook, OTA proof (canonical).
- `docs/brownfield.md` -- native tab shell, Host Settings, reload handler.
- `docs/architecture.md` -- Mode A/B matrix and topology.
- iOS equivalent: the `verify-ios` skill.
