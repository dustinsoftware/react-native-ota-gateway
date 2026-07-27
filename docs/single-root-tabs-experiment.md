# Experiment: single persistent RN root for the host tabs

> **Status: experiment / design proposal.** Nothing in this document is
> implemented yet. The current shipped behavior is described in
> [brownfield.md](./brownfield.md): the native shells tear down and remount a
> fresh RN surface on every tab selection.

## Motivation

Switching between the native shell's RN tabs (Developer / Sky / Spinner)
shows a brief white flash. The flash is inherent to the current design: a tab
selection calls `removeCurrentSurface()` and mounts a brand-new ExpoRoot
surface (`HostShellViewController.mountSurface` on iOS; Android recreates the
whole `RNHostActivity`). Until the new surface renders its first JS frame, the
empty native container shows through (`systemBackground` -- white in light
mode).

By contrast, navigation *inside* one live surface (e.g. Test 1 -> Test 2 via
expo-router) never flashes: React swaps screens in place and every screen
paints the app's dark background.

## Proposed design

Keep **one** persistent RN surface mounted in the shell's content slot and
drive tab changes over the existing native<->RN message bridge instead of
remounting:

1. **Mount once.** The shell mounts a single RN surface at startup and does
   NOT tear it down on tab selection.
2. **Native -> JS tab message.** On a native tab tap, the host posts a message
   over the same bridge the host-state and nav seams already use, e.g.
   `{ "type": "selectTab", "route": "/sky" }`.
3. **JS listener.** A listener in the RN app (registered near the root
   layout) handles `selectTab` by calling `router.replace(route)`.
4. **Native chrome stays native.** The host still updates the navigation
   title and the Developer tab's Settings button on its own side when the tab
   changes; RN renders content only, as today.

### Why the documented brownfield bugs do NOT apply

The failure modes that forced the current teardown/remount design (see
[brownfield.md](./brownfield.md)) were all caused by *multiple* roots or by
*remounting* -- a single persistent root avoids the triggering conditions:

- **Concurrent Expo Router roots (intermittent blank screens).** There is
  still exactly one root; it is simply long-lived.
- **`freshRouteContext` route bleed.** The bleed happens when a *new* surface
  mounts and expo-router's module-global store restores the previous
  surface's route. With no remount there is no second mount to bleed into.
- **Android back-callback leak.** Upstream, Callstack's
  `ReactNativeFragment.createView` leaked Activity-scoped back callbacks when
  fragments were *replaced* inside a shared activity. This is now fixed by a
  pnpm package patch
  (`patches/@callstack__react-native-brownfield@3.6.1.patch`) that scopes the
  callback to the fragment's lifecycle -- so neither the always-mounted
  persistent root nor a More-tab detach/remount cycle (Open Problem 1,
  option A) can accumulate callbacks. Android would also stop recreating
  `RNHostActivity` per tab switch.

## Open problems (the wrinkles)

1. **The More tab.** More is native, and its Test rows push a *separate* RN
   surface (`RNScreenActivity` / a pushed screen on the iOS nav stack). If
   the persistent shell surface stays mounted underneath, TWO Expo Router
   roots are live at once -- the explicitly forbidden case. Options:
   - Detach/tear down the shell surface while More is selected. This
     reintroduces the flash on More <-> RN-tab transitions (but keeps it off
     the common Developer/Sky/Spinner path). Each More -> RN-tab round trip
     remounts a fragment in the same long-lived Activity; safe on the
     back-callback front only because of the package patch above, and it
     re-exposes the `freshRouteContext` remount path.
   - Keep the surface mounted but hidden and re-verify the concurrent-roots
     blank-screen issue extensively. Riskier; the standing rule is "never
     retain concurrent Expo Router roots in this host."
2. **OTA reload.** A reload restarts the RN runtime, so `rebuildActiveSurface`
   (and its one-time flash) remains for reloads. The persistent root only
   removes the per-tab-switch remount.
3. **Demo value lost.** The tab surfaces are currently the primary exercise of
   teardown/remount, the host-state seam, and nav restore -- which is the
   point of this repository. With a persistent root, the pushed Test screens
   become the only exercise of those seams. The tab-switch state-restoration
   assertions in the Maestro flows would need rework or retirement.
4. **Android restoration paths.** `HostRoutePrefs` / scene restoration assume
   an Activity recreation per tab change; the persisted-route handling needs
   rework for a long-lived Activity.
5. **Restart-in-flight window.** The current shell skips mounting while an OTA
   restart is in flight and relies on `rebuildActiveSurface` afterward. With a
   persistent root, a tab message sent during that window would be lost;
   either queue the target route natively or keep relying on the
   restore-selected-tab path after rebuild.

## Alternative (cheap, cosmetic)

If the only goal is hiding the flash: paint the native content container (and
the Android window background) the app's dark background color
(`Colors.dark.background`) so the boot gap matches the RN theme instead of
showing white. No architectural change, no risk.

## Verification plan (if implemented)

- Repeated Developer -> Sky -> Spinner -> Developer cycles on both platforms
  (the historical blank-screen reproduction) -- no flash, no blank surface.
- More tab: push Test 1/2/3, verify Back behavior and that the
  chosen More-tab strategy never leaves two live roots.
- OTA reload on each tab; relaunch; process death (Android); scene
  restoration (iOS) -- selected tab restored, surface rebuilt.
- Existing Maestro flows (`.maestro/`), updated where they assert on
  remount-driven state restoration.
