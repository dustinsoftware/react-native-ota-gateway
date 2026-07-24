import { Link } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';

/**
 * Test 1 (route `/test-one`). A React Native screen the native hosts push from
 * the More tab's Test 1 row, headered by the NATIVE toolbar/navigation bar
 * (the root stack renders no RN header). The counter proves live RN state, and
 * the link to Test 2 navigates INSIDE this pushed surface -- a native Back
 * press then pops the RN stack first (the brownfield back integration) before
 * closing the native screen.
 */
export default function TestOneScreen() {
  const [count, setCount] = useState(0);

  return (
    <View style={styles.root} testID="test-one-screen">
      <Text style={styles.title}>Test 1</Text>
      <Text style={styles.subtitle}>React Native screen, native header</Text>
      <Pressable
        style={styles.button}
        onPress={() => setCount((current) => current + 1)}
        testID="test-one-counter"
      >
        <Text style={styles.buttonLabel}>Taps: {count}</Text>
      </Pressable>
      <Link href="/test-two" style={styles.link} testID="test-one-link-test-two">
        Open Test 2 inside React Native
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    backgroundColor: Colors.dark.background,
  },
  title: {
    color: Colors.dark.accent,
    fontSize: 32,
    fontWeight: '700',
  },
  subtitle: {
    color: Colors.dark.textSecondary,
    fontSize: 16,
  },
  button: {
    backgroundColor: Colors.dark.accent,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
  buttonLabel: {
    color: Colors.dark.text,
    fontSize: 18,
    fontWeight: '600',
  },
  link: {
    color: Colors.dark.accent,
    fontSize: 16,
    textDecorationLine: 'underline',
  },
});
