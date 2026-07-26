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
 *
 * Attempt-based semantics: the timestamp is saved once per REAL attempt, at
 * attempt start, regardless of the outcome (`reloading`, `no-update`, or
 * `error`). The 24h staleness throttle in `OtaGate` therefore keys off the
 * last attempt, not the last confirmed update -- so a failed check does not
 * retry on every surface mount, it waits out the window like any other outcome.
 * The `__DEV__` / Updates-disabled early return saves nothing.
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

  // Save once per real attempt, before the check, so the 24h window starts no
  // matter how the attempt ends. The timestamp saved here also persists across
  // the reload path's restart.
  await saveOtaTimestamp();

  try {
    const check = await withTimeout(
      Updates.checkForUpdateAsync(),
      CHECK_TIMEOUT_MS,
      'checkForUpdateAsync',
    );
    if (check.isAvailable) {
      await Updates.fetchUpdateAsync();
      // In standalone this restarts the process and never returns; in a
      // brownfield host it posts a `reload` message and DOES return, after
      // which the host re-creates the RN root.
      await reloadApp();
      return { outcome: 'reloading' };
    }
    // No remote update -- the embedded bundle IS the latest.
    return { outcome: 'no-update' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { outcome: 'error', message };
  }
}
