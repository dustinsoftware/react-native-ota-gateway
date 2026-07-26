import * as SplashScreen from 'expo-splash-screen';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { attemptOtaUpdate } from '@/utils/attempt-ota-update';
import { getLastOtaTimestamp, isOtaStale } from '@/utils/ota-timestamp';

type GateStatus = 'loading' | 'ready' | 'checking';

const STALE_DAYS = 1;

// Memoizes gate resolution across surface remounts within one JS runtime. In
// brownfield hosts every native tab switch tears down and remounts the RN
// surface (all sharing one runtime); without this, each remount would re-run
// the check and flash "Updating". An OTA reload restarts the runtime, which
// naturally resets this back to false.
let resolvedThisRuntime = false;

/**
 * Blocks app rendering while it checks for an OTA update iff the last OTA
 * attempt is missing or over 24 hours old. The policy is attempt-based: the
 * timestamp is saved once per real attempt regardless of outcome, so the gate
 * blocks at most once per 24h window and there is no embedded-launch special
 * case.
 *
 * Resolution is memoized once per JS runtime: after the gate reaches 'ready',
 * later surface mounts in the same runtime render children immediately and
 * synchronously -- no async timestamp read, no blank frame, no "Updating"
 * flash on brownfield tab switches.
 *
 * If the update check FAILS (offline, server error), the gate falls through to
 * render the embedded bundle -- it is a complete, runnable app -- rather than
 * stranding the user behind an "Update failed" wall. The next launch retries.
 */
export function OtaGate({ children }: { children: React.ReactNode }) {
  const isNative = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled;

  // Start 'ready' on web, or when this runtime already resolved the gate (a
  // brownfield remount) -- no async read, no "Updating" flash. Otherwise start
  // 'loading' on native to read the timestamp asynchronously.
  const [status, setStatus] = useState<GateStatus>(
    !isNative || resolvedThisRuntime ? 'ready' : 'loading',
  );
  const attemptingRef = useRef(false);

  const runUpdate = useCallback(async () => {
    if (attemptingRef.current) return;
    attemptingRef.current = true;
    setStatus('checking');

    const result = await attemptOtaUpdate();
    attemptingRef.current = false;

    // 'no-update' -> ready. 'error' -> ready anyway: the embedded bundle is
    // runnable, so a failed check must never block app entry (offline first
    // launch would otherwise brick). 'reloading' -> standalone reloadAsync()
    // never returns; in a brownfield host reloadApp() posts a message and the
    // native host rebuilds the RN root (so this code keeps running briefly).
    if (result.outcome === 'error') {
      console.warn('[OTA] update check failed; continuing with current bundle:', result.message);
    }
    resolvedThisRuntime = true;
    setStatus('ready');
  }, []);

  useEffect(() => {
    if (!isNative || resolvedThisRuntime) return;

    async function init() {
      // Gate iff the last OTA attempt is missing or >24h old.
      const timestamp = await getLastOtaTimestamp();
      if (isOtaStale(timestamp, STALE_DAYS)) {
        runUpdate();
      } else {
        resolvedThisRuntime = true;
        setStatus('ready');
      }
    }

    init();
  }, [isNative, runUpdate]);

  // Hide the native splash once our UI (gate or app) is laid out.
  const splashHidden = useRef(false);
  const onLayout = useCallback(() => {
    if (!splashHidden.current) {
      splashHidden.current = true;
      SplashScreen.hideAsync();
    }
  }, []);

  // While loading the timestamp, keep the native splash visible.
  if (status === 'loading') {
    return null;
  }

  if (status === 'ready') {
    return (
      <View style={styles.passThrough} onLayout={onLayout}>
        {children}
      </View>
    );
  }

  return (
    <View style={styles.root} onLayout={onLayout}>
      <ActivityIndicator size="large" color={Colors.dark.accent} />
      <Text style={styles.statusText}>Updating</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  passThrough: {
    flex: 1,
  },
  root: {
    flex: 1,
    backgroundColor: Colors.dark.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  statusText: {
    color: Colors.dark.text,
    fontSize: 18,
    fontWeight: '600',
    marginTop: Spacing.three,
  },
});
