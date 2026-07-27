import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applySelectTab,
  checkpointNavPath,
  configureNavRestore,
  isKnownTabRoute,
  KNOWN_TAB_ROUTES,
  resolveInitialLocation,
  resolveTabPath,
  setActiveNavSurface,
} from '../nav-restore';
import { hydrateHostSavedState } from '../host-state';
import { markBrownfieldHost } from '../runtime';

vi.mock('../message-bridge', () => ({
  sendToNative: vi.fn(),
}));

const { sendToNative } = await import('../message-bridge');

function hydrateNavSlice(initialUrl: string, slice: unknown): void {
  hydrateHostSavedState(JSON.stringify({ [`nav:${initialUrl}`]: slice }));
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
 * gating, the resolve fallbacks, and the checkpoint slice shape.
 */
describe('nav-restore', () => {
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    hydrateHostSavedState(null);
    configureNavRestore(undefined, false);
  });

  it('returns initialUrl untouched when the surface did not opt in', () => {
    configureNavRestore('/developer', false);
    hydrateNavSlice('/developer', { path: '/test-one', savedAt: NOW - 1000 });
    expect(resolveInitialLocation('/developer')).toBe('/developer');
  });

  it('resumes the saved path for an opted-in surface with a fresh slice', () => {
    configureNavRestore('/developer', true);
    hydrateNavSlice('/developer', { path: '/test-one', savedAt: NOW - 1000 });
    expect(resolveInitialLocation('/developer')).toBe('/test-one');
  });

  it('falls back to initialUrl when the slice is past the 30-minute TTL', () => {
    configureNavRestore('/developer', true);
    hydrateNavSlice('/developer', { path: '/test-one', savedAt: NOW - 31 * 60 * 1000 });
    expect(resolveInitialLocation('/developer')).toBe('/developer');
  });

  it.each([
    ['missing path', { savedAt: 1 }],
    ['empty path', { path: '', savedAt: 1 }],
    ['non-numeric savedAt', { path: '/test-one', savedAt: 'yesterday' }],
    ['non-object slice', 'garbage'],
  ])('falls back to initialUrl on a malformed slice (%s)', (_label, slice) => {
    configureNavRestore('/developer', true);
    hydrateNavSlice('/developer', slice);
    expect(resolveInitialLocation('/developer')).toBe('/developer');
  });

  it('checkpointNavPath is a no-op unless opted in, and writes the keyed slice when it is', () => {
    markBrownfieldHost();
    configureNavRestore('/developer', false);
    checkpointNavPath('/test-one');
    expect(sendToNative).not.toHaveBeenCalled();

    configureNavRestore('/developer', true);
    checkpointNavPath('/test-one');
    expect(sendToNative).toHaveBeenCalledWith({
      type: 'saveState',
      key: 'nav:/developer',
      state: { path: '/test-one', savedAt: NOW },
    });
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
      expect(isKnownTabRoute('/test-one')).toBe(false);
      expect(isKnownTabRoute('')).toBe(false);
    });
  });

  describe('resolveTabPath', () => {
    it('returns the saved path for a fresh slice, else the tab root', () => {
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
  });

  describe('activeTab slice preference (single persistent root reload)', () => {
    it('a fresh activeTab slice wins over initialUrl, then resolves that tab path', () => {
      configureNavRestore('/developer', true);
      hydrateSlices({
        activeTab: { path: '/spinner', savedAt: NOW - 1000 },
        '/spinner': { path: '/spinner', savedAt: NOW - 1000 },
      });
      // Reload re-mounts with the stale mount-time initialUrl (/developer) but
      // the activeTab slice points at the tab the user actually selected.
      expect(resolveInitialLocation('/developer')).toBe('/spinner');
    });

    it('prefers the activeTab tab AND its own saved deep path', () => {
      configureNavRestore('/developer', true);
      hydrateSlices({
        activeTab: { path: '/sky', savedAt: NOW - 1000 },
        '/sky': { path: '/sky/deep', savedAt: NOW - 1000 },
      });
      expect(resolveInitialLocation('/developer')).toBe('/sky/deep');
    });

    it('falls back to initialUrl when the activeTab slice is stale', () => {
      configureNavRestore('/developer', true);
      hydrateSlices({ activeTab: { path: '/spinner', savedAt: NOW - 31 * 60 * 1000 } });
      expect(resolveInitialLocation('/developer')).toBe('/developer');
    });

    it('falls back to initialUrl when the activeTab slice names an unknown route', () => {
      configureNavRestore('/developer', true);
      hydrateSlices({ activeTab: { path: '/nope', savedAt: NOW - 1000 } });
      expect(resolveInitialLocation('/developer')).toBe('/developer');
    });

    it.each([
      ['missing path', { savedAt: 1 }],
      ['non-object', 'garbage'],
    ])('falls back to initialUrl on a malformed activeTab slice (%s)', (_label, slice) => {
      configureNavRestore('/developer', true);
      hydrateSlices({ activeTab: slice });
      expect(resolveInitialLocation('/developer')).toBe('/developer');
    });

    it('does NOT consult the activeTab slice for surfaces that did not opt in', () => {
      configureNavRestore('/test-one', false);
      hydrateSlices({ activeTab: { path: '/spinner', savedAt: NOW - 1000 } });
      // Pushed screens must be completely unaffected.
      expect(resolveInitialLocation('/test-one')).toBe('/test-one');
    });
  });

  describe('setActiveNavSurface', () => {
    it('re-points checkpointNavPath at the new tab without a remount', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);

      setActiveNavSurface('/spinner');
      checkpointNavPath('/spinner');
      expect(sendToNative).toHaveBeenCalledWith({
        type: 'saveState',
        key: 'nav:/spinner',
        state: { path: '/spinner', savedAt: NOW },
      });
    });

    it('is a no-op when restore is disabled (pushed screens)', () => {
      markBrownfieldHost();
      configureNavRestore('/test-one', false);

      setActiveNavSurface('/spinner');
      checkpointNavPath('/spinner');
      expect(sendToNative).not.toHaveBeenCalled();
    });
  });

  describe('applySelectTab', () => {
    it('ignores an unknown route: no navigation, no checkpoint', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);
      const navigate = vi.fn();

      expect(applySelectTab('/nope', navigate)).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
      expect(sendToNative).not.toHaveBeenCalled();
    });

    it('navigates to the tab root and checkpoints the activeTab slice', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);
      const navigate = vi.fn();

      expect(applySelectTab('/spinner', navigate)).toBe(true);
      expect(navigate).toHaveBeenCalledWith('/spinner');
      expect(sendToNative).toHaveBeenCalledWith({
        type: 'saveState',
        key: 'nav:activeTab',
        state: { path: '/spinner', savedAt: NOW },
      });
    });

    it("resolves the incoming tab's own saved deep path", () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);
      hydrateNavSlice('/sky', { path: '/sky/deep', savedAt: NOW - 1000 });
      const navigate = vi.fn();

      applySelectTab('/sky', navigate);
      expect(navigate).toHaveBeenCalledWith('/sky/deep');
    });

    it('re-points subsequent checkpointNavPath calls to the selected tab', () => {
      markBrownfieldHost();
      configureNavRestore('/developer', true);
      const navigate = vi.fn();

      applySelectTab('/spinner', navigate);
      vi.mocked(sendToNative).mockClear();
      checkpointNavPath('/spinner/settings');
      expect(sendToNative).toHaveBeenCalledWith({
        type: 'saveState',
        key: 'nav:/spinner',
        state: { path: '/spinner/settings', savedAt: NOW },
      });
    });
  });
});
