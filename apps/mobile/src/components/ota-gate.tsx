import * as SplashScreen from 'expo-splash-screen';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { getGateStatus, resolveGateOnce, subscribeGate } from '@/utils/ota-gate-state';

/**
 * Blocks app rendering while it checks for an OTA update iff the last OTA
 * attempt is missing or over 24 hours old. The policy is attempt-based: the
 * timestamp is saved once per real attempt regardless of outcome, so the gate
 * blocks at most once per 24h window and there is no embedded-launch special
 * case.
 *
 * Resolution lives in a module-scoped single-flight store (see
 * `utils/ota-gate-state.ts`) shared by every mount in the JS runtime: the
 * gate resolves at most once per runtime, concurrent mounts join the same
 * attempt instead of starting duplicates, and once resolved every later
 * surface mount renders children immediately and synchronously -- no async
 * timestamp read, no blank frame, no "Updating" flash on brownfield tab
 * switches. `useSyncExternalStore` re-reads the snapshot on subscribe, so a
 * mount can never miss a resolution that lands between its render and its
 * effects.
 *
 * If the update check FAILS (offline, server error), the gate falls through to
 * render the embedded bundle -- it is a complete, runnable app -- rather than
 * stranding the user behind an "Update failed" wall. The next launch retries.
 */
export function OtaGate({ children }: { children: React.ReactNode }) {
  const isNative = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled;

  const gateStatus = useSyncExternalStore(subscribeGate, getGateStatus);
  // Web / dev / updates-disabled never gates.
  const status = isNative ? gateStatus : 'ready';

  useEffect(() => {
    if (isNative) {
      resolveGateOnce();
    }
  }, [isNative]);

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
