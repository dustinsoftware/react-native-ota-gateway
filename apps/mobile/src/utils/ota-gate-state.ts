import { attemptOtaUpdate } from './attempt-ota-update';
import { getLastOtaTimestamp, isOtaStale } from './ota-timestamp';

export type GateStatus = 'loading' | 'checking' | 'ready';

const STALE_DAYS = 1;

// Module-scoped gate state, shared by every OtaGate mount in this JS runtime.
// In brownfield hosts every native tab switch tears down and remounts the RN
// surface (all sharing one runtime); a single-flight promise here guarantees
// the gate resolves at most once per runtime -- concurrent or successive
// mounts join the same resolution instead of racing their own timestamp reads
// and OTA attempts. An OTA reload restarts the runtime, which naturally resets
// this state.
let resolved = false;
let attemptInFlight = false;
let gatePromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Snapshot for useSyncExternalStore. */
export function getGateStatus(): GateStatus {
  if (resolved) return 'ready';
  return attemptInFlight ? 'checking' : 'loading';
}

/** Subscribe for useSyncExternalStore. Returns the unsubscribe function. */
export function subscribeGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Resolves the launch gate exactly once per JS runtime (single-flight): gate
 * iff the last OTA attempt is missing or >24h old, then mark the runtime
 * resolved. Later callers get the same in-flight promise, so concurrent
 * mounts can never start duplicate OTA attempts.
 *
 * If the update check FAILS (offline, server error), the gate falls through
 * to 'ready' -- the embedded bundle is a complete, runnable app, so a failed
 * check must never block app entry. The next stale launch retries.
 */
export function resolveGateOnce(): Promise<void> {
  gatePromise ??= (async () => {
    // Gate iff the last OTA attempt is missing or >24h old.
    const timestamp = await getLastOtaTimestamp();
    if (isOtaStale(timestamp, STALE_DAYS)) {
      attemptInFlight = true;
      notify();
      // 'no-update' -> ready. 'error' -> ready anyway (fail-open).
      // 'reloading' -> standalone reloadAsync() never returns; in a
      // brownfield host reloadApp() posts a message and the native host
      // rebuilds the RN root (so this code keeps running briefly).
      const result = await attemptOtaUpdate();
      attemptInFlight = false;
      if (result.outcome === 'error') {
        console.warn(
          '[OTA] update check failed; continuing with current bundle:',
          result.message,
        );
      }
    }
    resolved = true;
    notify();
  })();
  return gatePromise;
}

/** Test-only: reset the module state between test cases. */
export function resetGateForTesting(): void {
  resolved = false;
  attemptInFlight = false;
  gatePromise = null;
  listeners.clear();
}
