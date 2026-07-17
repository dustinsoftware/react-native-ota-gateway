import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { OtaGate } from '@/components/ota-gate';
import { Colors } from '@/constants/theme';

SplashScreen.preventAutoHideAsync();
SystemUI.setBackgroundColorAsync(Colors.dark.background);

/**
 * Root layout. The shell is deliberately minimal: the OTA gate wrapping the
 * route stack. OtaGate runs identically standalone and under a brownfield host.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: Colors.dark.background }}>
      <OtaGate>
        <Stack screenOptions={{ headerShown: false }} />
      </OtaGate>
    </GestureHandlerRootView>
  );
}
