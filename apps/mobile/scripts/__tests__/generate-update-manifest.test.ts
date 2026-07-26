import { execFileSync } from 'node:child_process';
import { createHash, createVerify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
} from '@expo/code-signing-certificates';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end tests for scripts/generate-update-manifest.mjs: run the real
 * script in a throwaway working directory with a minimal app.json + native
 * export fixture and assert on the written storeVersion-3 store. Pins the
 * behaviors that break OTA silently if regressed:
 *   - asset URLs live under <gateway>/api/v2/updates/static/ (the public
 *     domains route only /api/v2/* to the gateway; root-level URLs 404),
 *   - each retained update x platform materializes both environment variants
 *     (development + production) with the placeholder fully resolved, the
 *     per-environment update id derived, and a valid RSA signature,
 *   - extra.expoClient is stamped with the environment-matching updates.url
 *     and extra.gatewayUrl (consumed at runtime via Constants.expoConfig).
 *
 * A throwaway signing keypair is generated in test setup and written into each
 * workspace's certs/ dir (the script signs with it); the tests never depend on
 * the repo's gitignored certs/ existing.
 */
const SCRIPT = path.resolve(__dirname, '..', 'generate-update-manifest.mjs');
const DEV_GATEWAY = 'https://dev.test.example';
const PROD_GATEWAY = 'https://www.test.example';
// The base URL baked into the manifest when no concrete OTA_GATEWAY_URL is
// set. The generator replaces it with each environment's host at
// materialization time. Kept in sync with GATEWAY_PLACEHOLDER in the script.
const PLACEHOLDER = '__OTA_GATEWAY_BASE_URL__';
const BUNDLE_PATH = '_expo/static/js/ios/entry-abc.hbc';
const ASSET_PATH = 'assets/0123456789abcdef0123456789abcdef';
const BUNDLE_CONTENT = 'console.log("x")';
const BUNDLE_BUSTER = createHash('sha256').update(BUNDLE_CONTENT).digest('base64url').slice(0, 16);
const ASSET_BUSTER = createHash('sha256').update('png-bytes').digest('base64url').slice(0, 16);
const BUILD_ENV = {
  BUILD_NUMBER: '1.1.162',
  BUILD_VCS_NUMBER: 'ac8386140e9cdfbb72cd9dc9d7294679bf10105e',
};

let PRIVATE_KEY_PEM: string;
let CERTIFICATE_PEM: string;

beforeAll(() => {
  const keyPair = generateKeyPair();
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 1);
  const certificate = generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore: notBefore,
    validityNotAfter: notAfter,
    commonName: 'ota-gateway-app-test',
  });
  PRIVATE_KEY_PEM = convertKeyPairToPEM(keyPair).privateKeyPEM;
  CERTIFICATE_PEM = convertCertificateToCertificatePEM(certificate);
});

/** Baked (environment-neutral) id: hashToUUID(bundle content SHA-256). */
function bakedId(content: string): string {
  const hex = createHash('sha256').update(content).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Per-environment id: SHA-256("<bakedId>\n<base>"), first 128 bits as UUID. */
function deriveEnvId(baked: string, base: string): string {
  const hex = createHash('sha256').update(`${baked}\n${base}`).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Extract the base64 signature from a `sig="...", keyid="main"` header value. */
function signatureBase64(header: string): string {
  const match = header.match(/sig="([^"]+)"/);
  if (!match) throw new Error(`no sig in signature header: ${header}`);
  return match[1];
}

/** Verify a variant's signature over its exact body bytes against the cert. */
function verifySignature(body: string, signatureHeader: string): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(Buffer.from(body, 'utf-8'));
  verifier.end();
  return verifier.verify(CERTIFICATE_PEM, signatureBase64(signatureHeader), 'base64');
}

function makeWorkspace(withGatewayUrls: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gen-manifest-'));
  const appJson = {
    expo: {
      name: 'ota-gateway-app',
      slug: 'ota-gateway-app',
      version: '1.2.3',
      runtimeVersion: '1',
      updates: {
        url: `${DEV_GATEWAY}/api/v2/updates/manifest`,
        codeSigningCertificate: './certs/certificate.pem',
        codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
      },
      ...(withGatewayUrls
        ? { extra: { gatewayUrls: { development: DEV_GATEWAY, production: PROD_GATEWAY } } }
        : {}),
    },
  };
  writeFileSync(path.join(dir, 'app.json'), JSON.stringify(appJson));
  writeSigningKeys(dir);
  seedExport(dir, BUNDLE_CONTENT);
  return dir;
}

/** Write the throwaway signing keypair into the workspace's certs/ dir. */
function writeSigningKeys(dir: string): void {
  const certsDir = path.join(dir, 'certs');
  mkdirSync(certsDir, { recursive: true });
  writeFileSync(path.join(certsDir, 'private-key.pem'), PRIVATE_KEY_PEM);
  writeFileSync(path.join(certsDir, 'certificate.pem'), CERTIFICATE_PEM);
}

/** Re-seed dist/native-export (the script deletes it) for a fresh/follow-up export. */
function seedExport(dir: string, bundleContent: string): void {
  const bundleAbs = path.join(dir, 'dist', 'native-export', BUNDLE_PATH);
  mkdirSync(path.dirname(bundleAbs), { recursive: true });
  writeFileSync(bundleAbs, bundleContent);
  const assetAbs = path.join(dir, 'dist', 'native-export', ASSET_PATH);
  mkdirSync(path.dirname(assetAbs), { recursive: true });
  writeFileSync(assetAbs, 'png-bytes');
  writeFileSync(
    path.join(dir, 'dist', 'native-export', 'metadata.json'),
    JSON.stringify({
      fileMetadata: {
        ios: { bundle: BUNDLE_PATH, assets: [{ path: ASSET_PATH, ext: 'png' }] },
        android: { bundle: BUNDLE_PATH, assets: [{ path: ASSET_PATH, ext: 'png' }] },
      },
    }),
  );
}

function runScript(cwd: string, env: Record<string, string> = {}): void {
  // Strip the selection vars from the inherited env (an empty string would not
  // be nullish/falsy-equivalent for the script's ?? fallback) and add overrides.
  const base = { ...process.env, ...env };
  for (const key of [
    'OTA_ENVIRONMENT',
    'OTA_GATEWAY_URL',
    'BUILD_NUMBER',
    'BUILD_VCS_NUMBER',
  ]) {
    if (!(key in env)) delete base[key];
  }
  execFileSync(process.execPath, [SCRIPT], { cwd, env: base, stdio: 'pipe' });
}

interface Variant {
  body: string;
  signature: string;
}

interface PlatformManifest {
  id: string;
  launchAsset: { url: string; key: string };
  assets: Array<{ url: string; contentType: string; fileExtension: string; key: string; hash: string }>;
  extra: {
    otaAppVersion: string;
    expoClient: { updates: { url: string }; extra: { gatewayUrl: string } };
  };
}

interface StoredUpdate {
  key: string;
  otaAppVersion: string;
  files?: string[];
  ios: { development: Variant; production: Variant };
  android: { development: Variant; production: Variant };
}

interface UpdateStore {
  storeVersion: number;
  channels: { development?: string; production?: string };
  updates: StoredUpdate[];
}

function readStore(cwd: string): UpdateStore {
  return JSON.parse(
    readFileSync(path.join(cwd, 'dist', 'server', 'update-manifest.json'), 'utf-8'),
  ) as UpdateStore;
}

/** The newest update entry -- what a fresh export just wrote. */
function readStoredUpdate(cwd: string): StoredUpdate {
  return readStore(cwd).updates[0];
}

function parseVariant(variant: Variant): PlatformManifest {
  return JSON.parse(variant.body) as PlatformManifest;
}

describe('generate-update-manifest.mjs', () => {
  it('materializes both signed environment variants with resolved hosts and derived ids', () => {
    const dir = makeWorkspace(true);
    try {
      runScript(dir, BUILD_ENV);
      const stored = readStoredUpdate(dir);

      const baked = bakedId(BUNDLE_CONTENT);
      const devManifest = parseVariant(stored.ios.development);
      const prodManifest = parseVariant(stored.ios.production);

      // The placeholder is fully resolved to each environment's host -- no
      // token may survive into a served (signed) body.
      expect(stored.ios.development.body).not.toContain(PLACEHOLDER);
      expect(stored.ios.production.body).not.toContain(PLACEHOLDER);

      // dev variant: content-addressed launch asset path + ?h= buster.
      expect(devManifest.launchAsset.url).toBe(
        `${DEV_GATEWAY}/api/v2/updates/static/_expo/static/js/ios/entry-${BUNDLE_BUSTER}.hbc?h=${BUNDLE_BUSTER}`,
      );
      expect(devManifest.launchAsset.key).toBe(`entry-${BUNDLE_BUSTER}`);
      expect(devManifest.assets[0]).toEqual(
        expect.objectContaining({
          url: `${DEV_GATEWAY}/api/v2/updates/static/${ASSET_PATH}?h=${ASSET_BUSTER}`,
          contentType: 'image/png',
          fileExtension: '.png',
          key: ASSET_PATH.split('/').pop(),
          hash: createHash('sha256').update('png-bytes').digest('base64url'),
        }),
      );
      expect(devManifest.extra.expoClient.updates.url).toBe(`${DEV_GATEWAY}/api/v2/updates/manifest`);
      expect(devManifest.extra.expoClient.extra.gatewayUrl).toBe(DEV_GATEWAY);

      // prod variant resolves to the prod host.
      expect(prodManifest.launchAsset.url).toBe(
        `${PROD_GATEWAY}/api/v2/updates/static/_expo/static/js/ios/entry-${BUNDLE_BUSTER}.hbc?h=${BUNDLE_BUSTER}`,
      );
      expect(prodManifest.extra.expoClient.extra.gatewayUrl).toBe(PROD_GATEWAY);

      // Per-environment ids: deterministic, distinct, never the baked id.
      expect(devManifest.id).toBe(deriveEnvId(baked, DEV_GATEWAY));
      expect(prodManifest.id).toBe(deriveEnvId(baked, PROD_GATEWAY));
      expect(devManifest.id).not.toBe(prodManifest.id);
      expect(devManifest.id).not.toBe(baked);

      // Each variant's signature verifies over its exact body bytes.
      expect(verifySignature(stored.ios.development.body, stored.ios.development.signature)).toBe(true);
      expect(verifySignature(stored.ios.production.body, stored.ios.production.signature)).toBe(true);
      // A tampered body must NOT verify (the signature covers exact bytes).
      expect(verifySignature(`${stored.ios.development.body} `, stored.ios.development.signature)).toBe(false);
      // Header carries the keyid the hosts expect.
      expect(stored.ios.development.signature).toMatch(/^sig="[^"]+", keyid="main"$/);

      // android variants exist and resolve too.
      expect(parseVariant(stored.android.production).extra.expoClient.extra.gatewayUrl).toBe(PROD_GATEWAY);

      expect(devManifest.extra.otaAppVersion).toBe('1.1.162-ac83861');
      expect(stored.otaAppVersion).toBe('1.1.162-ac83861');
      expect(stored.key).toBe('1.1.162-ac83861');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('materializes variants regardless of OTA_ENVIRONMENT (environment is resolved at serve time)', () => {
    const dir = makeWorkspace(true);
    try {
      // A single image serves both environments, so the build must materialize
      // BOTH variants even when OTA_ENVIRONMENT is set. The route picks one.
      runScript(dir, { ...BUILD_ENV, OTA_ENVIRONMENT: 'production' });
      const stored = readStoredUpdate(dir);
      expect(parseVariant(stored.ios.development).extra.expoClient.extra.gatewayUrl).toBe(DEV_GATEWAY);
      expect(parseVariant(stored.ios.production).extra.expoClient.extra.gatewayUrl).toBe(PROD_GATEWAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('OTA_GATEWAY_URL pins a concrete host -> a single signed variant under both env keys, baked id served as-is', () => {
    const dir = makeWorkspace(true);
    try {
      const HOST = 'https://override.test.example';
      runScript(dir, { ...BUILD_ENV, OTA_GATEWAY_URL: HOST });
      const stored = readStoredUpdate(dir);

      // Both env keys carry the SAME already-final variant (identical bytes).
      expect(stored.ios.development.body).toBe(stored.ios.production.body);
      expect(stored.ios.development.signature).toBe(stored.ios.production.signature);

      const manifest = parseVariant(stored.ios.development);
      expect(manifest.launchAsset.url).toBe(
        `${HOST}/api/v2/updates/static/_expo/static/js/ios/entry-${BUNDLE_BUSTER}.hbc?h=${BUNDLE_BUSTER}`,
      );
      expect(manifest.extra.expoClient.extra.gatewayUrl).toBe(HOST);
      expect(stored.ios.development.body).not.toContain(PLACEHOLDER);
      // A pinned export is already environment-specific: the baked id is served
      // as-is (no per-environment re-derivation).
      expect(manifest.id).toBe(bakedId(BUNDLE_CONTENT));
      expect(verifySignature(stored.ios.development.body, stored.ios.development.signature)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes a TeamCity feature build number that already contains the short SHA', () => {
    const dir = makeWorkspace(true);
    try {
      runScript(dir, {
        BUILD_NUMBER: '1.1.162.ac83861',
        BUILD_VCS_NUMBER: BUILD_ENV.BUILD_VCS_NUMBER,
      });
      expect(parseVariant(readStoredUpdate(dir).ios.development).extra.otaAppVersion).toBe(
        '1.1.162-ac83861',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to expo.version and the local Git HEAD outside TeamCity', () => {
    const dir = makeWorkspace(true);
    try {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['add', 'app.json'], { cwd: dir, stdio: 'pipe' });
      execFileSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'],
        { cwd: dir, stdio: 'pipe' },
      );
      const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();

      runScript(dir);

      expect(parseVariant(readStoredUpdate(dir).ios.development).extra.otaAppVersion).toBe(
        `1.2.3-${gitSha.slice(0, 7)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly when BUILD_VCS_NUMBER is not a Git SHA', () => {
    const dir = makeWorkspace(true);
    try {
      let thrown: unknown = null;
      try {
        runScript(dir, { BUILD_NUMBER: '1.1.162', BUILD_VCS_NUMBER: 'not-a-sha' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'script should exit non-zero').not.toBeNull();
      expect(String((thrown as { stderr?: Buffer }).stderr)).toContain(
        'BUILD_VCS_NUMBER must be a 7-40 character hexadecimal Git SHA',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly when build metadata is unavailable outside a Git worktree', () => {
    const dir = makeWorkspace(true);
    try {
      let thrown: unknown = null;
      try {
        runScript(dir);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'script should exit non-zero').not.toBeNull();
      expect(String((thrown as { stderr?: Buffer }).stderr)).toContain(
        'No Git SHA: set BUILD_VCS_NUMBER or run the export from a Git worktree',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly when the placeholder cannot be resolved in both environments', () => {
    const dir = makeWorkspace(false);
    try {
      let thrown: unknown = null;
      try {
        runScript(dir, BUILD_ENV);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'script should exit non-zero').not.toBeNull();
      // A single image serves both environments, so a placeholder that resolves
      // in only one (or neither) is a dead manifest -- the export must fail.
      expect(String((thrown as { stderr?: Buffer }).stderr)).toContain('gateway hosts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly (pointing at the key script) when the signing keys are missing', () => {
    const dir = makeWorkspace(true);
    try {
      // Gateway hosts are configured, but the code-signing keys are absent:
      // there is no unsigned mode, so the export must fail before writing.
      rmSync(path.join(dir, 'certs'), { recursive: true, force: true });
      let thrown: unknown = null;
      try {
        runScript(dir, BUILD_ENV);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'script should exit non-zero').not.toBeNull();
      const stderr = String((thrown as { stderr?: Buffer }).stderr);
      expect(stderr).toContain('Missing OTA code-signing keys');
      expect(stderr).toContain('generate-code-signing-keys.mjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a storeVersion-3 store whose channels point at the new export', () => {
    const dir = makeWorkspace(true);
    try {
      runScript(dir, BUILD_ENV);
      const store = readStore(dir);
      expect(store.storeVersion).toBe(3);
      expect(store.updates).toHaveLength(1);
      expect(store.channels).toEqual({
        development: '1.1.162-ac83861',
        production: '1.1.162-ac83861',
      });
      // Every static file the update references is recorded for retention GC
      // (the bundle under its content-addressed name).
      expect(store.updates[0].files).toEqual(
        expect.arrayContaining([`_expo/static/js/ios/entry-${BUNDLE_BUSTER}.hbc`, ASSET_PATH]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains previous updates across exports, re-materializes + re-signs their variants', () => {
    const dir = makeWorkspace(true);
    try {
      runScript(dir, BUILD_ENV);

      // Second export: expo export wipes dist/ in real life -- simulate the
      // wipe so retention genuinely comes from the archive, not leftovers.
      rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
      seedExport(dir, 'console.log("y")');
      runScript(dir, {
        BUILD_NUMBER: '1.1.163',
        BUILD_VCS_NUMBER: 'bc83861aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });

      const store = readStore(dir);
      expect(store.updates.map((u) => u.key)).toEqual(['1.1.163-bc83861', '1.1.162-ac83861']);
      expect(store.channels.production).toBe('1.1.163-bc83861');

      // The RETAINED older update's variants were re-materialized from the
      // archive and re-signed -- so a rollback target still verifies.
      const retained = store.updates[1];
      expect(retained.ios.development.body).not.toContain(PLACEHOLDER);
      expect(verifySignature(retained.ios.development.body, retained.ios.development.signature)).toBe(
        true,
      );
      expect(parseVariant(retained.ios.production).launchAsset.url).toBe(
        `${PROD_GATEWAY}/api/v2/updates/static/_expo/static/js/ios/entry-${BUNDLE_BUSTER}.hbc?h=${BUNDLE_BUSTER}`,
      );

      // Content-addressed bundle paths mean BOTH versions' bytes coexist in
      // dist/client -- the retained update's file was re-materialized after the wipe.
      const newBuster = createHash('sha256').update('console.log("y")').digest('base64url').slice(0, 16);
      expect(
        readFileSync(
          path.join(dir, 'dist', 'client', '_expo/static/js/ios', `entry-${newBuster}.hbc`),
          'utf-8',
        ),
      ).toBe('console.log("y")');
      expect(
        readFileSync(
          path.join(dir, 'dist', 'client', '_expo/static/js/ios', `entry-${BUNDLE_BUSTER}.hbc`),
          'utf-8',
        ),
      ).toBe(BUNDLE_CONTENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes beyond the retention window and GCs unreferenced archived files', () => {
    const dir = makeWorkspace(true);
    try {
      const shas = ['ac83861', 'bc83861', 'cc83861'];
      for (const [i, sha] of shas.entries()) {
        if (i > 0) {
          rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
          seedExport(dir, `console.log(${i})`);
        }
        runScript(dir, {
          BUILD_NUMBER: `1.1.${162 + i}`,
          BUILD_VCS_NUMBER: `${sha}${'a'.repeat(33)}`,
          OTA_RETAIN_UPDATES: '2',
        });
      }

      const store = readStore(dir);
      expect(store.updates.map((u) => u.key)).toEqual(['1.1.164-cc83861', '1.1.163-bc83861']);
      // Shared, still-referenced files survive the GC ...
      expect(readFileSync(path.join(dir, '.ota-archive', 'static', ASSET_PATH), 'utf-8')).toBe(
        'png-bytes',
      );
      // ... and the PRUNED first export's now-unreferenced bundle is DELETED.
      const prunedBuster = createHash('sha256').update(BUNDLE_CONTENT).digest('base64url').slice(0, 16);
      expect(
        existsSync(
          path.join(dir, '.ota-archive', 'static', '_expo/static/js/ios', `entry-${prunedBuster}.hbc`),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-exporting the same build replaces its entry instead of duplicating it', () => {
    const dir = makeWorkspace(true);
    try {
      runScript(dir, BUILD_ENV);
      rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
      seedExport(dir, BUNDLE_CONTENT);
      runScript(dir, BUILD_ENV);

      expect(readStore(dir).updates).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the archive in placeholder form (re-materializable), never the signed variants', () => {
    const dir = makeWorkspace(true);
    try {
      runScript(dir, BUILD_ENV);
      const archive = JSON.parse(
        readFileSync(path.join(dir, '.ota-archive', 'store.json'), 'utf-8'),
      ) as { updates: Array<Record<string, unknown>> };
      const entry = archive.updates[0];
      // Archive keeps the placeholder token + gateway map so retained updates
      // can be re-materialized next export -- NOT the per-env signed variants.
      expect(entry.gatewayPlaceholder).toBe(PLACEHOLDER);
      expect(entry.gatewayUrls).toEqual({ development: DEV_GATEWAY, production: PROD_GATEWAY });
      const ios = entry.ios as { launchAsset: { url: string } };
      expect(ios.launchAsset.url).toContain(PLACEHOLDER);
      expect(entry).not.toHaveProperty('ios.development');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly when OTA_GATEWAY_URL is set but empty', () => {
    const dir = makeWorkspace(true);
    try {
      let thrown: unknown = null;
      try {
        runScript(dir, { ...BUILD_ENV, OTA_GATEWAY_URL: '' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'script should exit non-zero').not.toBeNull();
      expect(String((thrown as { stderr?: Buffer }).stderr)).toContain(
        'OTA_GATEWAY_URL was set but empty',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
