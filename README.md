# react-native-ota-gateway

A demo / template monorepo that proves an end-to-end **self-hosted Expo OTA
update** stack (no EAS) plus a **Callstack brownfield** integration, with **zero
proprietary dependencies**. It is fully self-contained and generic, so it can be
read, run, and copied freely.

## What this is

One Expo SDK 55 / React Native 0.83 code tree (`apps/mobile`) that serves three
targets from the same source:

- **Standalone web** -- an Express server (the same server that hosts the OTA
  manifest) serving the Expo web build and its `+api.ts` routes.
- **Standalone iOS / Android** -- the app run directly via `expo run:ios` /
  `expo run:android`.
- **Brownfield artifacts** -- an iOS XCFramework and an Android AAR that a native
  host app embeds to render RN screens inside an existing native app.

Two minimal native host apps (`hosts/ios`, `hosts/android`) embed the brownfield
artifacts and own a four-item native tab bar (Developer, Sky, Spinner, More).
Each host keeps at most one RN surface mounted at a time and passes the selected
route as `initialUrl`, demonstrating that the host owns navigation state. The
More tab is fully native: a Test menu whose rows push RN and native screens on
one back stack (the mix-and-match demo). Host-only OTA
environment and Metro controls live behind the Developer tab's native Settings
action.

The demo backend is the app's own server run as two instances: a **dev**
instance on `http://localhost:3000` and a **prod** instance on
`http://localhost:3001`. The same exported bundle is served by both; the
environment (chosen per instance) flips the gateway host stamped into the
manifest and the served update id, which demonstrates the dual-environment
gateway seam. For Mode B (release artifact) testing the two instances run as
**standalone Docker containers** (`docker compose up --build -d`) that bake the
export -- never as host-run dev servers; the host-run `pnpm server:*` scripts
exist only for standalone-web iteration. See
[docs/development-workflow.md](./docs/development-workflow.md).

## Orientation

Everything canonical lives in [`docs/`](./docs). Read the relevant document
before working on a subsystem, and keep it current with any change (see
[AGENTS.md](./AGENTS.md)).

| Doc | Covers |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | Monorepo layout, the dual-target model, who talks to whom, the Mode A/B matrix per platform. |
| [docs/ota-updates.md](./docs/ota-updates.md) | Self-hosted Expo Updates Protocol v1: manifest route, per-env update-id derivation, placeholder stamping, content-addressed assets, `OtaGate`, bridge reload. |
| [docs/brownfield.md](./docs/brownfield.md) | Packaging pipeline, the two config plugins, the full iOS + Android host-integration recipe, gotchas. |
| [docs/configuration.md](./docs/configuration.md) | The environment model: `OTA_ENVIRONMENT`, the runtime host-environment seam, the gateway map, where each value lives. |
| [docs/development-workflow.md](./docs/development-workflow.md) | Prerequisites, Mode A/B steps per platform, the runbook, verification. |

## Naming (used consistently everywhere)

| Concept | Name |
| --- | --- |
| RN module registered for brownfield | `OtaGatewayApp` |
| iOS framework / scheme | `OtaGatewayLib` |
| Android library module | `otagatewaylib` |
| Android/iOS package / group | `dev.otagateway` |
| Android AAR coordinate | `dev.otagateway:otagatewaylib:0.1.0-SNAPSHOT` |
| Manifest base-URL placeholder | `__OTA_GATEWAY_BASE_URL__` |
| Build-time env selector | `OTA_ENVIRONMENT` |
| Dev gateway / prod gateway | `http://localhost:3000` / `http://localhost:3001` |

## Canonical runbook

The end-to-end verification order. Details in
[docs/development-workflow.md](./docs/development-workflow.md).

```
1  pnpm install
1b pnpm typecheck && pnpm test                     # the CI gate; must be green first
2  pnpm --filter @ota-gateway/mobile export        # export all platforms + generate manifest
3  docker compose up --build -d                    # gateway containers (Mode B serving) -- dev :3000, prod :3001
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
15 OTA proof: bump the bundle marker -> step 2 -> step 3 (rebuild containers) -> Check/Download/Restart -> new marker (both platforms)
```

## Status

Complete. All phases are implemented and the full stack has been verified
end-to-end on both platforms as of 2026-07-17: self-hosted OTA delivery (marker
bump -> Check/Download/Restart, distinct per-environment update ids) and the
brownfield host integration in both Mode A and Mode B, on the iOS simulator and
the Android emulator. The iOS in-place Restart originally rebooted the
previously-launched bundle; the fix (expo-updates launcher advance + release
bundle-URL override) is documented in
[docs/brownfield.md](./docs/brownfield.md). Docs were written first (target
design) and reconciled against the code in a closing audit; any deviation found
while implementing was folded back into the corresponding doc in the same
change.
