import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applySelectTab,
  checkpointActiveTab,
  checkpointNavPath,
  configureNavRestore,
  isKnownTabRoute,
  KNOWN_TAB_ROUTES,
  resolveInitialLocation,
  resolveTabPath,
  tabForPath,
} from '../nav-restore';
import { hydrateHostSavedState } from '../host-state';
import { markBrownfieldHost } from '../runtime';

vi.mock('../message-bridge', () => ({
  sendToNative: vi.fn(),
}));

const { sendToNative } = await import('../message-bridge');

function hydrateNavSlice(key: string, slice: unknown): void {
  hydrateHostSavedState(JSON.stringify({ [`nav:${key}`]: slice }));
}

/** Hydrate the store with an arbitrary set of nav slices in one shot. */
function hydrateSlices(slices: Record<string, unknown>): void {
  hydrateHostSavedState(
    JSON.stringify(
      Object.fromEntries(Object.entries(slices).map(([k, v]) => [`nav:${k}`, v])),
    ),
  );
}

/**
 * The nav-restore seam's defensive branches are only reachable in unit tests
 * (Maestro cannot age a slice past the TTL or corrupt one): pin the opt-in
 * gating, the derive-from-observed-pathname attribution, the slice-ownership
 * pollution guard, and the `mountedAt` gating on the activeTab override.
 */
describe('nav-restore', () => {
  const NOW = 1_800_000_000_000;
  // Props minted 10 minutes ago -- the in-place OTA reload case, where the
  // user's later tab selection (savedAt closer to NOW) POST-DATES them.
  const STALE_PROPS_MOUNTED_AT = NOW - 10 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    hydrateHostSavedState(null);
    configureNavRestore(undefined, false);
  });

  it('returns initialUrl untouched when the surface did not opt in', () => {
    configureNavRestore('/developer', false);
    hydrateNavSlice('/developer', { path: '/developer/detail', savedAt: NOW - 1000 });
    expect(resolveInitialLocation('/developer')).toBe('/developer');
  });

  it('resumes the saved path for an opted-in surface with a fresh slice', () => {
    configureNavRestore('/developer', true);
    hydrateNavSlice('/developer', { path: '/developer/detail', savedAt: NOW - 1000 });
    expect(resolveInitialLocation('/developer')).toBe('/developer/detail');
  });

  it('falls back to initialUrl when the slice is past the 30-minute TTL', () => {
    configureNavRestore('/developer', true);
    hydrateNavSlice('/developer', { path: '/developer/detail', savedAt: NOW - 31 * 60 * 1000 });
    expect(resolveInitialLocation('/developer')).toBe('/developer');
  });

  it.each([
    ['missing path', { savedAt: 1 }],
    ['empty path', { path: '', savedAt: 1 }],
    ['non-numeric savedAt', { path: '/developer/detail', savedAt: 'yesterday' }],
    ['non-object slice', 'garbage'],
  ])('falls back to initialUrl on a malformed slice (%s)', (_label, slice) => {
    configureNavRestore('/developer', true);
    hydrateNavSlice('/developer', slice);
    expect(resolveInitialLocation('/developer')).toBe('/developer');
  });

  it('opting in without an initialUrl stays disabled', () => {
    configureNavRestore(undefined, true);
    expect(resolveInitialLocation(undefined)).toBeUndefined();
  });

  describe('known tab routes', () => {
    it('exposes exactly the three shell tabs', () => {
      expect(KNOWN_TAB_ROUTES).toEqual(['/developer', '/sky', '/spinner']);
    });

    it('isKnownTabRoute accepts known routes and rejects anything else', () => {
      expect(isKnownTabRoute('/sky')).toBe(true);
      expect(isKnownTabRoute('/developer')).toBe(true);
      expect(isKnownTabRoute('/nope')).toBe(false);
      expect(isKnownTabRoute('/sky/deep')).toBe(false);
      expect(isKnownTabRoute('')).toBe(false);
    });
  });

  describe('tabForPath', () => {
    it('maps a tab root and nested paths to the owning tab', () => {
      expect(tabForPath('/sky')).toBe('/sky');
      expect(tabForPath('/sky/detail')).toBe('/sky');
      expect(tabForPath('/developer/settings/theme')).toBe('/developer');
    });

    it('returns null for a path no known tab owns', () => {
      expect(tabForPath('/test-one')).toBeNull();
      // A prefix that is not a segment boundary must NOT match.
      expect(tabForPath('/skywalker')).toBeNull();
      expect(tabForPath('')).toBeNull();
    });
  });

  describe('checkpointNavPath (derive-from-observed-pathname)', () => {
    it('is a no-op unless opted in, and writes the derived-tab slice when it is', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', false);
      checkpointNavPath('/developer/detail');
      expect(sendToNative).not.toHaveBeenCalled();

      configureNavRestore('/developer', true);
      checkpointNavPath('/developer/detail');
      expect(sendToNative).toHaveBeenCalledWith({
        type: 'saveState',
        key: 'nav:/developer',
        state: { path: '/developer/detail', savedAt: NOW },
      });
    });

    it('derives the owning tab from the PATH, not the mount route', () => {
      markBrownfieldHost();
      // Mounted as /developer, but the observed pathname names /sky: the slice
      // is filed under /sky. This is the fix for the polluted-slice stall.
      configureNavRestore('/developer', true);
      checkpointNavPath('/sky/detail');
      expect(sendToNative).toHaveBeenCalledWith({
        type: 'saveState',
        key: 'nav:/sky',
        state: { path: '/sky/detail', savedAt: NOW },
      });
    });

    it('no-ops when the path names no known tab (e.g. a pushed screen)', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);
      checkpointNavPath('/test-one');
      expect(sendToNative).not.toHaveBeenCalled();
    });
  });

  describe('checkpointActiveTab (derive-from-observed-pathname)', () => {
    it('writes the owning tab under nav:activeTab, no-op unless opted in', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', false);
      checkpointActiveTab('/sky/detail');
      expect(sendToNative).not.toHaveBeenCalled();

      configureNavRestore('/developer', true);
      checkpointActiveTab('/sky/detail');
      expect(sendToNative).toHaveBeenCalledWith({
        type: 'saveState',
        key: 'nav:activeTab',
        state: { path: '/sky', savedAt: NOW },
      });
    });

    it('no-ops when the observed path names no known tab', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);
      checkpointActiveTab('/test-one');
      expect(sendToNative).not.toHaveBeenCalled();
    });
  });

  describe('resolveTabPath', () => {
    it('returns the saved path for a fresh, owned slice, else the tab root', () => {
      hydrateNavSlice('/sky', { path: '/sky/deep', savedAt: NOW - 1000 });
      expect(resolveTabPath('/sky')).toBe('/sky/deep');
      // Same TTL/fallback rules as resolveInitialLocation.
      hydrateNavSlice('/sky', { path: '/sky/deep', savedAt: NOW - 31 * 60 * 1000 });
      expect(resolveTabPath('/sky')).toBe('/sky');
      hydrateHostSavedState(null);
      expect(resolveTabPath('/spinner')).toBe('/spinner');
    });

    it('falls back to the tab root on a malformed slice', () => {
      hydrateNavSlice('/sky', { path: '', savedAt: NOW });
      expect(resolveTabPath('/sky')).toBe('/sky');
    });

    it('rejects a fresh slice whose path is NOT owned by the tab (pollution guard)', () => {
      // A foreign root written under this tab's key (the reviewed on-device
      // bug): replaying it would re-stall. Ownership rejects it.
      hydrateNavSlice('/spinner', { path: '/developer', savedAt: NOW - 1000 });
      expect(resolveTabPath('/spinner')).toBe('/spinner');
      // Even a foreign NESTED path is rejected.
      hydrateNavSlice('/spinner', { path: '/sky/deep', savedAt: NOW - 1000 });
      expect(resolveTabPath('/spinner')).toBe('/spinner');
      // And a non-boundary prefix ('/spinnerx' is not '/spinner/...').
      hydrateNavSlice('/spinner', { path: '/spinnerx', savedAt: NOW - 1000 });
      expect(resolveTabPath('/spinner')).toBe('/spinner');
    });
  });

  describe('activeTab override (single persistent root reload) + mountedAt gating', () => {
    it('a fresh activeTab slice saved AFTER mountedAt wins over initialUrl', () => {
      configureNavRestore('/developer', true);
      hydrateSlices({
        activeTab: { path: '/spinner', savedAt: NOW - 1000 },
        '/spinner': { path: '/spinner', savedAt: NOW - 1000 },
      });
      // In-place reload: props are stale (minted 10 min ago); the user selected
      // /spinner more recently, so the selection post-dates the props.
      expect(resolveInitialLocation('/developer', STALE_PROPS_MOUNTED_AT)).toBe('/spinner');
    });

    it('prefers the activeTab tab AND its own saved deep path', () => {
      configureNavRestore('/developer', true);
      hydrateSlices({
        activeTab: { path: '/sky', savedAt: NOW - 1000 },
        '/sky': { path: '/sky/deep', savedAt: NOW - 1000 },
      });
      expect(resolveInitialLocation('/developer', STALE_PROPS_MOUNTED_AT)).toBe('/sky/deep');
    });

    it('IGNORES the activeTab slice on a fresh mount (selection predates mountedAt)', () => {
      // Fresh mount legitimately targeting a NEW tab (More -> Spinner, or the
      // Android NPE-fallback remount): props minted NOW, the old selection
      // predates them, so initialUrl must win -- no hijack back to /developer.
      configureNavRestore('/spinner', true);
      hydrateSlices({ activeTab: { path: '/developer', savedAt: NOW - 1000 } });
      expect(resolveInitialLocation('/spinner', NOW)).toBe('/spinner');
    });

    it('IGNORES the activeTab slice when mountedAt is absent (safe default)', () => {
      configureNavRestore('/spinner', true);
      hydrateSlices({ activeTab: { path: '/developer', savedAt: NOW - 1000 } });
      expect(resolveInitialLocation('/spinner')).toBe('/spinner');
    });

    it('falls back to initialUrl when the activeTab slice is stale', () => {
      configureNavRestore('/developer', true);
      hydrateSlices({ activeTab: { path: '/spinner', savedAt: NOW - 31 * 60 * 1000 } });
      expect(resolveInitialLocation('/developer', STALE_PROPS_MOUNTED_AT)).toBe('/developer');
    });

    it('falls back to initialUrl when the activeTab slice names an unknown route', () => {
      configureNavRestore('/developer', true);
      hydrateSlices({ activeTab: { path: '/nope', savedAt: NOW - 1000 } });
      expect(resolveInitialLocation('/developer', STALE_PROPS_MOUNTED_AT)).toBe('/developer');
    });

    it.each([
      ['missing path', { savedAt: 1 }],
      ['non-object', 'garbage'],
    ])('falls back to initialUrl on a malformed activeTab slice (%s)', (_label, slice) => {
      configureNavRestore('/developer', true);
      hydrateSlices({ activeTab: slice });
      expect(resolveInitialLocation('/developer', STALE_PROPS_MOUNTED_AT)).toBe('/developer');
    });

    it('does NOT consult the activeTab slice for surfaces that did not opt in', () => {
      configureNavRestore('/test-one', false);
      hydrateSlices({ activeTab: { path: '/spinner', savedAt: NOW - 1000 } });
      // Pushed screens must be completely unaffected.
      expect(resolveInitialLocation('/test-one', STALE_PROPS_MOUNTED_AT)).toBe('/test-one');
    });
  });

  describe('applySelectTab', () => {
    it('ignores an unknown route: no navigation', () => {
      configureNavRestore('/developer', true);
      const navigate = vi.fn();

      expect(applySelectTab('/nope', navigate)).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('navigates to the tab root when the target has no saved slice', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);
      const navigate = vi.fn();

      expect(applySelectTab('/spinner', navigate)).toBe(true);
      expect(navigate).toHaveBeenCalledWith('/spinner');
    });

    it('does NOT checkpoint (attribution derives from the observed pathname)', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);

      applySelectTab('/spinner', vi.fn());
      expect(sendToNative).not.toHaveBeenCalled();
    });

    it("resolves the incoming tab's own saved deep path", () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);
      hydrateNavSlice('/sky', { path: '/sky/deep', savedAt: NOW - 1000 });
      const navigate = vi.fn();

      applySelectTab('/sky', navigate);
      expect(navigate).toHaveBeenCalledWith('/sky/deep');
    });
  });
});
