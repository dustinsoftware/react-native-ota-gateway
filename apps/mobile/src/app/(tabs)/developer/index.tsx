import * as Updates from 'expo-updates';
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { API_BASE_URL } from '@/api/client';
import { MatrixRain } from '@/components/matrix-rain';
import { BUNDLE_MARKER } from '@/constants/marker';
import { Colors, Spacing } from '@/constants/theme';
import { getOtaAppVersion } from '@/utils/ota-app-version';
import { reloadApp } from '@/utils/reload-app';

/**
 * Developer OTA tab (mobile). Shows the expo-updates runtime state and lets a
 * developer check for / download / apply an OTA update.
 *
 * OTA actions are only meaningful on a release native build with updates
 * enabled; on web or in dev they are surfaced as disabled.
 */
export default function DeveloperScreen() {
  const insets = useSafeAreaInsets();
  const otaActive = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled;
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setStatus(`${label}...`);
    try {
      const result = await fn();
      setStatus(`${label}: ${result === undefined ? 'done' : JSON.stringify(result)}`);
    } catch (err) {
      setStatus(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const rows: [string, string][] = [
    ['Platform', Platform.OS],
    ['BFF base', API_BASE_URL || '(page origin)'],
    ['Updates enabled', String(Updates.isEnabled)],
    ['OTA app version', getOtaAppVersion(Updates.manifest) ?? '(none)'],
    ['Runtime version', Updates.runtimeVersion ?? '(none)'],
    ['Channel', Updates.channel ?? '(none)'],
    ['Update ID', Updates.updateId ?? '(none)'],
    ['Embedded launch', String(Updates.isEmbeddedLaunch)],
  ];

  return (
    <View style={styles.wrapper}>
      {/* Decorative digital-rain background; purely cosmetic, non-interactive. */}
      <MatrixRain />
      <ScrollView
        style={styles.root}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + Spacing.three }]}>
        <Text style={styles.title}>Developer / OTA</Text>

        <View style={styles.card}>
          {/* OTA delivery proof: the marker changes with each re-exported
              bundle, so this card alone demonstrates OTA without the Home tab. */}
          <Text style={styles.marker} testID="bundle-marker">
            {BUNDLE_MARKER}
          </Text>
          {rows.map(([label, value]) => (
            <View key={label} style={styles.row}>
              <Text style={styles.rowLabel}>{label}</Text>
              <Text style={styles.rowValue} testID={`ota-${label}`}>{value}</Text>
            </View>
          ))}
        </View>

        {!otaActive ? (
          <Text style={styles.note}>
            OTA actions are disabled here (web, dev build, or updates not enabled).
          </Text>
        ) : null}

        <Button
          label="Check for update"
          disabled={!otaActive || busy}
          onPress={() => run('Check', () => Updates.checkForUpdateAsync().then((r) => r.isAvailable))}
        />
        <Button
          label="Download update"
          disabled={!otaActive || busy}
          onPress={() => run('Download', () => Updates.fetchUpdateAsync().then((r) => r.isNew))}
        />
        <Button
          label="Restart with latest"
          disabled={!otaActive || busy}
          onPress={() => run('Restart', () => reloadApp())}
        />

        {status ? <Text style={styles.status}>{status}</Text> : null}
      </ScrollView>
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.buttonDisabled]}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: Colors.dark.background,
  },
  root: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  title: {
    color: Colors.dark.text,
    fontSize: 22,
    fontWeight: '700',
  },
  card: {
    backgroundColor: Colors.dark.backgroundElement,
    borderRadius: 8,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  marker: {
    color: Colors.dark.accent,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rowLabel: {
    color: Colors.dark.textSecondary,
  },
  rowValue: {
    color: Colors.dark.text,
    fontWeight: '600',
  },
  note: {
    color: Colors.dark.textDisabled,
  },
  button: {
    backgroundColor: Colors.dark.accent,
    borderRadius: 8,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: Colors.dark.backgroundSelected,
  },
  buttonLabel: {
    color: Colors.dark.text,
    fontWeight: '700',
  },
  status: {
    color: Colors.dark.textSecondary,
  },
});
