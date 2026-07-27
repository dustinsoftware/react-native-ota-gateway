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
 * Two lifecycles feed this module:
 *
 *  - **Mount time.** The brownfield entry calls {@link configureNavRestore}
 *    once per mount, before the first render, then mounts at
 *    {@link resolveInitialLocation}.
 *  - **In-place tab change (single-root design).** With a persistent RN root
 *    (docs/single-root-tabs-experiment.md) the ACTIVE tab changes WITHOUT a
 *    remount: a `selectTab` bridge message drives the change in place. The
 *    handler re-points checkpointing at the new tab with
 *    {@link setActiveNavSurface} and records the choice via
 *    {@link checkpointActiveTab} so a later OTA reload (which re-mounts JS with
 *    the fragment's stale mount-time `initialUrl`) still lands on the tab the
 *    user actually selected.
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
 * lives: the `selectTab` handler validates against it, and the reload path
 * only honors an `activeTab` slice naming one of these. Exported for tests.
 */
export const KNOWN_TAB_ROUTES = ['/developer', '/sky', '/spinner'] as const;

export type TabRoute = (typeof KNOWN_TAB_ROUTES)[number];

/** Whether `route` is one of the known shell tab routes (see the skew note). */
export function isKnownTabRoute(route: string): route is TabRoute {
  return (KNOWN_TAB_ROUTES as readonly string[]).includes(route);
}

// Module-global by design. With the single-root host there is still AT MOST
// ONE restore-enabled surface live per runtime (the one-ExpoRoot rule); the
// active tab now moves WITHOUT a remount, so `surfaceInitialUrl` is re-pointed
// in place by setActiveNavSurface rather than assuming one configureNavRestore
// call per surface lifetime. `restoreEnabled` is still latched once at mount.
let restoreEnabled = false;
let surfaceInitialUrl: string | null = null;

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
 * The route named by a fresh `activeTab` slice, or null. Skew-tolerant: a
 * missing, stale, malformed, or unknown-route slice yields null so callers
 * fall back to the mount-time initialUrl.
 */
function readActiveTabRoute(): string | null {
  const slice = readHostSavedState<NavSlice>(ACTIVE_TAB_KEY);
  if (!isFreshSlice(slice)) return null;
  return isKnownTabRoute(slice.path) ? slice.path : null;
}

/** Called by the brownfield entry per mount, before the first render. */
export function configureNavRestore(
  initialUrl: string | undefined,
  enabled: boolean,
): void {
  surfaceInitialUrl = initialUrl ?? null;
  restoreEnabled = enabled && Boolean(initialUrl);
}

/**
 * Re-point which tab subsequent {@link checkpointNavPath} calls checkpoint
 * under, WITHOUT changing whether restore is enabled. Called by the `selectTab`
 * handler on an in-place tab change (the persistent root does not remount, so
 * configureNavRestore does not run again). No-op unless restore is enabled.
 */
export function setActiveNavSurface(initialUrl: string): void {
  if (!restoreEnabled) return;
  surfaceInitialUrl = initialUrl;
}

/**
 * Record which tab is now active, so an OTA reload -- which re-mounts JS with
 * the fragment's stale mount-time initialUrl -- can recover the user's actual
 * tab before resolving its saved path. No-op unless restore is enabled.
 */
export function checkpointActiveTab(route: string): void {
  if (!restoreEnabled) return;
  checkpointHostState(ACTIVE_TAB_KEY, {
    path: route,
    savedAt: Date.now(),
  } satisfies NavSlice);
}

/**
 * Resolve a tab route to the path it should show: its saved in-surface path
 * when a fresh slice exists, else the tab root. Shared by the mount path and
 * the `selectTab` handler so both apply identical slice+TTL rules.
 */
export function resolveTabPath(route: string): string {
  const slice = readHostSavedState<NavSlice>(NAV_SLICE_PREFIX + route);
  return isFreshSlice(slice) ? slice.path : route;
}

/**
 * The location this surface should mount at. When restore is enabled, an
 * `activeTab` slice (if fresh and naming a known tab) takes precedence over the
 * mount-time initialUrl -- this is what makes Android's in-place OTA reload
 * land on the tab the user selected rather than the fragment's stale initial
 * route -- and the chosen tab's saved path is then resolved. Surfaces that did
 * NOT opt in (pushed screens) are returned their initialUrl untouched.
 */
export function resolveInitialLocation(initialUrl: string | undefined): string | undefined {
  if (!restoreEnabled || !initialUrl) return initialUrl;
  const baseRoute = readActiveTabRoute() ?? initialUrl;
  return resolveTabPath(baseRoute);
}

/** Checkpoint the surface's current pathname (no-op unless opted in). */
export function checkpointNavPath(path: string): void {
  if (!restoreEnabled || !surfaceInitialUrl) return;
  checkpointHostState(NAV_SLICE_PREFIX + surfaceInitialUrl, {
    path,
    savedAt: Date.now(),
  } satisfies NavSlice);
}

/**
 * Handle a `selectTab` bridge message on the persistent RN root. Pure but for
 * the injected `navigate` (expo-router's `router.replace`, dependency-injected
 * so the decision logic is testable without rendering). Ignores unknown routes
 * (the skew guarantee). Returns true when it drove a navigation.
 */
export function applySelectTab(route: string, navigate: (path: string) => void): boolean {
  if (!isKnownTabRoute(route)) return false;
  // Resolve BEFORE re-pointing/checkpointing so the target reflects the
  // incoming tab's own saved slice.
  const target = resolveTabPath(route);
  checkpointActiveTab(route);
  setActiveNavSurface(route);
  navigate(target);
  return true;
}
