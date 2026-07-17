import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Sky } from '@/components/sky';

/**
 * Sky tab (route `/sky`). A full-bleed decorative blue sky with drifting
 * parallax clouds. Non-interactive; it exists to show a second standalone tab
 * that renders identically on web and native.
 */
export default function SkyScreen() {
  return (
    <View style={styles.root}>
      <Sky />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
