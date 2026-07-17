import { Tabs } from 'expo-router';
import React from 'react';

import { Colors } from '@/constants/theme';

/**
 * Web tab bar. NativeTabs (app-tabs.tsx) is native-only, so web uses the JS
 * <Tabs> navigator. Ships the same tabs as native: Home (index) and Dev Tools
 * (developer).
 */
export default function AppTabs() {
  const colors = Colors.dark;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.backgroundElement,
        },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textSecondary,
      }}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="developer" options={{ title: 'Dev Tools' }} />
    </Tabs>
  );
}
