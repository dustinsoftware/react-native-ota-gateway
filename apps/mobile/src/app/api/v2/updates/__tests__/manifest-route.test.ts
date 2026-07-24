import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

import { readFileSync } from 'node:fs';

import { GET } from '../manifest+api';

const mockReadFileSync = vi.mocked(readFileSync);

const PLACEHOLDER = '__OTA_GATEWAY_BASE_URL__';
const DEV_GATEWAY = 'https://dev.gateway.test';
const PROD_GATEWAY = 'https://www.gateway.test';
const IOS_BUNDLE = '_expo/static/js/ios/entry-ios.hbc';
const ANDROID_BUNDLE = '_expo/static/js/android/entry-android.hbc';

/** One platform manifest with placeholder-stamped, per-platform-distinct URLs. */
function platformManifest(bundle: string): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    createdAt: '2026-07-14T00:00:00.000Z',
    runtimeVersion: '1',
    launchAsset: {
      url: `${PLACEHOLDER}/api/v2/updates/static/${bundle}`,
      contentType: 'application/javascript',
      key: bundle.split('/').pop(),
      hash: 'deadbeef',
    },
    assets: [
      {
        url: `${PLACEHOLDER}/api/v2/updates/static/assets/img`,
        contentType: 'image/png',
        key: 'img',
        hash: 'cafebabe',
        fileExtension: '.png',
      },
    ],
    metadata: {},
    extra: {
      scopeKey: '@anonymous/ota-gateway-app',
      otaAppVersion: '1.1.162-ac83861',
      expoClient: {
        updates: { url: `${PLACEHOLDER}/api/v2/updates/manifest` },
        extra: { gatewayUrl: PLACEHOLDER },
      },
    },
  };
}

/**
 * One stored update entry whose environment-specific URLs are stamped with the
 * runtime gateway placeholder (as scripts/generate-update-manifest.mjs bakes
 * it), plus the env->host map the route resolves against. The ios/android
 * platform manifests carry distinct bundle URLs so a platform-selection
 * regression is observable. `overrides` lets a test drop the placeholder / map
 * or change the runtimeVersion to exercise the verbatim, unresolvable, and
 * no-update paths.
 */
function updateEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: '1.1.162-ac83861',
    createdAt: '2026-07-14T00:00:00.000Z',
    runtimeVersion: '1',
    otaAppVersion: '1.1.162-ac83861',
    gatewayPlaceholder: PLACEHOLDER,
    gatewayUrls: { development: DEV_GATEWAY, production: PROD_GATEWAY },
    ios: platformManifest(IOS_BUNDLE),
    android: platformManifest(ANDROID_BUNDLE),
    ...overrides,
  };
}

/**
 * A storeVersion-2 update store: newest-first retained updates plus the
 * per-environment channel pointers, defaulting to a single update both
 * channels point at (the shape every fresh export writes).
 */
function storedManifest(
  entryOverrides: Record<string, unknown> = {},
  storeOverrides: Record<string, unknown> = {},
): string {
  const entry = updateEntry(entryOverrides);
  return JSON.stringify({
    storeVersion: 2,
    channels: { development: entry.key, production: entry.key },
    updates: [entry],
    ...storeOverrides,
  });
}

function manifestRequest(
  headers: Record<string, string> = {
    'expo-platform': 'ios',
    'expo-runtime-version': '1',
    'expo-protocol-version': '1',
  },
): Request {
  return new Request('https://gateway.test/api/v2/updates/manifest', { headers });
}

/** Pull the manifest JSON out of the expo multipart/mixed response body. */
async function parseManifestBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const afterHeaders = text.split('\r\n\r\n')[1] ?? '';
  const json = afterHeaders.split('\r\n--expo-update-response--')[0];
  return JSON.parse(json) as Record<string, unknown>;
}

const savedEnv = process.env.OTA_ENVIRONMENT;

beforeEach(() => {
  mockReadFileSync.mockReset();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.OTA_ENVIRONMENT;
  else process.env.OTA_ENVIRONMENT = savedEnv;
});

describe('GET /api/v2/updates/manifest -- runtime gateway resolution', () => {
  it('rewrites the placeholder to the production gateway when OTA_ENVIRONMENT=production', async () => {
    process.env.OTA_ENVIRONMENT = 'production';
    mockReadFileSync.mockReturnValueOnce(storedManifest());

    const res = await GET(manifestRequest());
    expect(res.status).toBe(200);

    const manifest = (await parseManifestBody(res)) as {
      launchAsset: { url: string };
      assets: { url: string }[];
      extra: { expoClient: { updates: { url: string }; extra: { gatewayUrl: string } } };
    };
    expect(manifest.launchAsset.url).toBe(`${PROD_GATEWAY}/api/v2/updates/static/${IOS_BUNDLE}`);
    expect(manifest.assets[0].url).toBe(`${PROD_GATEWAY}/api/v2/updates/static/assets/img`);
    expect(manifest.extra.expoClient.updates.url).toBe(`${PROD_GATEWAY}/api/v2/updates/manifest`);
    expect(manifest.extra.expoClient.extra.gatewayUrl).toBe(PROD_GATEWAY);
    // No placeholder must survive into the served manifest.
    expect(JSON.stringify(manifest)).not.toContain(PLACEHOLDER);
  });

  it('rewrites the placeholder to the dev gateway when OTA_ENVIRONMENT is unset', async () => {
    delete process.env.OTA_ENVIRONMENT;
    mockReadFileSync.mockReturnValueOnce(storedManifest());

    const manifest = (await parseManifestBody(await GET(manifestRequest()))) as {
      launchAsset: { url: string };
      extra: { expoClient: { extra: { gatewayUrl: string } } };
    };
    expect(manifest.launchAsset.url).toBe(`${DEV_GATEWAY}/api/v2/updates/static/${IOS_BUNDLE}`);
    expect(manifest.extra.expoClient.extra.gatewayUrl).toBe(DEV_GATEWAY);
  });

  it('treats any non-"production" OTA_ENVIRONMENT as dev (strict match)', async () => {
    process.env.OTA_ENVIRONMENT = 'PRODUCTION ';
    mockReadFileSync.mockReturnValueOnce(storedManifest());

    const manifest = (await parseManifestBody(await GET(manifestRequest()))) as {
      launchAsset: { url: string };
    };
    expect(manifest.launchAsset.url).toBe(`${DEV_GATEWAY}/api/v2/updates/static/${IOS_BUNDLE}`);
  });

  it('serves the android manifest (not ios) for expo-platform: android', async () => {
    process.env.OTA_ENVIRONMENT = 'production';
    mockReadFileSync.mockReturnValueOnce(storedManifest());

    const res = await GET(
      manifestRequest({
        'expo-platform': 'android',
        'expo-runtime-version': '1',
        'expo-protocol-version': '1',
      }),
    );
    const manifest = (await parseManifestBody(res)) as { launchAsset: { url: string } };
    // The android bundle differs from ios, so this also proves platform selection.
    expect(manifest.launchAsset.url).toBe(`${PROD_GATEWAY}/api/v2/updates/static/${ANDROID_BUNDLE}`);
  });

  it('serves a per-environment update id (never the baked id, never shared across envs)', async () => {
    // expo-updates treats update ids as globally unique: if dev and prod served
    // the baked (bundle-content) id, a client that cached the update in one
    // environment would relaunch the cached manifest -- stale gatewayUrl and
    // all -- after switching to the other. The route must serve ids that are
    // deterministic per environment and distinct between environments.
    const bakedId = '00000000-0000-0000-0000-000000000000';

    delete process.env.OTA_ENVIRONMENT;
    mockReadFileSync.mockReturnValueOnce(storedManifest());
    const devManifest = (await parseManifestBody(await GET(manifestRequest()))) as { id: string };

    mockReadFileSync.mockReturnValueOnce(storedManifest());
    const devManifestAgain = (await parseManifestBody(await GET(manifestRequest()))) as {
      id: string;
    };

    process.env.OTA_ENVIRONMENT = 'production';
    mockReadFileSync.mockReturnValueOnce(storedManifest());
    const prodManifest = (await parseManifestBody(await GET(manifestRequest()))) as { id: string };

    // Deterministic per environment (repeat requests serve the same id) ...
    expect(devManifest.id).toBe(devManifestAgain.id);
    // ... never the baked environment-neutral id ...
    expect(devManifest.id).not.toBe(bakedId);
    expect(prodManifest.id).not.toBe(bakedId);
    // ... and never shared between environments.
    expect(devManifest.id).not.toBe(prodManifest.id);
    // Golden values pin the exact derivation (sha256 of "<bakedId>\n<base>",
    // first 32 hex chars as 8-4-4-4-12). Ids must stay byte-stable across
    // container restarts and redeploys of the same build -- an algorithm tweak
    // that mints different ids on the next deploy would re-trigger the very
    // cached-update churn this scheme prevents, while every relative assertion
    // above stayed green. Recompute both values if the derivation is
    // deliberately changed.
    expect(devManifest.id).toBe('878f1c85-6655-3a77-b8d5-4bfcf08d8347');
    expect(prodManifest.id).toBe('6682ec2c-2d25-87b2-fc0c-f3bd7b24495a');
  });

  it('serves the manifest verbatim when no placeholder was baked (concrete-host export)', async () => {
    process.env.OTA_ENVIRONMENT = 'production';
    // A manifest pinned to a concrete host omits gatewayPlaceholder/gatewayUrls.
    mockReadFileSync.mockReturnValueOnce(
      storedManifest({
        gatewayPlaceholder: undefined,
        gatewayUrls: undefined,
        ios: {
          id: '11111111-1111-1111-1111-111111111111',
          runtimeVersion: '1',
          launchAsset: { url: 'https://pinned.test/api/v2/updates/static/x', key: 'x', hash: 'h', contentType: 'application/javascript' },
          assets: [],
          metadata: {},
          extra: {},
        },
      }),
    );

    const manifest = (await parseManifestBody(await GET(manifestRequest()))) as {
      id: string;
      launchAsset: { url: string };
    };
    expect(manifest.launchAsset.url).toBe('https://pinned.test/api/v2/updates/static/x');
    // A pinned export is already environment-specific: its baked id is served
    // as-is (no per-environment re-derivation).
    expect(manifest.id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('withholds the update (204) and logs when the placeholder cannot be resolved', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OTA_ENVIRONMENT = 'production';
    // Placeholder present but no gateway hosts configured -> unresolvable.
    mockReadFileSync.mockReturnValueOnce(storedManifest({ gatewayUrls: {} }));

    const res = await GET(manifestRequest());
    expect(res.status).toBe(204);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no gateway URL resolves'));
    errorSpy.mockRestore();
  });

  it('does NOT fall back to dev when a production container is missing its production host', async () => {
    // Regression guard for the silent prod->dev fallback: a production container
    // whose manifest lacks a production gateway must withhold, never serve dev.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OTA_ENVIRONMENT = 'production';
    mockReadFileSync.mockReturnValueOnce(
      storedManifest({ gatewayUrls: { development: DEV_GATEWAY } }),
    );

    const res = await GET(manifestRequest());
    expect(res.status).toBe(204);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no gateway URL resolves'));
    errorSpy.mockRestore();
  });

  describe('pre-existing request/read handling', () => {
    it('rejects an unsupported platform with 400', async () => {
      const res = await GET(
        manifestRequest({
          'expo-platform': 'windows',
          'expo-runtime-version': '1',
          'expo-protocol-version': '1',
        }),
      );
      expect(res.status).toBe(400);
    });

    it('rejects an unsupported protocol version with 406', async () => {
      const res = await GET(
        manifestRequest({
          'expo-platform': 'ios',
          'expo-runtime-version': '1',
          'expo-protocol-version': '2',
        }),
      );
      expect(res.status).toBe(406);
    });

    it('returns 204 (no update) without logging when the manifest is absent (ENOENT)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const enoent = new Error('not found') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      mockReadFileSync.mockImplementationOnce(() => {
        throw enoent;
      });

      const res = await GET(manifestRequest());
      expect(res.status).toBe(204);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('returns 500 and logs on a real (non-ENOENT) read failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const eacces = new Error('permission denied') as NodeJS.ErrnoException;
      eacces.code = 'EACCES';
      mockReadFileSync.mockImplementationOnce(() => {
        throw eacces;
      });

      const res = await GET(manifestRequest());
      expect(res.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith(
        '[updates/manifest] Failed to read update manifest:',
        eacces,
      );
      errorSpy.mockRestore();
    });

    it('returns 204 when the client runtime version does not match', async () => {
      mockReadFileSync.mockReturnValueOnce(storedManifest());
      const res = await GET(
        manifestRequest({
          'expo-platform': 'ios',
          'expo-runtime-version': '2',
          'expo-protocol-version': '1',
        }),
      );
      expect(res.status).toBe(204);
    });

    it('returns 204 when the manifest has no entry for the platform', async () => {
      mockReadFileSync.mockReturnValueOnce(storedManifest({ ios: undefined }));
      const res = await GET(manifestRequest());
      expect(res.status).toBe(204);
    });
  });

  describe('store v2 selection (channels, pin, retention)', () => {
    const savedPin = process.env.OTA_UPDATE_PIN;

    afterEach(() => {
      if (savedPin === undefined) delete process.env.OTA_UPDATE_PIN;
      else process.env.OTA_UPDATE_PIN = savedPin;
    });

    function twoUpdateStore(channels: Record<string, string>): string {
      // Newest first, distinct bundles so the served entry is observable.
      const newer = updateEntry({ key: 'v2-key' });
      const older = updateEntry({
        key: 'v1-key',
        createdAt: '2026-07-01T00:00:00.000Z',
        ios: platformManifest('_expo/static/js/ios/entry-old.hbc'),
      });
      return JSON.stringify({ storeVersion: 2, channels, updates: [newer, older] });
    }

    it("serves the environment's channel pointer, not just the newest update", async () => {
      // Production repointed at the RETAINED older update (a rollback) while
      // development stays on the newest -- the core blue/green lever.
      process.env.OTA_ENVIRONMENT = 'production';
      delete process.env.OTA_UPDATE_PIN;
      mockReadFileSync.mockReturnValueOnce(
        twoUpdateStore({ development: 'v2-key', production: 'v1-key' }),
      );

      const manifest = (await parseManifestBody(await GET(manifestRequest()))) as {
        launchAsset: { url: string };
      };
      expect(manifest.launchAsset.url).toBe(
        `${PROD_GATEWAY}/api/v2/updates/static/_expo/static/js/ios/entry-old.hbc`,
      );
    });

    it('OTA_UPDATE_PIN overrides the channel pointer (per-instance rollback)', async () => {
      delete process.env.OTA_ENVIRONMENT;
      process.env.OTA_UPDATE_PIN = 'v1-key';
      mockReadFileSync.mockReturnValueOnce(
        twoUpdateStore({ development: 'v2-key', production: 'v2-key' }),
      );

      const manifest = (await parseManifestBody(await GET(manifestRequest()))) as {
        launchAsset: { url: string };
      };
      expect(manifest.launchAsset.url).toBe(
        `${DEV_GATEWAY}/api/v2/updates/static/_expo/static/js/ios/entry-old.hbc`,
      );
    });

    it('falls back to the newest retained update, loudly, on a dangling pointer', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      delete process.env.OTA_ENVIRONMENT;
      delete process.env.OTA_UPDATE_PIN;
      mockReadFileSync.mockReturnValueOnce(
        twoUpdateStore({ development: 'pruned-key', production: 'v2-key' }),
      );

      const manifest = (await parseManifestBody(await GET(manifestRequest()))) as {
        launchAsset: { url: string };
      };
      // Newest-first entry served, and the dangling pointer surfaced in logs.
      expect(manifest.launchAsset.url).toBe(`${DEV_GATEWAY}/api/v2/updates/static/${IOS_BUNDLE}`);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No retained update matches'));
      errorSpy.mockRestore();
    });

    it('freezes (204) on a pinned update with an incompatible runtimeVersion -- never falls forward', async () => {
      // The pin exists for rollback/canary: a container pinned to a retained
      // key whose runtime no longer matches the client must WITHHOLD, not
      // silently serve the newest compatible update instead.
      delete process.env.OTA_ENVIRONMENT;
      process.env.OTA_UPDATE_PIN = 'v1-key';
      const newer = updateEntry({ key: 'v2-key' });
      const older = updateEntry({ key: 'v1-key', runtimeVersion: '2' });
      mockReadFileSync.mockReturnValueOnce(
        JSON.stringify({
          storeVersion: 2,
          channels: { development: 'v2-key', production: 'v2-key' },
          updates: [newer, older],
        }),
      );

      const res = await GET(manifestRequest());
      expect(res.status).toBe(204);
    });

    it('returns 500 and logs on an unsupported store version', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockReadFileSync.mockReturnValueOnce(
        JSON.stringify({ runtimeVersion: '1', ios: platformManifest(IOS_BUNDLE) }),
      );

      const res = await GET(manifestRequest());
      expect(res.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unsupported store version'));
      errorSpy.mockRestore();
    });

    it('returns 204 when the store retains no updates', async () => {
      mockReadFileSync.mockReturnValueOnce(
        JSON.stringify({ storeVersion: 2, channels: {}, updates: [] }),
      );
      const res = await GET(manifestRequest());
      expect(res.status).toBe(204);
    });
  });
});
