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

const BROWNFIELD_PLUGIN = '@callstack/react-native-brownfield';

/**
 * Inject MARKETING_VERSION into the @callstack/react-native-brownfield
 * plugin's ios.buildSettings. The plugin's Info.plist template sets
 * CFBundleShortVersionString to $(MARKETING_VERSION) but never defines that
 * build setting, so Xcode drops the key from the built framework's Info.plist
 * and App Store uploads reject any host IPA embedding it (ITMS-90057). The
 * value is app.json's expo.version -- the same source that stamps the Android
 * AAR coordinate (./plugins/withBrownfieldAndroidPublishing.js). buildSettings
 * is the plugin's supported passthrough and only applies to the generated
 * OtaGatewayLib target.
 *
 * NOTE: the plugin writes build settings only when it CREATES the target, so a
 * stale generated ios/ dir keeps its old value -- the brownfield CLI's internal
 * `expo prebuild` is not clean (only `pnpm prebuild` deletes ios/), which is
 * why scripts/package-ios.sh verifies the packaged framework's version MATCHES
 * app.json rather than merely existing.
 *
 * Named inject* (the repo's pure-transform convention, like the
 * injectSwift/KotlinUpdates helpers), not with* (reserved for config plugins):
 * this cannot be a plugins/ config plugin because it rewrites the options
 * BOUND TO another plugin before Expo consumes the plugins array, which only
 * the dynamic config function can do. The Android AAR version stamp lives in
 * plugins/withBrownfieldAndroidPublishing.js instead because it must rewrite a
 * brownfield-GENERATED gradle file after the fact.
 */
export function injectIosMarketingVersion(
  plugins: ExpoConfig['plugins'],
  marketingVersion: string | null | undefined,
): ExpoConfig['plugins'] {
  if (!plugins || !marketingVersion) return plugins;
  return plugins.map((entry) => {
    if (!Array.isArray(entry) || entry[0] !== BROWNFIELD_PLUGIN) return entry;
    const options = (entry[1] ?? {}) as { ios?: { buildSettings?: Record<string, unknown> } };
    return [
      entry[0],
      {
        ...options,
        ios: {
          ...options.ios,
          buildSettings: {
            ...options.ios?.buildSettings,
            MARKETING_VERSION: marketingVersion,
          },
        },
      },
    ];
  });
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const gatewayUrls = readGatewayUrls(config);
  const gateway = resolveGateway(gatewayUrls);

  return {
    ...config,
    // Stamps the brownfield framework's CFBundleShortVersionString (App Store
    // gate, see injectIosMarketingVersion above). config.version is app.json's
    // expo.version; when absent the stamp is skipped and package-ios.sh fails
    // the package instead of shipping a version-less framework.
    plugins: injectIosMarketingVersion(config.plugins, config.version),
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
