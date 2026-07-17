import type { ConfigContext, ExpoConfig } from 'expo/config';
import { afterEach, describe, expect, it } from 'vitest';

import appJson from '../app.json';
import appConfig, { resolveGateway, injectIosMarketingVersion } from '../app.config';

const URLS = {
  development: 'https://dev.test.example',
  production: 'https://www.test.example',
};

const savedEnvironment = process.env.OTA_ENVIRONMENT;
const savedOverride = process.env.OTA_GATEWAY_URL;

afterEach(() => {
  if (savedEnvironment === undefined) delete process.env.OTA_ENVIRONMENT;
  else process.env.OTA_ENVIRONMENT = savedEnvironment;
  if (savedOverride === undefined) delete process.env.OTA_GATEWAY_URL;
  else process.env.OTA_GATEWAY_URL = savedOverride;
});

/**
 * Pins the bake-side fail-toward-production polarity: only an explicit
 * OTA_ENVIRONMENT=development may select the dev gateway. A future
 * "consistency cleanup" aligning this with the server's strict
 * === 'production' checks would bake dev into shipped frameworks -- this
 * suite makes that regression unmergeable.
 */
describe('app.config resolveGateway', () => {
  it('defaults to the production gateway when OTA_ENVIRONMENT is unset', () => {
    delete process.env.OTA_ENVIRONMENT;
    delete process.env.OTA_GATEWAY_URL;
    expect(resolveGateway(URLS)).toBe(URLS.production);
  });

  it('treats anything other than exactly "development" as production', () => {
    delete process.env.OTA_GATEWAY_URL;
    for (const value of ['production', 'Development', 'dev', 'staging', '']) {
      process.env.OTA_ENVIRONMENT = value;
      expect(resolveGateway(URLS)).toBe(URLS.production);
    }
  });

  it('selects the dev gateway only on an explicit development opt-in', () => {
    delete process.env.OTA_GATEWAY_URL;
    process.env.OTA_ENVIRONMENT = 'development';
    expect(resolveGateway(URLS)).toBe(URLS.development);
  });

  it('lets OTA_GATEWAY_URL override the selection, trimming trailing slashes', () => {
    process.env.OTA_ENVIRONMENT = 'development';
    process.env.OTA_GATEWAY_URL = 'https://pinned.test.example///';
    expect(resolveGateway(URLS)).toBe('https://pinned.test.example');
  });
});

/**
 * Pins the App Store versioning fix: the brownfield plugin's Info.plist
 * template references $(MARKETING_VERSION) but never sets it, so without this
 * injection the packaged OtaGatewayLib.framework ships without
 * CFBundleShortVersionString and App Store uploads of a host IPA embedding it
 * fail (ITMS-90057).
 */
describe('app.config injectIosMarketingVersion', () => {
  const BROWNFIELD_ENTRY: [string, Record<string, unknown>] = [
    '@callstack/react-native-brownfield',
    {
      ios: { frameworkName: 'OtaGatewayLib', bundleIdentifier: 'dev.test.brownfield' },
      android: { moduleName: 'otagatewaylib' },
    },
  ];
  const PLUGINS: ExpoConfig['plugins'] = [
    'expo-updates',
    './plugins/withBrownfieldUpdates.js',
    BROWNFIELD_ENTRY,
  ];

  it('injects MARKETING_VERSION into the brownfield plugin ios.buildSettings', () => {
    const result = injectIosMarketingVersion(PLUGINS, '1.2.3');
    const [, options] = result!.find(
      (p) => Array.isArray(p) && p[0] === '@callstack/react-native-brownfield',
    ) as [string, { ios: Record<string, unknown> }];
    expect(options.ios).toEqual({
      frameworkName: 'OtaGatewayLib',
      bundleIdentifier: 'dev.test.brownfield',
      buildSettings: { MARKETING_VERSION: '1.2.3' },
    });
  });

  it('preserves other plugins and non-ios options untouched', () => {
    const result = injectIosMarketingVersion(PLUGINS, '1.2.3');
    expect(result![0]).toBe('expo-updates');
    expect(result![1]).toBe('./plugins/withBrownfieldUpdates.js');
    const [, options] = result![2] as [string, { android: unknown }];
    expect(options.android).toEqual({ moduleName: 'otagatewaylib' });
    // The source entry must not be mutated.
    expect(BROWNFIELD_ENTRY[1].ios).toEqual({
      frameworkName: 'OtaGatewayLib',
      bundleIdentifier: 'dev.test.brownfield',
    });
  });

  it('merges with pre-existing buildSettings instead of replacing them', () => {
    const plugins: ExpoConfig['plugins'] = [
      ['@callstack/react-native-brownfield', { ios: { buildSettings: { OTHER_SETTING: 'YES' } } }],
    ];
    const [, options] = injectIosMarketingVersion(plugins, '1.2.3')![0] as [
      string,
      { ios: { buildSettings: Record<string, unknown> } },
    ];
    expect(options.ios.buildSettings).toEqual({ OTHER_SETTING: 'YES', MARKETING_VERSION: '1.2.3' });
  });

  it('leaves plugins unchanged when no version is available', () => {
    expect(injectIosMarketingVersion(PLUGINS, undefined)).toBe(PLUGINS);
    expect(injectIosMarketingVersion(PLUGINS, null)).toBe(PLUGINS);
    // Empty string skips too (the package gate then fails loudly), rather
    // than stamping an empty MARKETING_VERSION.
    expect(injectIosMarketingVersion(PLUGINS, '')).toBe(PLUGINS);
    expect(injectIosMarketingVersion(undefined, '1.2.3')).toBeUndefined();
  });
});

/**
 * Wiring tests: the helper above is only useful if the default export actually
 * applies it. Deleting the `plugins:` line from the default export would
 * reintroduce ITMS-90057 while every helper unit test stays green -- these pin
 * the seam.
 */
describe('app.config default export', () => {
  it('stamps expo.version as MARKETING_VERSION into the brownfield plugin', () => {
    delete process.env.OTA_ENVIRONMENT;
    delete process.env.OTA_GATEWAY_URL;
    const config = {
      name: 'test-app',
      slug: 'test-app',
      version: '9.9.9',
      extra: { gatewayUrls: URLS },
      plugins: [
        'expo-updates',
        ['@callstack/react-native-brownfield', { ios: { frameworkName: 'OtaGatewayLib' } }],
      ],
    } as unknown as ConfigContext['config'];

    const result = appConfig({ config } as ConfigContext);

    const [, options] = result.plugins!.find(
      (p) => Array.isArray(p) && p[0] === '@callstack/react-native-brownfield',
    ) as [string, { ios: { buildSettings: Record<string, unknown> } }];
    expect(options.ios.buildSettings.MARKETING_VERSION).toBe('9.9.9');
  });

  it('stamps the real app.json config end to end', () => {
    // The other tests use hand-built configs; this one drives the actual
    // app.json expo config through the real default export so the guarantee
    // "the shipped config gets the stamp" is pinned directly, not assembled
    // from shape/semver proxies.
    delete process.env.OTA_ENVIRONMENT;
    delete process.env.OTA_GATEWAY_URL;
    const result = appConfig({
      config: appJson.expo as unknown as ConfigContext['config'],
    } as ConfigContext);
    const [, options] = result.plugins!.find(
      (p) => Array.isArray(p) && p[0] === '@callstack/react-native-brownfield',
    ) as [string, { ios: { buildSettings: Record<string, unknown> } }];
    expect(options.ios.buildSettings.MARKETING_VERSION).toBe(appJson.expo.version);
  });

  it('app.json keeps the brownfield plugin entry in [name, options] tuple form', () => {
    // injectIosMarketingVersion deliberately skips non-tuple entries (a bare
    // string entry has no options to merge into), so app.json regressing to
    // the string form would silently stop the stamping. Pin the shape here so
    // that regression fails at PR time, not at package time.
    const entry = (appJson.expo.plugins as unknown[]).find(
      (p) => Array.isArray(p) && p[0] === '@callstack/react-native-brownfield',
    ) as [string, { ios?: Record<string, unknown> }] | undefined;
    expect(entry).toBeDefined();
    expect(entry![1].ios).toBeDefined();
  });

  it('app.json declares the expo.version that supplies MARKETING_VERSION', () => {
    expect(appJson.expo.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
