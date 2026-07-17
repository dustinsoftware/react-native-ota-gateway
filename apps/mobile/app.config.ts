import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dynamic Expo config. Selects the gateway host at build time so iOS/Android
 * (and web) builds point at the right environment. The per-environment hosts
 * live in app.json (`extra.gatewayUrls`); this selects between them and
 * derives the updates manifest URLs.
 *
 * Selection (default PRODUCTION -- a baked gateway must never silently point
 * at dev; embedded launches that reach the baked value must land on
 * production):
 *   OTA_GATEWAY_URL=<url>          explicit override (wins)
 *   OTA_ENVIRONMENT=development    -> dev gateway (explicit opt-in only)
 *   otherwise (incl. unset/typo)   -> production gateway
 *
 * Example: `OTA_ENVIRONMENT=development pnpm prebuild --ios` bakes the dev
 * gateway into the iOS project; a plain build defaults to production. The
 * brownfield packaging scripts (scripts/package-ios.sh, the
 * brownfield:*:android package scripts) additionally force
 * OTA_ENVIRONMENT=production so a framework release always bakes
 * production regardless of the caller's shell. In brownfield builds the
 * baked value is only the standalone fallback anyway: the host publishes its
 * live environment to JS at boot (modules/host-environment) and
 * src/api/client.ts resolves the gateway from extra.gatewayUrls.
 *
 * Both environments' manifest URLs are also published as `extra.updatesUrls`,
 * which ./plugins/withBrownfieldUpdates.js bakes into the brownfield artifacts
 * (Expo.plist keys on iOS, generated Kotlin on Android) so the HOST app can
 * pick the environment at runtime.
 */
const UPDATES_MANIFEST_PATH = '/api/v2/updates/manifest';

interface GatewayUrls {
  development: string;
  production: string;
}

function readGatewayUrls(config: ConfigContext['config']): GatewayUrls {
  const urls = config.extra?.gatewayUrls as Partial<GatewayUrls> | undefined;
  if (!urls?.development || !urls?.production) {
    throw new Error(
      '[app.config] app.json is missing extra.gatewayUrls.development/production',
    );
  }
  return { development: urls.development, production: urls.production };
}

// Exported for tests, which pin the fail-toward-production polarity (a wrong
// default here bakes dev into a shipped framework -- outage-grade, so it must
// not be guarded by prose alone).
export function resolveGateway(urls: GatewayUrls): string {
  const override = process.env.OTA_GATEWAY_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  // Fail toward production: only an explicit `development` selects the dev
  // gateway. This is the opposite polarity of the server's strict
  // `=== 'production'` checks (manifest route) -- deliberately so: a
  // misconfigured SERVER should degrade to dev/withhold, but a misbaked
  // CLIENT pointing real users at dev is an outage.
  return process.env.OTA_ENVIRONMENT === 'development' ? urls.development : urls.production;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const gatewayUrls = readGatewayUrls(config);
  const gateway = resolveGateway(gatewayUrls);

  return {
    ...config,
    name: config.name ?? 'ota-gateway-app',
    slug: config.slug ?? 'ota-gateway-app',
    updates: {
      ...config.updates,
      url: `${gateway}${UPDATES_MANIFEST_PATH}`,
    },
    extra: {
      ...config.extra,
      // Consumed at runtime by the client (src/api/client.ts) for BFF requests.
      gatewayUrl: gateway,
      // Consumed at prebuild by ./plugins/withBrownfieldUpdates.js: both
      // environments' manifest URLs ship in the brownfield artifacts so the
      // host app can select dev or production at runtime.
      updatesUrls: {
        development: `${gatewayUrls.development}${UPDATES_MANIFEST_PATH}`,
        production: `${gatewayUrls.production}${UPDATES_MANIFEST_PATH}`,
      },
    },
  };
};
