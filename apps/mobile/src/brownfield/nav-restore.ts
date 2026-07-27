import { checkpointHostState, readHostSavedState } from './host-state';

/**
 * Navigation restoration over the host-state seam.
 *
 * freshRouteContext deliberately resets a remounted surface to its
 * `initialUrl` (see runtime.ts) -- correct for pushed screens, but a UX
 * regression for SHELL TABS once tabs hold deep in-surface navigation: an
 * Android tab-switch remount (or OTA reload) would otherwise drop the user
 * back to the tab's root. Hosts opt a surface in by passing
 * `restoreNavState: true` in initial properties (tab mounts only; pushed
 * screens stay fresh-by-design).
 *
 * Attribution is DERIVED, never re-pointed. Every checkpoint decides which tab
 * it belongs to from the OBSERVED pathname alone (see {@link tabForPath}): a
 * `/sky/detail` emission is attributed to `/sky`, full stop. This is the fix
 * for the on-device stall where an in-place `selectTab` re-pointed
 * checkpointing at the NEW tab and then wrote lagging pathname emissions --
 * still reporting the OLD tab's route -- under the new tab's key, polluting the
 * slice and making the stall permanent. With derive-from-observed-pathname a
 * lagging emission is always filed under the tab it actually names.
 *
 * Two lifecycles feed this module:
 *
 *  - **Mount time.** The brownfield entry calls {@link configureNavRestore}
 *    once per mount, before the first render, then mounts at
 *    {@link resolveInitialLocation}.
 *  - **In-place tab change (single-root design).** With a persistent RN root
 *    (docs/single-root-tabs-experiment.md) the ACTIVE tab changes WITHOUT a
 *    remount: a `selectTab` bridge message drives the change in place. The
 *    handler ({@link applySelectTab}) ONLY resolves + navigates; it does NOT
 *    checkpoint. Attribution then follows the observed pathname: the root
 *    layout's NavStateGuard checkpoints both the per-tab slice
 *    ({@link checkpointNavPath}) and `nav:activeTab` ({@link checkpointActiveTab})
 *    from wherever the user actually IS once the navigation commits.
 *
 * Restore has two granularities, both keyed under {@link NAV_SLICE_PREFIX}:
 *
 *  - a per-tab slice `nav:<route>` holding that tab's last in-surface path
 *    (checkpointed continuously by the root layout's NavStateGuard via
 *    {@link checkpointNavPath}); resolved by {@link resolveTabPath}, and
 *  - a single `nav:activeTab` slice naming the currently selected tab, so a
 *    reload can recover the tab BEFORE resolving that tab's saved path.
 *
 * Only the PATH is restored, not full navigator state: expo-router rebuilds
 * the surrounding stack from the URL, which restores "the screen you were on"
 * with sane back behavior while keeping each slice tiny and skew-tolerant. The
 * TTL keeps a days-old resume from feeling haunted, and every read tolerates a
 * missing/malformed slice by falling back to the tab root / initialUrl.
 */
const NAV_SLICE_PREFIX = 'nav:';
const NAV_STATE_TTL_MS = 30 * 60 * 1000;

/** Slice naming the currently selected tab (see the module doc). */
const ACTIVE_TAB_KEY = NAV_SLICE_PREFIX + 'activeTab';

/**
 * The shell's persistent-root tab routes. This is the ONE place the known set
 * lives: the `selectTab` handler validates against it, checkpoint attribution
 * derives the owning tab from it, and the reload path only honors an
 * `activeTab` slice naming one of these. Exported for tests.
 */
export const KNOWN_TAB_ROUTES = ['/developer', '/sky', '/spinner'] as const;

export type TabRoute = (typeof KNOWN_TAB_ROUTES)[number];

/** Whether `route` is one of the known shell tab routes (see the skew note). */
export function isKnownTabRoute(route: string): route is TabRoute {
  return (KNOWN_TAB_ROUTES as readonly string[]).includes(route);
}

/**
 * The tab route that OWNS `path`: the known tab `t` such that `path === t` or
 * `path` is nested under it (`path.startsWith(t + '/')`), or null when no known
 * tab owns it. This is the single derivation rule shared by every checkpoint
 * and slice-ownership check -- attribution follows the observed pathname, never
 * a mutable "active surface" pointer. Exported for the TabSelectGuard readiness
 * check and for tests.
 */
export function tabForPath(path: string): TabRoute | null {
  for (const tab of KNOWN_TAB_ROUTES) {
    if (path === tab || path.startsWith(tab + '/')) return tab;
  }
  return null;
}

/** Minimal shape of a React Navigation state node we traverse (see below). */
export interface NavStateNode {
  key?: string;
  type?: string;
  routes?: { name?: string; state?: NavStateNode }[];
}

/**
 * The `state.key` of the live `'tab'` navigator that hosts the shell tabs
 * within a `getRootState()` tree, or undefined if it is not (yet) mounted.
 * Matched by route NAMES (the bare segment, e.g. `developer`) so it cannot
 * accidentally target some other tab navigator: every known shell tab name must
 * be present. TabSelectGuard uses this as its readiness+target signal for a
 * targeted JUMP_TO -- resolved fresh on every dispatch, since the key changes
 * across a navigator remount and must not be cached. Pure/undefined-safe so it
 * is unit-testable without a live navigator.
 */
export function findTabsStateKey(state: NavStateNode | undefined): string | undefined {
  if (!state || !Array.isArray(state.routes)) return undefined;
  if (state.type === 'tab') {
    const names = new Set(state.routes.map((route) => route.name));
    if (KNOWN_TAB_ROUTES.every((route) => names.has(route.slice(1)))) {
      return state.key;
    }
  }
  for (const route of state.routes) {
    const found = findTabsStateKey(route.state);
    if (found) return found;
  }
  return undefined;
}

// Module-global by design. With the single-root host there is still AT MOST
// ONE restore-enabled surface live per runtime (the one-ExpoRoot rule).
// `restoreEnabled` is latched once at mount by configureNavRestore and gates
// every checkpoint; pushed screens (which do not opt in) stay unaffected.
// There is deliberately NO module-global "active surface" pointer anymore --
// the owning tab of any path is DERIVED from the path itself (tabForPath).
let restoreEnabled = false;

/**
 * Whether THIS mount is the shell's tab surface (restoreNavState was passed).
 * TabSelectGuard uses it to decide if it should announce `tabsReady` to the
 * host: only the tab surface participates in the selectTab handshake; pushed
 * screens must not, or the host would re-post the shell tab underneath them.
 */
export function isNavRestoreEnabled(): boolean {
  return restoreEnabled;
}

interface NavSlice extends Record<string, unknown> {
  path: string;
  savedAt: number;
}

/** A slice is usable only if it has a non-empty path and is within the TTL. */
function isFreshSlice(slice: NavSlice | null): slice is NavSlice {
  if (!slice || typeof slice.path !== 'string' || slice.path.length === 0) return false;
  if (typeof slice.savedAt !== 'number' || Date.now() - slice.savedAt > NAV_STATE_TTL_MS) {
    return false;
  }
  return true;
}

/**
 * The route named by a fresh `activeTab` slice, or null. This override exists
 * SOLELY for Android's in-place OTA reload, which re-mounts JS reusing the
 * fragment's STALE mount-time `initialUrl`. To avoid hijacking a legitimately
 * fresh mount that targets a NEW tab (More -> Spinner, or the Android
 * NPE-fallback remount), it is honored ONLY when `mountedAt` is a finite number
 * AND the slice was saved AFTER these props were minted (`slice.savedAt >
 * mountedAt`) -- i.e. the user selected a tab after this mount's props existed,
 * which only happens on an in-place reload reusing stale props. Skew-tolerant:
 * a missing, stale, malformed, unknown-route, or not-after-mount slice yields
 * null so callers fall back to the mount-time initialUrl.
 */
function readActiveTabRoute(mountedAt: number | undefined): string | null {
  const slice = readHostSavedState<NavSlice>(ACTIVE_TAB_KEY);
  if (!isFreshSlice(slice)) return null;
  if (!isKnownTabRoute(slice.path)) return null;
  // Absent/non-finite mountedAt => initialUrl is authoritative (safe default).
  if (typeof mountedAt !== 'number' || !Number.isFinite(mountedAt)) return null;
  // The selection must POST-DATE these props to be an in-place reload signal.
  if (slice.savedAt <= mountedAt) return null;
  return slice.path;
}

/** Called by the brownfield entry per mount, before the first render. */
export function configureNavRestore(
  initialUrl: string | undefined,
  enabled: boolean,
): void {
  restoreEnabled = enabled && Boolean(initialUrl);
}

/**
 * Record which tab is now active, DERIVED from the observed `pathname`, so an
 * OTA reload -- which re-mounts JS with the fragment's stale mount-time
 * initialUrl -- can recover the user's actual tab before resolving its saved
 * path. Called by NavStateGuard on observed pathname changes (never from the
 * `selectTab` handler), so activeTab reflects where the user actually IS. The
 * slice stores the owning TAB route (not the full path). No-op unless restore
 * is enabled and the path names a known tab.
 */
export function checkpointActiveTab(pathname: string): void {
  if (!restoreEnabled) return;
  const tab = tabForPath(pathname);
  if (!tab) return;
  checkpointHostState(ACTIVE_TAB_KEY, {
    path: tab,
    savedAt: Date.now(),
  } satisfies NavSlice);
}

/**
 * Resolve a tab route to the path it should show: its saved in-surface path
 * when a fresh slice exists AND that slice's path is genuinely owned by this
 * tab (`slice.path === route` or nested under it), else the tab root. The
 * ownership check breaks the checkpoint feedback loop even against an
 * already-polluted store: a `/sky` slice that somehow holds `/developer` is
 * rejected rather than replayed. Shared by the mount path and the `selectTab`
 * handler so both apply identical slice+TTL+ownership rules.
 */
export function resolveTabPath(route: string): string {
  const slice = readHostSavedState<NavSlice>(NAV_SLICE_PREFIX + route);
  if (!isFreshSlice(slice)) return route;
  if (slice.path === route || slice.path.startsWith(route + '/')) return slice.path;
  return route;
}

/**
 * The location this surface should mount at. When restore is enabled, an
 * `activeTab` slice (if fresh, naming a known tab, and saved AFTER `mountedAt`
 * -- the in-place-reload signal) takes precedence over the mount-time
 * initialUrl; the chosen tab's saved path is then resolved. When `mountedAt` is
 * absent or the slice does not post-date it, `initialUrl` is authoritative --
 * so a fresh mount that legitimately targets a new tab is never hijacked back
 * to the old one. Surfaces that did NOT opt in (pushed screens) are returned
 * their initialUrl untouched.
 */
export function resolveInitialLocation(
  initialUrl: string | undefined,
  mountedAt?: number,
): string | undefined {
  if (!restoreEnabled || !initialUrl) return initialUrl;
  const baseRoute = readActiveTabRoute(mountedAt) ?? initialUrl;
  return resolveTabPath(baseRoute);
}

/**
 * Checkpoint an OBSERVED pathname into that path's owning tab slice. The owning
 * tab is DERIVED from the path (tabForPath), so a lagging emission is always
 * filed under the tab it names -- never under whatever tab was "selected" last.
 * No-op unless restore is enabled and the path names a known tab (e.g. a pushed
 * screen's route is skipped).
 */
export function checkpointNavPath(path: string): void {
  if (!restoreEnabled) return;
  const tab = tabForPath(path);
  if (!tab) return;
  checkpointHostState(NAV_SLICE_PREFIX + tab, {
    path,
    savedAt: Date.now(),
  } satisfies NavSlice);
}

/**
 * Handle a `selectTab` bridge message on the persistent RN root. Pure but for
 * the injected `navigate` (expo-router's `router.navigate`, dependency-injected
 * so the decision logic is testable without rendering). ONLY validates the
 * route, resolves the target path, and navigates -- attribution now derives
 * from the observed pathname (see NavStateGuard), so this does NOT checkpoint
 * or re-point anything. Ignores unknown routes (the skew guarantee). Returns
 * true when it drove a navigation.
 */
export function applySelectTab(route: string, navigate: (path: string) => void): boolean {
  if (!isKnownTabRoute(route)) return false;
  navigate(resolveTabPath(route));
  return true;
}
