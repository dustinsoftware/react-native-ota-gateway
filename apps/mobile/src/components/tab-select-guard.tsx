import { TabActions } from '@react-navigation/native';
import { useNavigationContainerRef, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { sendToNative, useNativeMessages } from '@/brownfield/message-bridge';
import {
  type NavStateNode,
  applySelectTab,
  findTabsStateKey,
  isKnownTabRoute,
  isNavRestoreEnabled,
  tabForPath,
} from '@/brownfield/nav-restore';
import { isBrownfieldHost } from '@/brownfield/runtime';

/**
 * Drives shell tab changes on the single persistent RN root. Under the
 * single-root design (docs/single-root-tabs-experiment.md) the host no longer
 * remounts a surface per tab tap; it posts a `selectTab` bridge message and
 * this listener swaps the visible tab IN PLACE.
 *
 * Why a TARGETED `JUMP_TO`, not `router.navigate`. The shell tabs live under
 * the `(tabs)` NativeTabs navigator, whose router is React Navigation's plain
 * TabRouter (state type 'tab'). `router.navigate(path)` resolves the tab jump
 * through expo-router's global linkTo, which merely ENQUEUES a ROUTER_LINK
 * action drained asynchronously by a NavigationContainer effect (the
 * `routingQueue`) and is furthermore gated behind
 * `navigationRef.isReady()` -- which in this brownfield host reads FALSE even
 * when the router store is fully functional (see below). Either way the tab
 * change was silently lost on-device (Mode A): the RN content stayed on the
 * mount-time tab while only the native chrome moved. We instead dispatch the
 * SAME action a native tab press does
 * (`NativeBottomTabsNavigator.onTabChange`): a `JUMP_TO` TARGETED at the tabs
 * navigator's own `state.key`. That is a synchronous, direct navigator dispatch
 * -- it bypasses the routing queue entirely and is the mechanism the native tab
 * bar itself uses, so it commits reliably.
 *
 * The target key is REQUIRED and resolved fresh per dispatch. An UNtargeted
 * `JUMP_TO` from the root container ref stops at the root Stack (React
 * Navigation only walks child navigators for an action carrying a `target`), so
 * it never reaches the tab router. {@link findTabsStateKey} locates the live
 * `'tab'` navigator in `navigationRef.getRootState()` (matched by its route
 * names) every time; the key must never be cached across a navigator remount.
 * If the key is not yet discoverable the request is treated as not-ready and the
 * poll keeps trying.
 *
 * In-place switch does NOT restore a deep in-tab path. With one persistent root
 * every tab's nested stack stays mounted, so revealing a tab shows exactly where
 * the user left it within this JS lifetime -- no path replay needed. Cross-JS-
 * lifetime restoration (the Android in-place OTA reload) is owned by the MOUNT
 * path (`resolveInitialLocation` + the `nav:activeTab` slice), not by this
 * in-place handler, so a `JUMP_TO` to the tab is sufficient and correct here.
 *
 * Renders nothing; a no-op on web/standalone (`useNativeMessages` is a no-op off
 * a brownfield host), so it is safe to mount everywhere alongside NavStateGuard.
 * Unknown routes are ignored inside {@link applySelectTab} (the bridge is
 * untrusted input, and a newer host may add a tab route an older bundle
 * predates -- the version-skew guarantee).
 *
 * Readiness gate is the tabs navigator KEY, not `navigationRef.isReady()`.
 * `useNavigationContainerRef()` returns the module-global container ref; this
 * guard sits outside <OtaGate> and above the Stack so its bridge subscription
 * exists even while the OTA gate blocks children. CRUCIALLY, in the brownfield
 * single-root host `isReady()` can read FALSE even though the router store is
 * fully functional (`usePathname()` resolves, `getRootState()` returns the
 * tree) -- gating dispatch on `isReady()` (as an earlier version did) stranded
 * every tab switch on-device. A targeted JUMP_TO only needs the LIVE tabs
 * navigator key, so we gate on {@link findTabsStateKey} resolving from
 * `getRootState()` instead: if the key is not yet resolvable the poll simply
 * retries. `usePathname()` is a global router-store subscription that re-renders
 * this guard when navigation commits -- the verification signal after a
 * dispatch. While a request is pending we POLL on a real delay (a state commit
 * does not by itself re-render this component), re-dispatching the targeted
 * JUMP_TO until the observed pathname's owning tab matches the request, then
 * stop. The dispatch deadline is measured from WHEN THE TABS NAVIGATOR BECAME
 * AVAILABLE, not from when the message arrived: the navigator can be withheld
 * for seconds while the OTA gate blocks children, and that wait must not eat
 * the dispatch budget (a generous absolute cap still guarantees termination).
 * Last request wins.
 */

/** How often the pending-request poll re-checks / re-dispatches. */
const SELECT_TAB_POLL_MS = 120;
/** Budget for landing AFTER the tabs navigator becomes available. */
const SELECT_TAB_DEADLINE_MS = 4000;
/**
 * Absolute cap from message arrival, covering the pre-mount wait (e.g. the OTA
 * gate withholding the navigator). Generous vs. the OTA check timeout (~10s) so
 * a tab tapped during the gate is still honored once the navigator mounts;
 * guarantees the poll terminates even if the navigator never mounts.
 */
const SELECT_TAB_ABSOLUTE_MS = 30000;

export function TabSelectGuard() {
  const navigationRef = useNavigationContainerRef();
  const pathname = usePathname();

  const [pending, setPending] = useState<string | null>(null);
  // Wall-clock instant the current request arrived; bounds the absolute wait so
  // a truly undeliverable request cannot loop forever. Null when idle.
  const pendingSinceRef = useRef<number | null>(null);
  // Wall-clock instant the tabs navigator first became resolvable for the
  // current request; the dispatch deadline is measured from here so the
  // pre-mount wait (OTA gate) is not counted against it. Null until resolvable.
  const keyReadySinceRef = useRef<number | null>(null);
  // Bumped by the poll timeout to force a verification render even when no
  // navigation commit (and thus no pathname change) occurs on its own.
  const [verifyTick, setVerifyTick] = useState(0);

  useNativeMessages((message) => {
    if (message.type !== 'selectTab') return;
    pendingSinceRef.current = Date.now();
    keyReadySinceRef.current = null;
    setPending(message.route);
  });

  // Handshake: announce (once per mount) that the selectTab listener is live.
  // A native tab tap in the window after the TurboModule event emitter wires up
  // but before this subscription exists is emitted into the void; on `tabsReady`
  // the host re-posts its selected tab, which we apply idempotently. Only the
  // tab shell surface participates (not pushed screens).
  useEffect(() => {
    if (!isBrownfieldHost() || !isNavRestoreEnabled()) return;
    sendToNative({ type: 'tabsReady' });
  }, []);

  useEffect(() => {
    if (pending === null) return;

    // Unknown route (untrusted bridge input / a newer host's tab an older
    // bundle predates -- the version-skew guarantee): drop it immediately
    // rather than poll for it. Checked BEFORE the no-key wait below, so an
    // unknown route received during the OTA gate does not linger for the
    // absolute cap.
    if (!isKnownTabRoute(pending)) {
      setPending(null);
      pendingSinceRef.current = null;
      keyReadySinceRef.current = null;
      return;
    }

    // Landed on the requested tab -> done.
    if (tabForPath(pathname) === pending) {
      setPending(null);
      pendingSinceRef.current = null;
      keyReadySinceRef.current = null;
      return;
    }

    // Resolve the live tabs navigator key -- our readiness AND target signal.
    // Derived from getRootState(), NOT navigationRef.isReady(): in the
    // brownfield single-root host isReady() can read false even though the
    // router store is fully functional (usePathname resolves, getRootState
    // returns the tree). Gating dispatch on isReady() strands every switch.
    let rootState: NavStateNode | undefined;
    try {
      rootState = navigationRef?.getRootState?.() as NavStateNode | undefined;
    } catch {
      rootState = undefined;
    }
    const targetKey = findTabsStateKey(rootState);

    // Phase 1 -- tabs navigator not mounted yet (e.g. the OTA gate still
    // withholds children). Keep the request ALIVE without counting it against
    // the dispatch deadline, bounded only by a generous absolute cap so a
    // navigator that never mounts cannot loop forever.
    if (!targetKey) {
      keyReadySinceRef.current = null;
      const since = pendingSinceRef.current ?? Date.now();
      if (Date.now() - since > SELECT_TAB_ABSOLUTE_MS) {
        setPending(null);
        pendingSinceRef.current = null;
        return;
      }
      const pollId = setTimeout(() => setVerifyTick((tick) => tick + 1), SELECT_TAB_POLL_MS);
      return () => clearTimeout(pollId);
    }

    // Phase 2 -- the tabs navigator is available. Bound the dispatch attempts
    // by a deadline measured from WHEN THE KEY BECAME AVAILABLE, so the
    // pre-mount wait never eats the dispatch budget.
    const readySince = keyReadySinceRef.current ?? Date.now();
    keyReadySinceRef.current = readySince;
    if (Date.now() - readySince > SELECT_TAB_DEADLINE_MS) {
      setPending(null);
      pendingSinceRef.current = null;
      keyReadySinceRef.current = null;
      return;
    }

    // Reveal the tab via a TARGETED JUMP_TO on the tabs navigator (mirrors a
    // native tab press). applySelectTab validates the route (skew guarantee);
    // an unknown route drives nothing, so stop immediately.
    const drove = applySelectTab(pending, (path) => {
      const tab = tabForPath(path) ?? pending;
      navigationRef?.dispatch?.({
        ...TabActions.jumpTo(tab.slice(1)),
        target: targetKey,
      });
    });
    if (!drove) {
      setPending(null);
      pendingSinceRef.current = null;
      keyReadySinceRef.current = null;
      return;
    }

    // Re-verify (and, if not landed, re-dispatch) after a real delay: a commit
    // takes a frame, and a not-yet-mounted tab key resolves on a later tick.
    const id = setTimeout(() => setVerifyTick((tick) => tick + 1), SELECT_TAB_POLL_MS);
    return () => clearTimeout(id);
  }, [pending, pathname, verifyTick, navigationRef]);

  return null;
}
