import * as SplashScreen from 'expo-splash-screen';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { attemptOtaUpdate } from '@/utils/attempt-ota-update';
import { getLastOtaTimestamp, isOtaStale } from '@/utils/ota-timestamp';

type GateStatus = 'loading' | 'ready' | 'checking';

const STALE_DAYS = 1;

/**
 * Blocks app rendering while it checks for an OTA update when the device is
 * running the embedded JS bundle (no cached OTA) or when the last confirmed
 * update is over 24 hours old.
 *
 * On fresh launches within the staleness window, children render immediately
 * and the native `checkAutomatically: ALWAYS` config handles background updates.
 *
 * If the update check FAILS (offline, server error), the gate falls through to
 * render the embedded bundle -- it is a complete, runnable app -- rather than
 * stranding the user behind an "Update failed" wall. The next launch retries.
 */
export function OtaGate({ children }: { children: React.ReactNode }) {
  const isNative = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled;

  // Start in 'loading' on native (need async timestamp read) or 'ready' on web.
  const [status, setStatus] = useState<GateStatus>(
    isNative ? 'loading' : 'ready',
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
    setStatus('ready');
  }, []);

  useEffect(() => {
    if (!isNative) return;

    async function init() {
      // Embedded launch always needs a gate (no cached OTA at all).
      if (Updates.isEmbeddedLaunch) {
        runUpdate();
        return;
      }

      // Non-embedded: check if the last confirmed update is stale.
      const timestamp = await getLastOtaTimestamp();
      if (isOtaStale(timestamp, STALE_DAYS)) {
        runUpdate();
      } else {
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
