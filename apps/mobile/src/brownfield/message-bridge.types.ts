import { z } from 'zod';

// -- RN -> Native messages ---------------------------------------------------

export type RNToNativeMessage =
  | { type: 'navigate'; destination: string; params?: Record<string, string> }
  | { type: 'logout' }
  | { type: 'analytics'; event: string; properties?: Record<string, unknown> }
  // Asks the native host to reload the React Native root. Used in place of
  // expo-updates' reloadAsync(), which crashes in a brownfield app because the
  // native host (not expo-updates) owns the RN view lifecycle.
  | { type: 'reload' }
  // Checkpoints a piece of RN component state into the HOST's native store
  // (SharedPreferences / UserDefaults). The host injects the whole store back
  // as the `savedStateJson` initial property on every RN surface it mounts, so
  // a dismissed component resumes exactly where it left off (see
  // src/brownfield/host-state.ts).
  | { type: 'saveState'; key: string; state: Record<string, unknown> }
  // Announces that the tab surface's `selectTab` listener is subscribed and
  // ready (posted once per tab-surface mount by TabSelectGuard). Closes the
  // lost-message window on cold start: a native tab tap after the TurboModule
  // event emitter wires up but BEFORE the JS listener subscribes is emitted
  // into the void. On receipt the host re-posts the currently selected tab;
  // the JS handler is idempotent (already-there routes no-op). Hosts that
  // predate this type simply ignore it (docs/version-skew.md).
  | { type: 'tabsReady' };

// -- Native -> RN messages ---------------------------------------------------

export const featureFlagSchema = z.object({
  type: z.literal('featureFlag'),
  key: z.string(),
  enabled: z.boolean(),
});

export const configSchema = z.object({
  type: z.literal('config'),
  payload: z.record(z.string(), z.unknown()),
});

// Selects one of the shell's persistent-root tabs. Under the single-root
// design (docs/single-root-tabs-experiment.md) the host does NOT remount an
// RN surface per tab tap: it posts this message and the RN app drives the tab
// change in place (see src/components/tab-select-guard.tsx). `route` stays a
// bare string here on purpose -- the bridge is untrusted input, so the SET of
// known tab routes is validated in the handler, not the schema; an unknown or
// malformed route is silently ignored (the documented skew guarantee).
export const selectTabSchema = z.object({
  type: z.literal('selectTab'),
  route: z.string(),
});

export const nativeToRNSchema = z.discriminatedUnion('type', [
  featureFlagSchema,
  configSchema,
  selectTabSchema,
]);

export type NativeToRNMessage = z.infer<typeof nativeToRNSchema>;
