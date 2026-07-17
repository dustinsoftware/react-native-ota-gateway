// Test-only stub for `@callstack/react-native-brownfield`. The real package
// imports `react-native` (Flow source Vitest can't parse) and touches native
// modules at load. Aliased in vitest.config.ts (test-only). Methods are no-ops;
// tests that assert on bridge calls mock '@/brownfield/message-bridge' directly.
const ReactNativeBrownfield = {
  postMessage(_message: string): void {},
  onMessage(_handler: (message: string) => void): { remove: () => void } {
    return { remove: () => {} };
  },
  popToNative(_animated?: boolean): void {},
};

export default ReactNativeBrownfield;
