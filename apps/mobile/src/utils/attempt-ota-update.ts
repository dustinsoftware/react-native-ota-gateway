import * as Updates from 'expo-updates';

import { reloadApp } from './reload-app';
import { saveOtaTimestamp } from './ota-timestamp';

export type OtaResult =
  | { outcome: 'reloading' }
  | { outcome: 'no-update' }
  | { outcome: 'error'; message: string };

const CHECK_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Checks for an OTA update, downloads it, and reloads. Returns the outcome.
 * Saves the current timestamp on success so the staleness timer resets.
 *
 * - `reloading`: update found, downloaded, and reloadAsync() called (never
 *   actually returns in production since the process restarts).
 * - `no-update`: server has no newer update than the current bundle.
 * - `error`: something went wrong; `message` has details.
 */
export async function attemptOtaUpdate(): Promise<OtaResult> {
  if (__DEV__ || !Updates.isEnabled) {
    return { outcome: 'no-update' };
  }

  try {
    const check = await withTimeout(
      Updates.checkForUpdateAsync(),
      CHECK_TIMEOUT_MS,
      'checkForUpdateAsync',
    );
    if (check.isAvailable) {
      await Updates.fetchUpdateAsync();
      // Save before reload -- persists across the restart.
      await saveOtaTimestamp();
      // In standalone this restarts the process and never returns; in a
      // brownfield host it posts a `reload` message and DOES return, after
      // which the host re-creates the RN root.
      await reloadApp();
      return { outcome: 'reloading' };
    }
    // No remote update -- the embedded bundle IS the latest. Reset timer.
    await saveOtaTimestamp();
    return { outcome: 'no-update' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { outcome: 'error', message };
  }
}
