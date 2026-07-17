import type { HostEnvironment } from '../../modules/host-environment';

/**
 * Last-resort gateway. Deliberately PRODUCTION: a build that reaches this
 * fallback is misconfigured, and pointing real users at production is safe
 * while pointing them at dev is an outage (and leaks traffic into a test
 * tier). Never default to dev.
 *
 * Must match app.json extra.gatewayUrls.production; kept as a literal so a
 * broken or absent config cannot misdirect the fallback.
 */
export const PRODUCTION_GATEWAY_URL = 'http://localhost:3001';

/** The gateway-related keys of Constants.expoConfig.extra (app.json). */
export interface GatewayExtra {
  gatewayUrl?: string;
  gatewayUrls?: Partial<Record<HostEnvironment, string>>;
}

/**
 * Resolves the gateway base URL for BFF requests.
 *
 * Precedence:
 * 1. Host-selected environment (brownfield): the native host publishes its
 *    environment before RN boots (modules/host-environment); resolve it
 *    against the env->URL map (`extra.gatewayUrls`), which is identical in
 *    every bundle and manifest, so it cannot go stale. This is authoritative:
 *    the single-valued `extra.gatewayUrl` is whatever environment the bundle
 *    happened to be exported for, and on OTA launches it is the CACHED
 *    manifest's value -- both wrong across a host environment switch.
 * 2. No host environment (standalone native builds): the build-selected
 *    `extra.gatewayUrl` (framework/app releases always bake production --
 *    see app.config.ts).
 * 3. Production, never dev (see PRODUCTION_GATEWAY_URL).
 */
export function resolveGatewayUrl(
  hostEnvironment: HostEnvironment | null,
  extra: GatewayExtra | undefined,
): string {
  // `||` (not `??`): an empty-string entry is as misconfigured as a missing
  // one and must also fail toward production, never resolve to a relative '/'.
  if (hostEnvironment) {
    // A host that published an environment but whose config lacks the map is
    // misconfigured (the map ships in the same artifact as this code); fail
    // toward production rather than trust a possibly-dev baked gatewayUrl.
    return extra?.gatewayUrls?.[hostEnvironment] || PRODUCTION_GATEWAY_URL;
  }
  return extra?.gatewayUrl || PRODUCTION_GATEWAY_URL;
}
