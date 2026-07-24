import { checkpointHostState, readHostSavedState } from './host-state';

/**
 * Per-surface navigation restoration over the host-state seam.
 *
 * freshRouteContext deliberately resets a remounted surface to its
 * `initialUrl` (see runtime.ts) -- correct for pushed screens, but a UX
 * regression for SHELL TABS once tabs hold deep in-surface navigation: every
 * Android tab switch recreates the activity, dropping the user back to the
 * tab's root. Hosts opt a surface in by passing `restoreNavState: true` in
 * initial properties (tab mounts only; pushed screens stay fresh-by-design),
 * and the entry then:
 *
 *  - checkpoints the surface's current pathname (keyed by its initialUrl)
 *    whenever it changes ({@link checkpointNavPath}, mounted via the root
 *    layout's NavStateGuard), and
 *  - resolves the mount location to the saved path when a fresh-enough slice
 *    exists ({@link resolveInitialLocation}).
 *
 * Only the PATH is restored, not full navigator state: expo-router rebuilds
 * the surrounding stack from the URL, which restores "the screen you were on"
 * with sane back behavior while keeping the slice tiny and skew-tolerant. The
 * TTL keeps a days-old resume from feeling haunted.
 */
const NAV_SLICE_PREFIX = 'nav:';
const NAV_STATE_TTL_MS = 30 * 60 * 1000;

// Module-global on purpose: the hosts mount AT MOST ONE RN surface per shared
// runtime (the one-ExpoRoot rule), so exactly one configureNavRestore call is
// live at a time. A future host keeping two restore-enabled surfaces warm
// concurrently would clobber this state -- revisit the design before ever
// relaxing that invariant.
let restoreEnabled = false;
let surfaceInitialUrl: string | null = null;

interface NavSlice extends Record<string, unknown> {
  path: string;
  savedAt: number;
}

/** Called by the brownfield entry per mount, before the first render. */
export function configureNavRestore(
  initialUrl: string | undefined,
  enabled: boolean,
): void {
  surfaceInitialUrl = initialUrl ?? null;
  restoreEnabled = enabled && Boolean(initialUrl);
}

/** The location this surface should mount at: the saved path, or initialUrl. */
export function resolveInitialLocation(initialUrl: string | undefined): string | undefined {
  if (!restoreEnabled || !initialUrl) return initialUrl;
  const slice = readHostSavedState<NavSlice>(NAV_SLICE_PREFIX + initialUrl);
  if (!slice || typeof slice.path !== 'string' || slice.path.length === 0) return initialUrl;
  if (typeof slice.savedAt !== 'number' || Date.now() - slice.savedAt > NAV_STATE_TTL_MS) {
    return initialUrl;
  }
  return slice.path;
}

/** Checkpoint the surface's current pathname (no-op unless opted in). */
export function checkpointNavPath(path: string): void {
  if (!restoreEnabled || !surfaceInitialUrl) return;
  checkpointHostState(NAV_SLICE_PREFIX + surfaceInitialUrl, {
    path,
    savedAt: Date.now(),
  } satisfies NavSlice);
}
