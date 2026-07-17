// Test-only stub for `react-native`. The real package ships Flow-typed source
// the Vitest transformer can't parse, and unit tests only need a couple of
// surfaces. Aliased in vitest.config.ts (test-only -- the app build uses Metro,
// which does not read that config). Extend as tests require.
export const Platform = { OS: 'ios' as 'ios' | 'android' | 'web' };
