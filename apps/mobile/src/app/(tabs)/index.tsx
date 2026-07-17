import * as Updates from 'expo-updates';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { BUNDLE_MARKER } from '@/constants/marker';
import { Colors, Spacing } from '@/constants/theme';

/**
 * Home tab (route `/`). Renders the OTA delivery proof: the BUNDLE_MARKER
 * constant plus the running update id and whether this is an embedded launch.
 * Bump the marker + re-export + Check/Download/Restart to see it change (see
 * docs/development-workflow.md).
 */
export default function HomeScreen() {
  return (
    <View style={styles.root}>
      <Text style={styles.marker} testID="bundle-marker">
        {BUNDLE_MARKER}
      </Text>
      <Text style={styles.detail}>Update ID: {Updates.updateId ?? '(none)'}</Text>
      <Text style={styles.detail}>
        Embedded launch: {String(Updates.isEmbeddedLaunch)}
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
    padding: Spacing.five,
    gap: Spacing.three,
  },
  marker: {
    color: Colors.dark.accent,
    fontSize: 24,
    fontWeight: '700',
  },
  detail: {
    color: Colors.dark.textSecondary,
    fontSize: 14,
  },
});
