// @expo/metro-runtime must be the first import for Fast Refresh on web
import '@expo/metro-runtime';

import { registerRootComponent } from 'expo';
import { ExpoRoot } from 'expo-router';
import { useState } from 'react';
import { AppRegistry } from 'react-native';

import { hydrateHostSavedState } from './host-state';
import { configureNavRestore, resolveInitialLocation } from './nav-restore';
import { freshRouteContext, markBrownfieldHost } from './runtime';

const ctx = require.context('../app');

function App() {
  return <ExpoRoot context={ctx} />;
}

// Brownfield entry -- native host passes initialUrl (and the persisted
// component-state store, savedStateJson) via initialProperties. The per-mount
// context identity keeps expo-router from restoring the previous native
// screen's navigation state on Android -- see freshRouteContext. The useState
// is load-bearing twice over: inlining freshRouteContext(ctx) in render would
// mint a new identity every render and reset the router's state mid-session,
// and hydrateHostSavedState must run before the first child render so screens
// read their saved slice on mount.
function BrownfieldApp(props: {
  initialUrl?: string;
  savedStateJson?: string;
  restoreNavState?: boolean;
}) {
  const [state] = useState(() => {
    hydrateHostSavedState(props.savedStateJson);
    // Tab surfaces opt in to resuming their last in-surface path (pushed
    // screens stay fresh-by-design); must run AFTER hydration, before render.
    // With the single persistent root, an OTA reload re-mounts JS with the
    // fragment's stale mount-time initialUrl, so resolveInitialLocation also
    // prefers the `activeTab` slice (the tab the user last selected) over
    // initialUrl -- see nav-restore.ts. Pushed screens pass restoreNavState
    // absent/false and are unaffected.
    configureNavRestore(props.initialUrl, props.restoreNavState === true);
    return {
      context: freshRouteContext(ctx),
      location: resolveInitialLocation(props.initialUrl),
    };
  });
  return <ExpoRoot context={state.context} location={state.location} />;
}

// Brownfield module name -- native host app mounts this key. Mark the runtime
// as brownfield-hosted so reload (and other host-only behaviour) routes through
// the native message bridge rather than expo-updates' reloadAsync().
AppRegistry.registerComponent('OtaGatewayApp', () => {
  markBrownfieldHost();
  return BrownfieldApp;
});

// Standalone + web -- registerRootComponent registers 'main' AND calls
// AppRegistry.runApplication on web to actually render into the DOM
registerRootComponent(App);
