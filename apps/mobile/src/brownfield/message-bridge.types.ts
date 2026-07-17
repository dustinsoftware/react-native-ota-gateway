import { z } from 'zod';

// -- RN -> Native messages ---------------------------------------------------

export type RNToNativeMessage =
  | { type: 'navigate'; destination: string; params?: Record<string, string> }
  | { type: 'logout' }
  | { type: 'analytics'; event: string; properties?: Record<string, unknown> }
  // Asks the native host to reload the React Native root. Used in place of
  // expo-updates' reloadAsync(), which crashes in a brownfield app because the
  // native host (not expo-updates) owns the RN view lifecycle.
  | { type: 'reload' };

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
