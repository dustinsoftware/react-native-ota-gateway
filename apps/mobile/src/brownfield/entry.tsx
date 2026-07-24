// @expo/metro-runtime must be the first import for Fast Refresh on web
import '@expo/metro-runtime';

import { registerRootComponent } from 'expo';
import { ExpoRoot } from 'expo-router';
import { useState } from 'react';
import { AppRegistry } from 'react-native';

import { setHostSavedState } from './host-state';
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
// and setHostSavedState must run before the first child render so screens
// read their saved slice on mount.
function BrownfieldApp(props: { initialUrl?: string; savedStateJson?: string }) {
  const [context] = useState(() => {
    setHostSavedState(props.savedStateJson);
    return freshRouteContext(ctx);
  });
  return <ExpoRoot context={context} location={props.initialUrl} />;
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
