import { sendToNative } from './message-bridge';
import { isBrownfieldHost } from './runtime';

/**
 * Component state persisted in the NATIVE host's store.
 *
 * The brownfield hosts tear an RN surface down whenever it is dismissed (tab
 * switch, pushed screen closed, process death), so in-JS state dies with it.
 * This module round-trips state through the host instead, using the
 * brownfield library's two native seams:
 *
 *  - RN -> native: `checkpointHostState` posts a `saveState` message over the
 *    message bridge; the host writes it to SharedPreferences (Android) /
 *    UserDefaults (iOS).
 *  - native -> RN: the host injects the WHOLE store as the `savedStateJson`
 *    initial property on every surface it mounts; the brownfield entry
 *    (entry.tsx) hands it to `hydrateHostSavedState` before any screen renders,
 *    and components read their slice back with `readHostSavedState`.
 *
 * State must be JSON-serializable and is fire-and-forget: components should
 * checkpoint continuously (throttled) while their state changes rather than
 * relying on an unmount hook, because a surface teardown (or force-stop) can
 * outrun a final post. Standalone/web builds no-op on write and always read
 * null.
 */
let savedState: Record<string, unknown> = {};

/** Called by the brownfield entry with the host-injected `savedStateJson`. */
export function hydrateHostSavedState(json: string | null | undefined): void {
  if (!json) {
    savedState = {};
    return;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    savedState =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    // The host is in-process but this input still crosses a serialization
    // boundary; treat malformed JSON as no saved state rather than crash.
    savedState = {};
  }
}

/** The state slice a component previously checkpointed under `key`, or null. */
export function readHostSavedState<T>(key: string): T | null {
  const slice = savedState[key];
  return slice === undefined ? null : (slice as T);
}

/** Persist a component's state slice into the native host's store. */
export function checkpointHostState(key: string, state: Record<string, unknown>): void {
  if (!isBrownfieldHost()) return;
  sendToNative({ type: 'saveState', key, state });
}
