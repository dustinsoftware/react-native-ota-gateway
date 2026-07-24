import { Link } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { checkpointHostState, readHostSavedState } from '@/brownfield/host-state';
import { Colors, Spacing } from '@/constants/theme';

/**
 * Test 1 (route `/test-one`). A React Native screen the native hosts push from
 * the More tab's Test 1 row, headered by the NATIVE toolbar/navigation bar
 * (the root stack renders no RN header). The counter proves live RN state --
 * and PERSISTED state: every tap checkpoints the count into the host's native
 * store (host-state seam), so dismissing the screen and pushing it again
 * resumes the same count, like the fidget spinner's coast. Reset exists so
 * demos (and the Maestro flows) can start from a known value. The link to
 * Test 2 navigates INSIDE this pushed surface -- a native Back press then pops
 * the RN stack first (the brownfield back integration) before closing the
 * native screen.
 */
const STATE_KEY = 'test-one-counter';

export default function TestOneScreen() {
  const [count, setCount] = useState(
    () => readHostSavedState<{ count: number }>(STATE_KEY)?.count ?? 0,
  );

  function update(next: number) {
    setCount(next);
    checkpointHostState(STATE_KEY, { count: next });
  }

  return (
    <View style={styles.root} testID="test-one-screen">
      <Text style={styles.title}>Test 1</Text>
      <Text style={styles.subtitle}>React Native screen, native header</Text>
      <Pressable style={styles.button} onPress={() => update(count + 1)} testID="test-one-counter">
        <Text style={styles.buttonLabel}>Taps: {count}</Text>
      </Pressable>
      <Pressable onPress={() => update(0)} testID="test-one-reset">
        <Text style={styles.reset}>Reset</Text>
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
  reset: {
    color: Colors.dark.textSecondary,
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  link: {
    color: Colors.dark.accent,
    fontSize: 16,
    textDecorationLine: 'underline',
  },
});
