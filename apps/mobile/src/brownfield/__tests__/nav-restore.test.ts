import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkpointNavPath,
  configureNavRestore,
  resolveInitialLocation,
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
});
