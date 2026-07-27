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
   mounted in `src/app/_layout.tsx` ABOVE `<OtaGate>` (so its bridge
   subscription exists even while the OTA gate blocks children), handles
   `selectTab` by calling `router.navigate(route)`. It is readiness-aware: it
   holds the latest requested route and dispatches only once the root
   navigation ref reports ready (expo-router 55's `routingQueue` silently drops
   actions before the navigation ref exists), then verifies the landed tab and
   retries once if needed. It is a no-op on web/standalone.

   **`tabsReady` handshake (cold-start lost-tap recovery).** A native tab tap
   can race the JS `selectTab` subscription two ways on a cold start: (a) the
   post is emitted after the TurboModule event emitter wires up but before this
   listener subscribes -- delivered into the void, no error; or (b) even
   earlier, the emitter itself is not wired and the native
   `postMessage`/`emitOnBrownfieldMessage` throws. To close both windows,
   `TabSelectGuard` posts `{ "type": "tabsReady" }` ONCE per tab-surface mount,
   right after it subscribes its message listener (only when
   `isBrownfieldHost() && isNavRestoreEnabled()`, so pushed screens never
   participate). Each host relays it (`TabsReadyRelay` on both platforms) and
   re-posts its currently-selected tab -- which `navigateTo`/`selectTab` has
   already updated to the tapped tab BEFORE posting -- and the JS side applies
   the re-post idempotently (already-there routes no-op). Because the listener
   subscribes BEFORE `tabsReady` is sent, the emitter cannot throw after the
   handshake fires, so an emitter-not-ready failure always has a pending
   handshake to recover it.

   **No remount on a lost tap (the one-ExpoRoot rule).** The host does NOT
   remount the surface when a `selectTab` post fails; it relies on the
   handshake above. An earlier Android build DID remount on the emitter-not-
   ready throw (`removeMountedFragment()` + `mountFragment()`), which mounted a
   transient SECOND ExpoRoot in the same JS runtime. expo-router 55 keeps its
   whole router store -- including the ref `useNavigationContainerRef()`
   returns -- in a single module-global slot shared by every ExpoRoot; two
   concurrent mounts clobber it, so `TabSelectGuard`'s
   `navigationRef.isReady()` could read a container detached on unmount and
   poll forever, permanently stranding the shell on its mount-time tab even
   though a container was on screen. Dropping the remount keeps exactly one
   ExpoRoot (matching iOS, which never remounted here), so `isReady()` is
   reliable and the poll always terminates. Do NOT reintroduce a remount on the
   RN-tab -> RN-tab path.
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
user last selected. Restoration is DERIVED from observed reality rather than
re-pointed:

- `applySelectTab(route, navigate)` ONLY validates the route, resolves the
  target path (`resolveTabPath`), and navigates. It does NOT checkpoint or
  re-point anything -- there is no `setActiveNavSurface` / "active surface"
  pointer anymore.
- Attribution follows the OBSERVED pathname. Once the navigation commits,
  `NavStateGuard` checkpoints both the per-tab slice (`checkpointNavPath`) and
  `nav:activeTab` (`checkpointActiveTab`), each DERIVING its owning tab from the
  pathname itself (`tabForPath`: the known tab `t` where `path === t` or
  `path.startsWith(t + '/')`). A lagging emission is therefore always filed
  under the tab it actually names -- the fix for the on-device stall where
  re-pointing wrote the old tab's route under the new tab's key.
- On the next mount, `resolveInitialLocation(initialUrl, mountedAt)` honors a
  fresh `nav:activeTab` slice ONLY when it names a known tab AND was saved
  AFTER `mountedAt` -- the wall-clock stamp each host mints per fresh mount.
  That "selection post-dates these props" condition is true ONLY for an
  in-place reload reusing STALE props; a genuinely fresh mount targeting a new
  tab (More -> Spinner) carries a current `mountedAt`, so `initialUrl` stays
  authoritative and the mount is never hijacked back. The chosen tab's own
  saved path is then resolved.
- `resolveTabPath` accepts a saved slice's path ONLY when it is genuinely owned
  by that tab (`=== route` or nested under it), so an already-polluted store
  cannot re-stall the surface. Pushed screens (which do not opt into
  `restoreNavState`) are unaffected.

`nav:activeTab` is a host-state key on the same store/seam; the 16KB and
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
