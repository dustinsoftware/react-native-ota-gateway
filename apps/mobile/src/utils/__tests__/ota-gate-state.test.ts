import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getGateStatus,
  resetGateForTesting,
  resolveGateOnce,
  subscribeGate,
} from '../ota-gate-state';

vi.mock('expo-updates', () => ({
  isEnabled: true,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  getItemAsync: vi.fn().mockResolvedValue(null),
}));

const mockCheck = vi.mocked(Updates.checkForUpdateAsync);
const mockGetItem = vi.mocked(SecureStore.getItemAsync);
const mockSetItem = vi.mocked(SecureStore.setItemAsync);

// attemptOtaUpdate reads the RN global __DEV__; define it for the node runner.
(globalThis as Record<string, unknown>).__DEV__ = false;

// Flush pending microtasks so the async gate resolution completes.
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetItem.mockResolvedValue(null);
  mockSetItem.mockResolvedValue(undefined);
  resetGateForTesting();
});

afterEach(() => {
  resetGateForTesting();
});

describe('ota-gate-state', () => {
  it('starts in loading and reaches ready after a stale-timestamp attempt', async () => {
    mockGetItem.mockResolvedValue(null); // never attempted -> stale
    mockCheck.mockResolvedValue({ isAvailable: false } as never);

    expect(getGateStatus()).toBe('loading');
    await resolveGateOnce();

    expect(getGateStatus()).toBe('ready');
    expect(mockCheck).toHaveBeenCalledOnce();
  });

  it('skips the attempt entirely when the timestamp is fresh', async () => {
    mockGetItem.mockResolvedValue(String(Date.now())); // fresh
    await resolveGateOnce();

    expect(getGateStatus()).toBe('ready');
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('reports checking while the attempt is in flight', async () => {
    mockGetItem.mockResolvedValue(null);
    let finishCheck!: (v: { isAvailable: boolean }) => void;
    mockCheck.mockReturnValue(
      new Promise((resolve) => {
        finishCheck = resolve;
      }) as never,
    );

    const done = resolveGateOnce();
    await flush();
    expect(getGateStatus()).toBe('checking');

    finishCheck({ isAvailable: false });
    await done;
    expect(getGateStatus()).toBe('ready');
  });

  it('is single-flight: concurrent callers share one attempt', async () => {
    mockGetItem.mockResolvedValue(null);
    mockCheck.mockResolvedValue({ isAvailable: false } as never);

    // Two mounts racing (e.g. fast tab switch during the first gate).
    const p1 = resolveGateOnce();
    const p2 = resolveGateOnce();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);

    // One timestamp read, one attempt, one timestamp save -- no duplicates.
    expect(mockGetItem).toHaveBeenCalledOnce();
    expect(mockCheck).toHaveBeenCalledOnce();
    expect(mockSetItem).toHaveBeenCalledOnce();
  });

  it('a caller arriving after resolution sees ready synchronously', async () => {
    mockGetItem.mockResolvedValue(null);
    mockCheck.mockResolvedValue({ isAvailable: false } as never);
    await resolveGateOnce();

    // Later mount in the same runtime: snapshot is ready before any effect
    // runs, and resolveGateOnce is a no-op returning the settled promise.
    expect(getGateStatus()).toBe('ready');
    await resolveGateOnce();
    expect(mockCheck).toHaveBeenCalledOnce();
  });

  it('notifies subscribers on checking and ready transitions', async () => {
    mockGetItem.mockResolvedValue(null);
    mockCheck.mockResolvedValue({ isAvailable: false } as never);

    const seen: string[] = [];
    const unsubscribe = subscribeGate(() => seen.push(getGateStatus()));

    await resolveGateOnce();
    expect(seen).toEqual(['checking', 'ready']);
    unsubscribe();
  });

  it('does not notify unsubscribed listeners (unmounted gate)', async () => {
    mockGetItem.mockResolvedValue(null);
    mockCheck.mockResolvedValue({ isAvailable: false } as never);

    const listener = vi.fn();
    const unsubscribe = subscribeGate(listener);
    unsubscribe();

    await resolveGateOnce();
    expect(listener).not.toHaveBeenCalled();
  });

  it('a mount can never be stranded: resolution mid-race still yields ready', async () => {
    // Regression for the render/effect race: mount A starts the gate, mount B
    // renders while unresolved, A's continuation resolves before B "reacts".
    // B's snapshot read after resolution must be ready with no further work.
    mockGetItem.mockResolvedValue(null);
    mockCheck.mockResolvedValue({ isAvailable: false } as never);

    const aPromise = resolveGateOnce(); // mount A kicks off the gate
    expect(getGateStatus()).toBe('loading'); // mount B renders here

    await aPromise; // A's continuation lands before B's effect

    // B's useSyncExternalStore re-reads the snapshot: ready, not stuck.
    expect(getGateStatus()).toBe('ready');
    await resolveGateOnce(); // B's effect is a harmless no-op
    expect(mockCheck).toHaveBeenCalledOnce();
  });

  it('fails open: an errored attempt still resolves to ready', async () => {
    mockGetItem.mockResolvedValue(null);
    mockCheck.mockRejectedValue(new Error('Network unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await resolveGateOnce();

    expect(getGateStatus()).toBe('ready');
    expect(warn).toHaveBeenCalledOnce();
    // Attempt-based policy: the timestamp is still saved on error.
    expect(mockSetItem).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
