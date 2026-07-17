import { NativeTabs } from 'expo-router/unstable-native-tabs';
import React from 'react';
import { Platform } from 'react-native';

import { isBrownfieldHost } from '@/brownfield/runtime';
import { Colors } from '@/constants/theme';

const isIOS26OrLater =
  Platform.OS === 'ios' && parseInt(String(Platform.Version), 10) >= 26;

/**
 * Native tab bar. Three tabs: Dev Tools (developer), Sky, and Spinner.
 *
 * When embedded in the native brownfield host the tab bar is hidden -- the
 * native app supplies its own navigation chrome and mounts a single RN screen
 * by route. Standalone builds keep the tab bar visible.
 */
export default function AppTabs() {
  const colors = Colors.dark;
  const brownfieldHost = isBrownfieldHost();

  return (
    <NativeTabs
      hidden={brownfieldHost}
      // Android hardware back on a non-initial tab defaults to jumping to the
      // initial tab (backBehavior 'initialRoute'). In the brownfield host that
      // tab is hidden, so back would blank the screen instead of closing the
      // native screen. 'none' lets the back press bubble out to the native
      // host unhandled.
      backBehavior={brownfieldHost ? 'none' : 'initialRoute'}
      backgroundColor={isIOS26OrLater ? undefined : colors.background}
      indicatorColor={colors.backgroundElement}
      iconColor={{
        default: colors.textSecondary,
        selected: colors.text,
      }}
      labelStyle={{
        default: { color: colors.textSecondary },
        selected: { color: colors.text },
      }}
      rippleColor={colors.backgroundSelected}
      labelVisibilityMode="labeled">
      <NativeTabs.Trigger name="developer">
        <NativeTabs.Trigger.Label>Dev Tools</NativeTabs.Trigger.Label>
        {!brownfieldHost && <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="sky">
        <NativeTabs.Trigger.Label>Sky</NativeTabs.Trigger.Label>
        {!brownfieldHost && <NativeTabs.Trigger.Icon sf="cloud.fill" md="cloud" />}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="spinner">
        <NativeTabs.Trigger.Label>Spinner</NativeTabs.Trigger.Label>
        {!brownfieldHost && <NativeTabs.Trigger.Icon sf="fan.fill" md="toys" />}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
