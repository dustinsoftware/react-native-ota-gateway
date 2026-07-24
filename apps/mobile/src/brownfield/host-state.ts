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

/**
 * Slice keys or field names matching this pattern are refused: the host store
 * (SharedPreferences/UserDefaults) and the savedStateJson initial-properties
 * channel are NOT secret-grade storage -- tokens and payment data belong in
 * SecureStore/Keychain paths, never in checkpoints. Substring matching is
 * DELIBERATELY over-broad (a "discarded-items" slice is refused because it
 * contains "card"): a false positive degrades to state-not-persisted plus a
 * warning, while a false negative leaks -- rename the slice, not the pattern.
 * Note nav-restore slice keys embed the surface route, so a route containing
 * one of these words would silently disable its restore. The native writers cap
 * size but do not re-scan names; this is the contract's enforcement point.
 */
const SECRET_NAME_PATTERN = /token|secret|password|credential|card|cvv|pan\b/i;

/**
 * Ceiling for one serialized slice. The whole store rides into every mounted
 * surface as an initial property, so slices must stay small; a slice this
 * large is almost certainly misusing the seam (persist an id and refetch).
 * Mirrored by a native-side cap in HostStateStore.kt / HostStateStore.swift.
 */
const MAX_SLICE_BYTES = 16 * 1024;

function findSecretName(key: string, state: Record<string, unknown>): string | null {
  if (SECRET_NAME_PATTERN.test(key)) return key;
  // Visited guard: state must be JSON-serializable, but this is the
  // enforcement boundary -- a buggy caller passing a CYCLIC object must get a
  // refused checkpoint, not an infinite loop on the checkpoint interval.
  const visited = new WeakSet<object>();
  const queue: unknown[] = [state];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === null || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const [name, value] of Object.entries(current)) {
      if (SECRET_NAME_PATTERN.test(name)) return name;
      queue.push(value);
    }
  }
  return null;
}

/**
 * Persist a component's state slice into the native host's store. Refuses
 * (with a warning, never a crash) slices that carry secret-shaped names or
 * exceed the size ceiling -- a dropped checkpoint degrades to "state did not
 * persist", which is always safer than leaking or bloating the channel.
 */
export function checkpointHostState(key: string, state: Record<string, unknown>): void {
  if (!isBrownfieldHost()) return;

  const secretName = findSecretName(key, state);
  if (secretName) {
    console.warn(
      `[host-state] Refusing checkpoint "${key}": "${secretName}" looks like a secret; `
        + 'use SecureStore/Keychain paths for sensitive data.',
    );
    return;
  }

  let size: number;
  try {
    size = JSON.stringify(state).length;
  } catch (err) {
    // Cyclic or BigInt-bearing state cannot cross the bridge anyway; refuse
    // it here (callers run this from intervals -- a throw must not escape).
    console.warn(
      `[host-state] Refusing checkpoint "${key}": state is not JSON-serializable `
        + `(${err instanceof Error ? err.message : String(err)}).`,
    );
    return;
  }
  if (size > MAX_SLICE_BYTES) {
    console.warn(
      `[host-state] Refusing checkpoint "${key}": ${size} bytes exceeds the `
        + `${MAX_SLICE_BYTES}-byte slice ceiling; persist an id and refetch instead.`,
    );
    return;
  }

  sendToNative({ type: 'saveState', key, state });
}
