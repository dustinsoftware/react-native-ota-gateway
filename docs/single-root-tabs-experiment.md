# Single persistent RN root for the host tabs

> **Status: implemented.** The native shells keep ONE long-lived RN surface
> mounted for the Developer / Sky / Spinner tabs and drive tab changes over the
> `selectTab` bridge message instead of remounting. The current shipped
> behavior is also summarized in [brownfield.md](./brownfield.md); this document
> keeps the decision rationale and records how the original open problems were
> resolved.

## Motivation

Switching between the native shell's RN tabs (Developer / Sky / Spinner) used
to show a brief white flash. It was inherent to the old design: a tab selection
tore down the current ExpoRoot surface and mounted a brand-new one (iOS
`removeCurrentSurface()` + `mountSurface`; Android recreated the whole
`RNHostActivity`). Until the new surface rendered its first JS frame, the empty
native container showed through (`systemBackground` -- white in light mode).

By contrast, navigation *inside* one live surface (e.g. Test 1 -> Test 2 via
expo-router) never flashes: React swaps screens in place and every screen
paints the app's dark background. This experiment brings that flash-free
behavior to the common tab path.

## What shipped

One persistent RN surface stays mounted in the shell's content slot, and RN
tab -> RN tab changes are driven over the existing native<->RN message bridge:

1. **Mount once.** The shell mounts a single RN surface and does NOT tear it
   down on an RN-tab -> RN-tab selection.
2. **`selectTab` bridge message.** On an RN-tab -> RN-tab tap, the host posts
   `{ "type": "selectTab", "route": "/developer" | "/sky" | "/spinner" }` over
   the same bridge the host-state and nav seams already use
   (`ReactNativeBrownfield.shared.postMessage`).
3. **JS listener.** `TabSelectGuard` (`src/components/tab-select-guard.tsx`),
   mounted in `src/app/_layout.tsx` next to `NavStateGuard`, handles `selectTab`
   by
   calling `router.replace(route)`. It is a no-op on web/standalone.
4. **Known-route validation lives in the handler.** The Zod schema
   (`selectTabSchema` in `message-bridge.types.ts`) types `route` as a bare
   string; the SET of known tab routes is checked in `applySelectTab`
   (`src/brownfield/nav-restore.ts`) against `KNOWN_TAB_ROUTES`. An unknown or
   malformed route is silently ignored -- the version-skew guarantee, so a
   newer host can add a tab route without breaking an older bundle.
5. **Native chrome stays native.** The host still updates the navigation title
   and the Developer tab's Settings action on its own side; RN renders content
   only.

### Nav restoration across the in-place OTA reload

The subtle case is Android's OTA reload. A reload relaunches the shared
`ReactHost` **in place**, so the mounted fragment re-mounts JS with its
mount-time `initialUrl` (the fragment's stale initial route), NOT the tab the
user last selected. To land on the right tab, the `selectTab` handler records
the selection:

- `applySelectTab(route, navigate)` resolves the target path, calls
  `checkpointActiveTab(route)` (writes the `nav:activeTab` host-state slice),
  `setActiveNavSurface(route)` (re-points continuous checkpointing at the new
  tab in place, since there is no remount), and finally `navigate(target)`.
- On the next mount, `resolveInitialLocation` gives a fresh `nav:activeTab`
  slice naming a known tab precedence over the mount-time `initialUrl`, then
  resolves that tab's own saved path (`nav:<route>`, 30-min TTL). Pushed
  screens (which do not opt into `restoreNavState`) are unaffected.

`nav:activeTab` is a new host-state key on the same store/seam; the 16KB and
secret-name checkpoint rules apply to it like any other slice.

### Why the documented brownfield bugs do NOT apply

The failure modes that forced the old teardown/remount design (see
[brownfield.md](./brownfield.md)) were all caused by *multiple* roots or by
*remounting* -- a single persistent root avoids the triggering conditions:

- **Concurrent Expo Router roots (intermittent blank screens).** There is still
  exactly one root; it is simply long-lived. The one-ExpoRoot rule is
  preserved: the native More tab still tears the shell surface down (see Open
  problem 1 below), so a pushed Test screen is never a *second* live root.
- **`freshRouteContext` route bleed.** The bleed happened when a *new* surface
  mounted and expo-router's module-global store restored the previous surface's
  route. With no remount on the RN-tab -> RN-tab path there is no second mount
  to bleed into.
- **Android back-callback leak.** Callstack's `ReactNativeFragment.createView`
  leaked Activity-scoped back callbacks when fragments were *replaced* inside a
  shared activity. The pnpm package patch
  (`patches/@callstack__react-native-brownfield@3.6.1.patch`) scopes the
  callback to the fragment's VIEW (owner registration plus removal in
  `onDestroyView`), so the always-mounted persistent root -- and the
  More -> RN-tab remount cycle -- cannot accumulate callbacks.

## Resolved open problems

1. **The More tab -- resolved by tearing the shell surface down.** More is
   native, and its Test rows push a *separate* RN surface. Rather than keep a
   hidden second root, selecting More removes the shell fragment (Android
   `removeMountedFragment()` via `commitNow`; iOS teardown + embed
   `MoreMenuViewController`). While More is selected the ONLY live RN surface is
   a pushed one, so the one-ExpoRoot rule holds. Returning More -> RN-tab is a
   FRESH mount with restore props. This re-exposes the (harmless, patched)
   remount path on More<->RN-tab only, not on the common Developer/Sky/Spinner
   path.
2. **OTA reload -- unchanged by design.** A reload restarts the RN runtime.
   iOS does a real teardown + `rebuildActiveSurface`; Android relaunches the
   `ReactHost` in place with the fragment still mounted. Either way the persisted
   `nav:activeTab` slice lands the user on the tab they selected (see above).
   The persistent root only removes the per-tab-switch remount.
3. **Demo value -- preserved.** The pushed Test screens and the More<->RN-tab
   remount still exercise teardown/remount, the host-state seam, and nav
   restore; the spinner's tab-roundtrip persistence still rides the seam. The
   Maestro flows (`.maestro/`) are being reworked in a parallel workstream to
   assert the persistent-root behavior instead of a per-tab remount.
4. **Android restoration paths -- reworked for a long-lived Activity.**
   `RNHostActivity` no longer recreates per tab. `onCreate` still mounts
   whatever `HostRoutePrefs` records (covering fresh launch, rotation, process
   death, and OTA relaunch); the in-place reload lands the right tab via the
   `nav:activeTab` slice rather than an Activity recreation.
5. **Restart-in-flight window -- selection persisted, materialized after
   restart.** iOS uses `hasMountedReactSurface` (live-RN-surface identity) and
   `BrownfieldReloader.shared.isRestartInFlight`: a soft `selectTab` post is
   only sent when an RN tab is targeted AND a live RN surface exists AND no
   restart is in flight. During a restart the selection is persisted only, and
   `rebuildActiveSurface` materializes it after the restart. Android has no
   in-flight flag -- the fragment stays mounted across the in-place `ReactHost`
   relaunch and the persisted tab lands via the JS `nav:activeTab` slice.

## Remaining caveats

- **iOS full build unverified without a packaged framework.** The iOS host
  changes were made against the source but a full host build/run needs the
  packaged `OtaGatewayLib.xcframework`; re-run the `verify-ios` skill once a
  framework is available.
- **Back behavior untouched.** The per-view back-callback removal (the pnpm
  package patch) and the host Back handling are unchanged; the persistent root
  relies on the patch to stay leak-free across the More<->RN-tab remount.
- **Skew guarantee is validation-in-handler.** Because known-route validation
  lives in `applySelectTab` (not the schema), an older bundle simply ignores a
  route a newer host adds; never move that check into the schema or rename the
  route literals (they are pinned by the drift guard).

## Verification plan

- Repeated Developer -> Sky -> Spinner -> Developer cycles on both platforms
  (the historical blank-screen reproduction) -- no flash, no blank surface, no
  route bleed.
- More tab: push Test 1/2/3, verify Back behavior and that the More strategy
  never leaves two live roots.
- OTA reload on each tab; relaunch; process death (Android); scene restoration
  (iOS) -- selected tab restored, surface rebuilt.
- Maestro flows (`.maestro/`), as reworked for the persistent-root behavior.
