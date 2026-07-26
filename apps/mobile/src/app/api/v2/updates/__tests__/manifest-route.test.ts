import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

import { readFileSync } from 'node:fs';

import { GET } from '../manifest+api';

const mockReadFileSync = vi.mocked(readFileSync);

const DEV_GATEWAY = 'https://dev.gateway.test';
const PROD_GATEWAY = 'https://www.gateway.test';

/**
 * Build a pre-signed variant. The route serves `body` verbatim and copies
 * `signature` into the expo-signature header, so the values here are opaque
 * markers -- the route does no cryptography (signing happens at export time).
 */
function variant(marker: string): { body: string; signature: string } {
  return {
    body: JSON.stringify({ id: `id-${marker}`, gateway: marker, launchAsset: { url: `${marker}/x` } }),
    signature: `sig="sig-${marker}", keyid="main"`,
  };
}

const IOS_DEV = variant('ios-dev');
const IOS_PROD = variant('ios-prod');
const ANDROID_DEV = variant('android-dev');
const ANDROID_PROD = variant('android-prod');

/**
 * One storeVersion-3 stored update: per-platform, per-environment pre-signed
 * variants (distinct markers so platform + environment selection is
 * observable). `overrides` lets a test drop a platform / variant or change the
 * runtimeVersion to exercise the withhold and no-update paths.
 */
function updateEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: '1.1.162-ac83861',
    createdAt: '2026-07-14T00:00:00.000Z',
    runtimeVersion: '1',
    otaAppVersion: '1.1.162-ac83861',
    ios: { development: IOS_DEV, production: IOS_PROD },
    android: { development: ANDROID_DEV, production: ANDROID_PROD },
    ...overrides,
  };
}

/** A storeVersion-3 store: newest-first updates + per-environment pointers. */
function storedManifest(
  entryOverrides: Record<string, unknown> = {},
  storeOverrides: Record<string, unknown> = {},
): string {
  const entry = updateEntry(entryOverrides);
  return JSON.stringify({
    storeVersion: 3,
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

/** Pull the raw manifest part bytes out of the expo multipart/mixed body. */
function rawManifestPart(text: string): string {
  const afterHeaders = text.split('\r\n\r\n')[1] ?? '';
  return afterHeaders.split('\r\n--expo-update-response--')[0];
}

/**
 * Extract the expo-signature header FROM THE MANIFEST PART, the way the
 * expo-updates client does for multipart responses (it ignores the top-level
 * HTTP header in the multipart branch).
 */
function partSignature(text: string): string | undefined {
  const partHeaderBlock = text.split('\r\n\r\n')[0] ?? '';
  const line = partHeaderBlock
    .split('\r\n')
    .find((l) => l.toLowerCase().startsWith('expo-signature:'));
  return line?.slice(line.indexOf(':') + 1).trim();
}

const savedEnv = process.env.OTA_ENVIRONMENT;

beforeEach(() => {
  mockReadFileSync.mockReset();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.OTA_ENVIRONMENT;
  else process.env.OTA_ENVIRONMENT = savedEnv;
});

describe('GET /api/v2/updates/manifest -- pre-signed variant selection', () => {
  it('serves the production variant body verbatim + its expo-signature when OTA_ENVIRONMENT=production', async () => {
    process.env.OTA_ENVIRONMENT = 'production';
    mockReadFileSync.mockReturnValueOnce(storedManifest());

    const res = await GET(manifestRequest());
    expect(res.status).toBe(200);
    const text = await res.text();
    // Body is byte-for-byte the stored variant (no parse/re-stringify, so the
    // signature still covers the served bytes).
    expect(rawManifestPart(text)).toBe(IOS_PROD.body);
    // The client reads the signature from the PART headers in the multipart
    // branch; the HTTP-level header is set too for curl-ability.
    expect(partSignature(text)).toBe(IOS_PROD.signature);
    expect(res.headers.get('expo-signature')).toBe(IOS_PROD.signature);
    expect(res.headers.get('content-type')).toContain('multipart/mixed');
  });

  it('serves the dev variant when OTA_ENVIRONMENT is unset', async () => {
    delete process.env.OTA_ENVIRONMENT;
    mockReadFileSync.mockReturnValueOnce(storedManifest());

    const res = await GET(manifestRequest());
    const text = await res.text();
    expect(rawManifestPart(text)).toBe(IOS_DEV.body);
    expect(partSignature(text)).toBe(IOS_DEV.signature);
  });

  it('treats any non-"production" OTA_ENVIRONMENT as dev (strict match)', async () => {
    process.env.OTA_ENVIRONMENT = 'PRODUCTION ';
    mockReadFileSync.mockReturnValueOnce(storedManifest());

    const res = await GET(manifestRequest());
    expect(rawManifestPart(await res.text())).toBe(IOS_DEV.body);
  });

  it('serves the android variant (not ios) for expo-platform: android', async () => {
    process.env.OTA_ENVIRONMENT = 'production';
    mockReadFileSync.mockReturnValueOnce(storedManifest());

    const res = await GET(
      manifestRequest({
        'expo-platform': 'android',
        'expo-runtime-version': '1',
        'expo-protocol-version': '1',
      }),
    );
    const text = await res.text();
    expect(rawManifestPart(text)).toBe(ANDROID_PROD.body);
    expect(partSignature(text)).toBe(ANDROID_PROD.signature);
  });

  it('withholds (204) and logs when no variant is materialized for the running environment', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OTA_ENVIRONMENT = 'production';
    // A production container whose update lacks its production variant must
    // withhold rather than serve the dev variant (wrong host + unsigned-for-env).
    mockReadFileSync.mockReturnValueOnce(
      storedManifest({ ios: { development: IOS_DEV } }),
    );

    const res = await GET(manifestRequest());
    expect(res.status).toBe(204);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No stored variant'));
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

    it('returns 204 when the update has no variants for the platform', async () => {
      mockReadFileSync.mockReturnValueOnce(storedManifest({ ios: undefined }));
      const res = await GET(manifestRequest());
      expect(res.status).toBe(204);
    });
  });

  describe('store v3 selection (channels, pin, retention)', () => {
    const savedPin = process.env.OTA_UPDATE_PIN;

    afterEach(() => {
      if (savedPin === undefined) delete process.env.OTA_UPDATE_PIN;
      else process.env.OTA_UPDATE_PIN = savedPin;
    });

    const OLD_IOS_DEV = variant('ios-dev-old');

    function twoUpdateStore(channels: Record<string, string>): string {
      // Newest first, distinct variants so the served entry is observable.
      const newer = updateEntry({ key: 'v2-key' });
      const older = updateEntry({
        key: 'v1-key',
        createdAt: '2026-07-01T00:00:00.000Z',
        ios: { development: OLD_IOS_DEV, production: variant('ios-prod-old') },
      });
      return JSON.stringify({ storeVersion: 3, channels, updates: [newer, older] });
    }

    it("serves the environment's channel pointer, not just the newest update", async () => {
      // Production repointed at the RETAINED older update (a rollback).
      process.env.OTA_ENVIRONMENT = 'production';
      delete process.env.OTA_UPDATE_PIN;
      mockReadFileSync.mockReturnValueOnce(
        twoUpdateStore({ development: 'v2-key', production: 'v1-key' }),
      );

      const res = await GET(manifestRequest());
      expect(rawManifestPart(await res.text())).toBe(variant('ios-prod-old').body);
    });

    it('OTA_UPDATE_PIN overrides the channel pointer (per-instance rollback)', async () => {
      delete process.env.OTA_ENVIRONMENT;
      process.env.OTA_UPDATE_PIN = 'v1-key';
      mockReadFileSync.mockReturnValueOnce(
        twoUpdateStore({ development: 'v2-key', production: 'v2-key' }),
      );

      const res = await GET(manifestRequest());
      expect(rawManifestPart(await res.text())).toBe(OLD_IOS_DEV.body);
    });

    it('falls back to the newest retained update, loudly, on a dangling pointer', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      delete process.env.OTA_ENVIRONMENT;
      delete process.env.OTA_UPDATE_PIN;
      mockReadFileSync.mockReturnValueOnce(
        twoUpdateStore({ development: 'pruned-key', production: 'v2-key' }),
      );

      const res = await GET(manifestRequest());
      expect(rawManifestPart(await res.text())).toBe(IOS_DEV.body);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No retained update matches'));
      errorSpy.mockRestore();
    });

    it('freezes (204) on a pinned update with an incompatible runtimeVersion -- never falls forward', async () => {
      delete process.env.OTA_ENVIRONMENT;
      process.env.OTA_UPDATE_PIN = 'v1-key';
      const newer = updateEntry({ key: 'v2-key' });
      const older = updateEntry({ key: 'v1-key', runtimeVersion: '2' });
      mockReadFileSync.mockReturnValueOnce(
        JSON.stringify({
          storeVersion: 3,
          channels: { development: 'v2-key', production: 'v2-key' },
          updates: [newer, older],
        }),
      );

      const res = await GET(manifestRequest());
      expect(res.status).toBe(204);
    });

    it('returns 500 and logs on an unsupported store version (e.g. a pre-signing v2 store)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockReadFileSync.mockReturnValueOnce(
        JSON.stringify({ storeVersion: 2, channels: {}, updates: [updateEntry()] }),
      );

      const res = await GET(manifestRequest());
      expect(res.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unsupported store version'));
      errorSpy.mockRestore();
    });

    it('returns 204 when the store retains no updates', async () => {
      mockReadFileSync.mockReturnValueOnce(
        JSON.stringify({ storeVersion: 3, channels: {}, updates: [] }),
      );
      const res = await GET(manifestRequest());
      expect(res.status).toBe(204);
    });
  });
});
