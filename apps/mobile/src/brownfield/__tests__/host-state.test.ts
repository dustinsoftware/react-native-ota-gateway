import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkpointHostState,
  readHostSavedState,
  hydrateHostSavedState,
} from '../host-state';
import { markBrownfieldHost } from '../runtime';

vi.mock('../message-bridge', () => ({
  sendToNative: vi.fn(),
}));

const { sendToNative } = await import('../message-bridge');

/**
 * The native store round-trip: the host injects savedStateJson (untrusted
 * serialization boundary -- must never crash on garbage), components read
 * their slice, and checkpoints only leave the process under a brownfield host.
 */
describe('host-state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hydrateHostSavedState(null);
  });

  it('reads back a slice from host-injected JSON', () => {
    hydrateHostSavedState('{"spinner":{"angle":1.5,"velocity":-3.2}}');
    expect(readHostSavedState('spinner')).toEqual({ angle: 1.5, velocity: -3.2 });
  });

  it('keeps slices independent (multiple keys hydrate and read back)', () => {
    hydrateHostSavedState('{"spinner":{"angle":1},"test-one-counter":{"count":3}}');
    expect(readHostSavedState('spinner')).toEqual({ angle: 1 });
    expect(readHostSavedState('test-one-counter')).toEqual({ count: 3 });
  });

  it('returns null for a missing slice', () => {
    hydrateHostSavedState('{"spinner":{"angle":1}}');
    expect(readHostSavedState('other')).toBeNull();
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['a JSON array', '[1,2]'],
    ['a JSON scalar', '42'],
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
  ])('treats %s as no saved state instead of crashing', (_label, json) => {
    hydrateHostSavedState('{"spinner":{"angle":1}}');
    hydrateHostSavedState(json as string | null | undefined);
    expect(readHostSavedState('spinner')).toBeNull();
  });

  it('does not post checkpoints outside a brownfield host', () => {
    checkpointHostState('spinner', { angle: 1, velocity: 2 });
    expect(sendToNative).not.toHaveBeenCalled();
  });

  it('refuses checkpoints carrying secret-shaped keys or field names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      markBrownfieldHost();
      checkpointHostState('session-token', { value: 'x' });
      checkpointHostState('draft', { nested: { cardNumber: '4111' } });
      checkpointHostState('draft', { password: 'hunter2' });
      expect(sendToNative).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses secrets nested inside arrays', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      markBrownfieldHost();
      checkpointHostState('draft', { items: [{ cardNumber: '4111' }] });
      expect(sendToNative).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a cyclic state object instead of hanging or throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      markBrownfieldHost();
      const cyclic: Record<string, unknown> = { value: 1 };
      cyclic.self = cyclic;
      expect(() => checkpointHostState('cyclic', cyclic)).not.toThrow();
      expect(sendToNative).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not JSON-serializable'));
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses oversized slices instead of bloating the injection channel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      markBrownfieldHost();
      checkpointHostState('big', { blob: 'x'.repeat(17 * 1024) });
      expect(sendToNative).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('slice ceiling'));
    } finally {
      warn.mockRestore();
    }
  });

  it('posts a saveState message once running under a brownfield host', () => {
    // Module-global and deliberately one-way, like runtime.test.ts.
    markBrownfieldHost();
    checkpointHostState('spinner', { angle: 1, velocity: 2 });
    expect(sendToNative).toHaveBeenCalledWith({
      type: 'saveState',
      key: 'spinner',
      state: { angle: 1, velocity: 2 },
    });
  });

  it('an accepted checkpoint updates the in-memory store so same-session reads see it', () => {
    markBrownfieldHost();
    hydrateHostSavedState('{"spinner":{"angle":1,"velocity":0}}');
    // Overwrite an existing slice: a later read must see the NEW value, not the
    // mount-time snapshot (the host only re-injects on the next surface mount).
    checkpointHostState('spinner', { angle: 9, velocity: 2 });
    expect(readHostSavedState('spinner')).toEqual({ angle: 9, velocity: 2 });
    // A brand-new key becomes readable immediately too.
    checkpointHostState('nav:/sky', { path: '/sky/deep', savedAt: 1 });
    expect(readHostSavedState('nav:/sky')).toEqual({ path: '/sky/deep', savedAt: 1 });
  });

  it('a REFUSED checkpoint does not update the in-memory store', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      markBrownfieldHost();
      hydrateHostSavedState('{"draft":{"ok":1}}');
      // Secret-shaped field -> refused; the in-memory value must be untouched.
      checkpointHostState('draft', { password: 'hunter2' });
      expect(readHostSavedState('draft')).toEqual({ ok: 1 });
      // Oversized -> refused; likewise untouched.
      checkpointHostState('draft', { blob: 'x'.repeat(17 * 1024) });
      expect(readHostSavedState('draft')).toEqual({ ok: 1 });
    } finally {
      warn.mockRestore();
    }
  });
});
