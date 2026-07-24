import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';

/**
 * Test 2 (route `/test-two`). The second React Native screen the native hosts
 * push from the More tab -- and also reachable from Test 1 via an RN-internal
 * link. Visually distinct from Test 1 (teal accent) so a route-bleed
 * regression (a pushed surface rendering the previous surface's route) is
 * obvious at a glance. "Back inside React Native" pops the RN stack when Test 2
 * was reached from Test 1; native Back does the same via the brownfield back
 * integration.
 */
export default function TestTwoScreen() {
  const router = useRouter();

  return (
    <View style={styles.root} testID="test-two-screen">
      <Text style={styles.title}>Test 2</Text>
      <Text style={styles.subtitle}>Another React Native screen, native header</Text>
      {router.canGoBack() && (
        <Pressable
          style={styles.button}
          onPress={() => router.back()}
          testID="test-two-back-rn"
        >
          <Text style={styles.buttonLabel}>Back inside React Native</Text>
        </Pressable>
      )}
    </View>
  );
}

const TEAL = '#2AB8B8';

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    backgroundColor: Colors.dark.background,
  },
  title: {
    color: TEAL,
    fontSize: 32,
    fontWeight: '700',
  },
  subtitle: {
    color: Colors.dark.textSecondary,
    fontSize: 16,
  },
  button: {
    backgroundColor: TEAL,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
  buttonLabel: {
    color: Colors.dark.text,
    fontSize: 18,
    fontWeight: '600',
  },
});
