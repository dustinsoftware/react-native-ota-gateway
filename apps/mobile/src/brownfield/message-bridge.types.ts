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
  | { type: 'saveState'; key: string; state: Record<string, unknown> };

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

export const nativeToRNSchema = z.discriminatedUnion('type', [
  featureFlagSchema,
  configSchema,
]);

export type NativeToRNMessage = z.infer<typeof nativeToRNSchema>;
