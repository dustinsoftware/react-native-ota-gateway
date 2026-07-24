import * as Updates from 'expo-updates';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendToNative } from '@/brownfield/message-bridge';
import { isBrownfieldHost } from '@/brownfield/runtime';

import { beginJourney, endJourney, resetJourneyLockForTests } from '../journey-lock';
import { reloadApp } from '../reload-app';

vi.mock('expo-updates', () => ({ reloadAsync: vi.fn() }));
vi.mock('@/brownfield/message-bridge', () => ({ sendToNative: vi.fn() }));
vi.mock('@/brownfield/runtime', () => ({ isBrownfieldHost: vi.fn() }));

const mockReload = vi.mocked(Updates.reloadAsync);
const mockSend = vi.mocked(sendToNative);
const mockIsBrownfieldHost = vi.mocked(isBrownfieldHost);

beforeEach(() => {
  vi.clearAllMocks();
  resetJourneyLockForTests();
});

describe('reloadApp', () => {
  it('posts a reload message to the native host when in a brownfield host', async () => {
    mockIsBrownfieldHost.mockReturnValue(true);

    await reloadApp();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({ type: 'reload' });
    // Must NOT call reloadAsync in brownfield -- it crashes the native host.
    expect(mockReload).not.toHaveBeenCalled();
  });

  it('falls back to expo-updates reloadAsync when not in a brownfield host', async () => {
    mockIsBrownfieldHost.mockReturnValue(false);

    await reloadApp();

    expect(mockReload).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('defers the restart while a journey is active, then fires it on idle', async () => {
    mockIsBrownfieldHost.mockReturnValue(true);
    beginJourney();

    await reloadApp();
    // Mid-journey: nothing restarts -- yanking the runtime would destroy the
    // in-flight flow. The reload is parked, not dropped.
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled();

    endJourney();
    // The parked reload re-enters reloadApp on idle and now goes through.
    expect(mockSend).toHaveBeenCalledWith({ type: 'reload' });
  });

  it('defers the standalone reloadAsync path too', async () => {
    mockIsBrownfieldHost.mockReturnValue(false);
    beginJourney();

    await reloadApp();
    expect(mockReload).not.toHaveBeenCalled();

    endJourney();
    expect(mockReload).toHaveBeenCalledTimes(1);
  });
});
