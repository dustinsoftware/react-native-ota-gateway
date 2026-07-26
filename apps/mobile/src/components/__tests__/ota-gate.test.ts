import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { attemptOtaUpdate } from '../../utils/attempt-ota-update';
import { isOtaStale } from '../../utils/ota-timestamp';

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
const mockFetch = vi.mocked(Updates.fetchUpdateAsync);
const mockReload = vi.mocked(Updates.reloadAsync);
const mockSetItem = vi.mocked(SecureStore.setItemAsync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('attemptOtaUpdate', () => {
  it('returns no-update immediately when __DEV__ is true', async () => {
    const g = globalThis as Record<string, unknown>;
    const original = g.__DEV__;
    g.__DEV__ = true;

    const result = await attemptOtaUpdate();

    expect(result).toEqual({ outcome: 'no-update' });
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();

    g.__DEV__ = original;
  });

  it('returns no-update immediately when Updates is disabled', async () => {
    const original = Updates.isEnabled;
    Object.defineProperty(Updates, 'isEnabled', { value: false, writable: true });

    const result = await attemptOtaUpdate();

    expect(result).toEqual({ outcome: 'no-update' });
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();

    Object.defineProperty(Updates, 'isEnabled', { value: original, writable: true });
  });

  it('downloads and reloads when an update is available', async () => {
    mockCheck.mockResolvedValue({ isAvailable: true } as never);
    mockFetch.mockResolvedValue({} as never);
    mockReload.mockResolvedValue(undefined as never);

    const result = await attemptOtaUpdate();

    expect(mockCheck).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockReload).toHaveBeenCalledOnce();
    expect(result).toEqual({ outcome: 'reloading' });
  });

  it('saves timestamp before reloading', async () => {
    mockCheck.mockResolvedValue({ isAvailable: true } as never);
    mockFetch.mockResolvedValue({} as never);
    mockReload.mockResolvedValue(undefined as never);

    await attemptOtaUpdate();

    expect(mockSetItem).toHaveBeenCalledOnce();
    expect(mockSetItem.mock.calls[0][0]).toBe('ota_gateway_last_updated');
    // Timestamp should be saved before reload
    const callOrder = [mockSetItem, mockReload].map(
      (fn) => fn.mock.invocationCallOrder[0],
    );
    expect(callOrder[0]).toBeLessThan(callOrder[1]);
  });

  it('returns no-update and saves timestamp when already latest', async () => {
    mockCheck.mockResolvedValue({ isAvailable: false } as never);

    const result = await attemptOtaUpdate();

    expect(mockCheck).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledOnce();
    expect(result).toEqual({ outcome: 'no-update' });
  });

  it('returns error with message when check fails', async () => {
    mockCheck.mockRejectedValue(new Error('Network unavailable'));

    const result = await attemptOtaUpdate();

    expect(result).toEqual({
      outcome: 'error',
      message: 'Network unavailable',
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled();
    // Timestamp is saved at attempt start, before the failing check.
    expect(mockSetItem).toHaveBeenCalledOnce();
  });

  it('saves timestamp at attempt start even when the check throws', async () => {
    mockCheck.mockRejectedValue(new Error('Network unavailable'));

    const result = await attemptOtaUpdate();

    expect(result.outcome).toBe('error');
    expect(mockSetItem).toHaveBeenCalledOnce();
    expect(mockSetItem.mock.calls[0][0]).toBe('ota_gateway_last_updated');
  });

  it('returns error with message when fetch fails', async () => {
    mockCheck.mockResolvedValue({ isAvailable: true } as never);
    mockFetch.mockRejectedValue(new Error('Download failed'));

    const result = await attemptOtaUpdate();

    expect(result).toEqual({
      outcome: 'error',
      message: 'Download failed',
    });
    expect(mockReload).not.toHaveBeenCalled();
    // Timestamp is saved at attempt start, regardless of outcome.
    expect(mockSetItem).toHaveBeenCalledOnce();
  });

  it('returns error with message when reload fails', async () => {
    mockCheck.mockResolvedValue({ isAvailable: true } as never);
    mockFetch.mockResolvedValue({} as never);
    mockReload.mockRejectedValue(new Error('Reload failed'));

    const result = await attemptOtaUpdate();

    expect(result).toEqual({
      outcome: 'error',
      message: 'Reload failed',
    });
  });

  it('handles non-Error throws gracefully', async () => {
    mockCheck.mockRejectedValue('string error');

    const result = await attemptOtaUpdate();

    expect(result).toEqual({
      outcome: 'error',
      message: 'Unknown error',
    });
  });
});

describe('isOtaStale', () => {
  const NOW = 1_700_000_000_000;
  const ONE_DAY_MS = 86_400_000;

  it('returns true when timestamp is null', () => {
    expect(isOtaStale(null, 7, NOW)).toBe(true);
  });

  it('returns true when timestamp is older than maxAgeDays', () => {
    const eightDaysAgo = NOW - 8 * ONE_DAY_MS;
    expect(isOtaStale(eightDaysAgo, 7, NOW)).toBe(true);
  });

  it('returns false when timestamp is within maxAgeDays', () => {
    const sixDaysAgo = NOW - 6 * ONE_DAY_MS;
    expect(isOtaStale(sixDaysAgo, 7, NOW)).toBe(false);
  });

  it('returns true when timestamp is exactly maxAgeDays + 1ms old', () => {
    const exactlyStale = NOW - 7 * ONE_DAY_MS - 1;
    expect(isOtaStale(exactlyStale, 7, NOW)).toBe(true);
  });

  it('returns false when timestamp equals the boundary', () => {
    const exactBoundary = NOW - 7 * ONE_DAY_MS;
    expect(isOtaStale(exactBoundary, 7, NOW)).toBe(false);
  });

  it('returns false when timestamp is now', () => {
    expect(isOtaStale(NOW, 7, NOW)).toBe(false);
  });

  // The OtaGate ships maxAgeDays=1 (the "over 24h" gate); pin that exact boundary.
  it('is not stale at exactly 24h old (maxAgeDays=1 boundary)', () => {
    expect(isOtaStale(NOW - ONE_DAY_MS, 1, NOW)).toBe(false);
  });

  it('is stale at 24h + 1ms old (maxAgeDays=1)', () => {
    expect(isOtaStale(NOW - ONE_DAY_MS - 1, 1, NOW)).toBe(true);
  });

  it('is not stale at 23h59m old (maxAgeDays=1)', () => {
    expect(isOtaStale(NOW - (ONE_DAY_MS - 60_000), 1, NOW)).toBe(false);
  });
});
