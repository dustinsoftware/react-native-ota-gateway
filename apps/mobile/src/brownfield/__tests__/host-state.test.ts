import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkpointHostState,
  readHostSavedState,
  setHostSavedState,
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
    setHostSavedState(null);
  });

  it('reads back a slice from host-injected JSON', () => {
    setHostSavedState('{"spinner":{"angle":1.5,"velocity":-3.2}}');
    expect(readHostSavedState('spinner')).toEqual({ angle: 1.5, velocity: -3.2 });
  });

  it('returns null for a missing slice', () => {
    setHostSavedState('{"spinner":{"angle":1}}');
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
    setHostSavedState('{"spinner":{"angle":1}}');
    setHostSavedState(json as string | null | undefined);
    expect(readHostSavedState('spinner')).toBeNull();
  });

  it('does not post checkpoints outside a brownfield host', () => {
    checkpointHostState('spinner', { angle: 1, velocity: 2 });
    expect(sendToNative).not.toHaveBeenCalled();
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
});
