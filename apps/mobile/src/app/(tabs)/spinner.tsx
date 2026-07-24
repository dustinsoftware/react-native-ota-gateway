import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { FidgetSpinner, type SpinnerSample } from '@/components/fidget-spinner';
import { Colors, Spacing } from '@/constants/theme';

/**
 * Spinner tab (route `/spinner`). Centers an interactive fidget spinner you can
 * drag to spin; it coasts with decaying inertia on release. Demonstrates
 * gesture-handler + Reanimated worklets in a standalone tab.
 *
 * The read-out under the spinner surfaces the live motion state ("spinning" /
 * "idle" + velocity). It is what makes the brownfield persistence demo
 * assertable: after a native tab roundtrip the resumed coast shows "spinning"
 * again (see fidget-spinner.tsx and .maestro/verify-spinner-persistence-*).
 */
export default function SpinnerScreen() {
  const [sample, setSample] = useState<SpinnerSample>({ spinning: false, velocity: 0 });

  return (
    <View style={styles.root}>
      <FidgetSpinner onSample={setSample} />
      <Text style={styles.readout} testID="spinner-state">
        {sample.spinning ? 'spinning' : 'idle'}
      </Text>
      <Text style={styles.velocity} testID="spinner-velocity">
        {Math.abs(sample.velocity).toFixed(1)} rad/s
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.dark.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  readout: {
    marginTop: Spacing.four,
    color: Colors.dark.accent,
    fontSize: 20,
    fontWeight: '600',
  },
  velocity: {
    color: Colors.dark.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
});
