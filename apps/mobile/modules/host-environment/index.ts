import { requireOptionalNativeModule } from 'expo';

/** The backend environments a native host can select. */
export type HostEnvironment = 'development' | 'production';

interface HostEnvironmentNativeModule {
  /** The host-published environment string, or null when never configured. */
  getEnvironment(): string | null;
}

// Optional: the module exists only in native brownfield/standalone builds.
// On web (and in any build without the native module) this resolves to null
// and getHostEnvironment() reports "no host environment".
const nativeModule =
  requireOptionalNativeModule<HostEnvironmentNativeModule>('HostEnvironment');

/**
 * The backend environment the native host app is pointed at, published by the
 * host BEFORE React Native starts (via the brownfield initialize entry points
 * -- see plugins/withBrownfieldUpdates.js). This is the authoritative signal
 * for which gateway the JS layer must talk to: unlike
 * Constants.expoConfig.extra.gatewayUrl it can neither be stale (cached OTA
 * manifest) nor baked for the wrong environment (shared brownfield artifact).
 *
 * Returns null when no host published an environment (web, standalone builds,
 * Expo Go, Metro dev mode) or the published value is unrecognized -- callers
 * fall back, failing toward production (see src/api/client.ts).
 */
export function getHostEnvironment(): HostEnvironment | null {
  const value = nativeModule?.getEnvironment();
  return value === 'development' || value === 'production' ? value : null;
}
