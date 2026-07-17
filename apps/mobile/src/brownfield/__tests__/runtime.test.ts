import type { RequireContext } from 'expo-router/build/types';
import { describe, expect, it, vi } from 'vitest';

import { freshRouteContext, isBrownfieldHost, markBrownfieldHost } from '../runtime';

// The flag is process-global and set once (no reset hook by design), so these
// assertions run in order: default first, then after marking.
describe('brownfield runtime flag', () => {
  it('defaults to false (standalone / web)', () => {
    expect(isBrownfieldHost()).toBe(false);
  });

  it('reports true after markBrownfieldHost()', () => {
    markBrownfieldHost();
    expect(isBrownfieldHost()).toBe(true);
  });
});

describe('freshRouteContext', () => {
  function fakeContext(): RequireContext {
    const context = vi.fn((id: string) => `module:${id}`) as unknown as RequireContext;
    context.keys = vi.fn(() => ['./index.tsx', './terms.tsx']);
    context.resolve = vi.fn((id: string) => `resolved:${id}`);
    context.id = 'app-context';
    return context;
  }

  it('returns a new identity each call (expo-router keys its Android state restore on it)', () => {
    const context = fakeContext();
    const first = freshRouteContext(context);
    const second = freshRouteContext(context);
    expect(first).not.toBe(second);
    expect(first).not.toBe(context);
  });

  it('delegates module loading, keys, resolve, and id to the wrapped context', () => {
    const context = fakeContext();
    const fresh = freshRouteContext(context);
    expect(fresh('./terms.tsx')).toBe('module:./terms.tsx');
    expect(fresh.keys()).toEqual(['./index.tsx', './terms.tsx']);
    expect(fresh.resolve('./terms.tsx')).toBe('resolved:./terms.tsx');
    expect(fresh.id).toBe('app-context');
  });
});
