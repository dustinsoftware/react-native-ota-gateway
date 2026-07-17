import React from 'react';
import { StyleSheet, View } from 'react-native';

import { FidgetSpinner } from '@/components/fidget-spinner';
import { Colors } from '@/constants/theme';

/**
 * Spinner tab (route `/spinner`). Centers an interactive fidget spinner you can
 * drag to spin; it coasts with decaying inertia on release. Demonstrates
 * gesture-handler + Reanimated worklets in a standalone tab.
 */
export default function SpinnerScreen() {
  return (
    <View style={styles.root}>
      <FidgetSpinner />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.dark.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
