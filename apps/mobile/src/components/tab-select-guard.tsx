import { useNavigationContainerRef, usePathname, useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { sendToNative, useNativeMessages } from '@/brownfield/message-bridge';
import { applySelectTab, isNavRestoreEnabled, tabForPath } from '@/brownfield/nav-restore';
import { isBrownfieldHost } from '@/brownfield/runtime';

/**
 * Drives shell tab changes on the single persistent RN root. Under the
 * single-root design (docs/single-root-tabs-experiment.md) the host no longer
 * remounts a surface per tab tap; it posts a `selectTab` bridge message and
 * this listener swaps the tab in place via `router.navigate` (see
 * src/brownfield/nav-restore.ts). `navigate` -- NOT `replace` -- is
 * load-bearing: the tab routes live under the `(tabs)` NativeTabs navigator,
 * whose router is React Navigation's plain TabRouter (state type 'tab').
 * expo-router 55 only rewrites REPLACE to JUMP_TO for 'expo-tab'/'drawer'
 * navigators, so a REPLACE targeting the tab navigator is SILENTLY dropped
 * (no error, no state change); NAVIGATE is handled as a tab jump. Renders nothing; a no-op on web/standalone
 * (useNativeMessages is a no-op off a brownfield host), so it is safe to mount
 * everywhere alongside NavStateGuard. Unknown routes are ignored inside
 * applySelectTab (the bridge is untrusted input).
 *
 * Readiness-aware dispatch. expo-router 55's `router.navigate` only ENQUEUES a
 * ROUTER_LINK action (global-state/routing.js `routingQueue`) that a later
 * NavigationContainer effect drains -- and the queue SILENTLY DROPS actions
 * while the navigation ref is not ready. A `selectTab` posted during a cold
 * start (before the Stack mounts) would be lost, stranding the shell on the old
 * tab. So this guard holds the latest requested route and dispatches only once
 * the root navigation ref reports ready:
 *  - `useNavigationContainerRef()` returns the module-global container ref;
 *    its `isReady()` is null-safe and NEVER throws even when rendered ABOVE the
 *    Stack navigator (createNavigationContainerRef returns false when no
 *    navigator is mounted), which is why this guard sits outside <OtaGate> and
 *    above the Stack. We deliberately do NOT use `useRootNavigationState()`
 *    here: in v55 it calls `useNavigation().getParent(INTERNAL_SLOT_NAME)` and
 *    throws when no parent navigator exists yet -- unusable above the Stack.
 *  - `usePathname()` is a global router-store subscription (useRouteInfo), also
 *    safe above the Stack, and re-renders this guard when navigation commits --
 *    our verification signal after a dispatch.
 *  - `isReady()` is a plain snapshot read: the ref BECOMING ready does not
 *    re-render anything. While a route is pending and the ref is not ready,
 *    the guard POLLS (short timeout bumping `verifyTick`) until it flips --
 *    otherwise a selectTab held during a cold start would be stranded forever
 *    with no render to release it.
 *
 * This poll TERMINATING depends on the one-ExpoRoot rule (see
 * docs/single-root-tabs-experiment.md). expo-router 55 keeps its whole router
 * store -- including the ref returned by `useNavigationContainerRef()` -- in a
 * SINGLE module-global slot (`storeRef` in
 * expo-router/build/global-state/router-store.js; the `store.navigationRef`
 * getter reads `storeRef.current.navigationRef`, which `useStore` reassigns
 * wholesale on every render). With exactly one live ExpoRoot that slot always
 * names the one mounted container, so `isReady()` flips true the moment the
 * Stack mounts and the poll ends. If a SECOND ExpoRoot is ever mounted in the
 * same JS runtime, the two mounts clobber that shared slot and
 * `store.navigationRef` can be left naming a container whose `.current` was
 * nulled on unmount (createNavigationContainerRef's `isReady()` returns false
 * when `current == null`) -- then this poll never terminates and the shell is
 * stranded on its mount-time tab FOREVER. That is exactly the stall the
 * removed Android NPE-fallback remount used to cause: it mounted a transient
 * second ExpoRoot to recover a lost tap. The `tabsReady` handshake replaced it
 * (native re-posts the selected tab once this guard subscribes), so a single
 * root now suffices -- do NOT reintroduce any remount on the RN-tab -> RN-tab
 * path.
 *
 * New messages overwrite the pending route (last-wins). After dispatch we
 * verify on a subsequent render that the pathname's owning tab matches the
 * request and retry ONCE if not (the silent-drop window); we never loop.
 */
export function TabSelectGuard() {
  const router = useRouter();
  const navigationRef = useNavigationContainerRef();
  const pathname = usePathname();

  const [pending, setPending] = useState<string | null>(null);
  // Dispatch attempts for the current pending route: 0 = not yet dispatched,
  // 1 = dispatched once, 2 = retried once. Capped at 2 so a genuine drop can
  // never loop. A ref (not state) so bumping it does not itself re-render.
  const attemptsRef = useRef(0);
  // Bumped by a post-dispatch timeout to force one verification render even
  // when the navigation never commits (a silent drop yields no pathname change
  // and thus no re-render on its own).
  const [verifyTick, setVerifyTick] = useState(0);

  useNativeMessages((message) => {
    if (message.type !== 'selectTab') return;
    attemptsRef.current = 0;
    setPending(message.route);
  });

  // Handshake: announce (once per mount, AFTER the subscription effect above)
  // that the selectTab listener is live. A native tab tap in the window after
  // the TurboModule event emitter wires up but before that subscription exists
  // is emitted into the void -- no error, no fallback -- stranding the shell on
  // the old tab. On `tabsReady` the host re-posts its selected tab; already
  // being there is a no-op. Only the tab shell surface participates: a pushed
  // screen announcing would make the host re-post the shell tab underneath it.
  useEffect(() => {
    if (!isBrownfieldHost() || !isNavRestoreEnabled()) return;
    sendToNative({ type: 'tabsReady' });
  }, []);

  const isReady = navigationRef?.isReady?.() === true;

  useEffect(() => {
    if (pending === null) return;
    // The routingQueue silently drops actions until the ref is ready. isReady
    // is a plain snapshot read on render -- the ref flipping ready does NOT
    // re-render this component -- so while not ready we must poll: bump
    // verifyTick to force a re-render (re-reading isReady) until it flips.
    // Without this, a selectTab arriving before the Stack mounts (cold start)
    // is stranded forever and the shell never leaves the old tab.
    if (!isReady) {
      const pollId = setTimeout(() => setVerifyTick((tick) => tick + 1), 50);
      return () => clearTimeout(pollId);
    }
    // Landed on the requested tab -> done.
    if (tabForPath(pathname) === pending) {
      setPending(null);
      attemptsRef.current = 0;
      return;
    }
    // Dispatched twice (initial + one retry) without landing -> give up rather
    // than loop. The readiness gate makes a true drop very unlikely.
    if (attemptsRef.current >= 2) {
      setPending(null);
      attemptsRef.current = 0;
      return;
    }
    attemptsRef.current += 1;
    applySelectTab(pending, (path) => {
      router.navigate(path as Href);
    });
    // Force one verification render shortly after dispatch to catch a silent
    // drop even when the pathname never changes (no nav commit, no re-render).
    const id = setTimeout(() => setVerifyTick((tick) => tick + 1), 0);
    return () => clearTimeout(id);
  }, [pending, isReady, pathname, verifyTick, router]);

  return null;
}
