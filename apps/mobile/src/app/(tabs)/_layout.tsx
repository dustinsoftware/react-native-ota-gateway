import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import React from 'react';

import AppTabs from '@/components/app-tabs';

/**
 * Tab group layout. Renders the tab bar on both platforms: NativeTabs on mobile
 * (app-tabs.tsx) and the JS <Tabs> navigator on web (app-tabs.web.tsx). Tabs:
 * Dev Tools (developer), Sky, and Spinner.
 */
export default function TabsLayout() {
  return (
    <ThemeProvider value={DarkTheme}>
      <AppTabs />
    </ThemeProvider>
  );
}
