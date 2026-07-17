import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import React from 'react';
import { LogBox, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { NavStateGuard } from '@/components/nav-state-guard';
import { OtaGate } from '@/components/ota-gate';
import { Colors } from '@/constants/theme';

SplashScreen.preventAutoHideAsync();
// Rejected under a brownfield host when no Activity is attached at JS boot
// (the HOST owns the window and sets its own background); harmless, so don't
// let it surface as an uncaught rejection -- in dev the resulting LogBox
// banner covers real UI (it broke the rotation Maestro scenario).
SystemUI.setBackgroundColorAsync(Colors.dark.background).catch(() => {});
if (Platform.OS !== 'web') {
  // Library-internal noise (an <Image> deep in expo-router's internals renders
  // with an empty uri); no app code passes an Image source. Dev-only banners
  // from it cover real UI mid-flow, so silence exactly this message.
  LogBox.ignoreLogs(['source.uri should not be an empty string']);
}

/**
 * Root layout. The shell is deliberately minimal: the OTA gate wrapping the
 * route stack. OtaGate runs identically standalone and under a brownfield host.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: Colors.dark.background }}>
      <OtaGate>
        <NavStateGuard />
        <Stack screenOptions={{ headerShown: false }} />
      </OtaGate>
    </GestureHandlerRootView>
  );
}
