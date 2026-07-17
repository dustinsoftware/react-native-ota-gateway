/**
 * Tracks whether the JS is running inside the native brownfield host (mounted
 * by the native app via the "OtaGatewayApp" component) versus standalone/web.
 *
 * Brownfield-only behaviours -- like reloading via a native message instead of
 * expo-updates' reloadAsync() -- key off this flag. The brownfield entry
 * (entry.tsx) sets it when the native host mounts the app.
 */
import type { RequireContext } from 'expo-router/build/types';

let runningInBrownfieldHost = false;

export function markBrownfieldHost(): void {
  runningInBrownfieldHost = true;
}

export function isBrownfieldHost(): boolean {
  return runningInBrownfieldHost;
}

/**
 * Wraps a require.context in a new function identity, delegating everything.
 *
 * expo-router's router store is module-global and, on Android, restores the
 * previous navigation state whenever the SAME context object mounts again
 * (useStore in expo-router's global-state/router-store). All native host
 * screens share one JS instance, so a second screen (Developer after Home,
 * or vice versa) rendered whatever route the previous screen was left on
 * instead of its own initialUrl. Mounting each screen with a fresh context
 * identity opts it out of that restore, so the host-passed initialUrl always
 * wins.
 *
 * This relies on expo-router comparing the context by REFERENCE
 * (`storeRef.current.context === context`); the wrapper copies `.id`, so if a
 * future expo-router keys the restore on `context.id` instead, the wrapper no
 * longer opts out and the route-bleed bug returns. Re-verify the useStore
 * Android branch (and re-run the two-screen navigation check on a device) on
 * every expo-router upgrade. The trade-off is deliberate: a brownfield screen
 * whose native root is recreated restarts at its initialUrl instead of
 * restoring in-screen navigation.
 */
export function freshRouteContext(context: RequireContext): RequireContext {
  const fresh = ((id: string) => context(id)) as RequireContext;
  fresh.keys = () => context.keys();
  fresh.resolve = (id: string) => context.resolve(id);
  fresh.id = context.id;
  return fresh;
}
