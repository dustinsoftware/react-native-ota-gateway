import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * End-to-end tests for scripts/generate-update-manifest.mjs: run the real
 * script in a throwaway working directory with a minimal app.json + native
 * export fixture and assert on the written manifest. Pins the two behaviors
 * that break OTA silently if regressed:
 *   - asset URLs live under <gateway>/api/v2/updates/static/ (the public
 *     domains route only /api/v2/* to the gateway; root-level URLs 404),
 *   - extra.expoClient is stamped with the environment-matching updates.url
 *     and extra.gatewayUrl (consumed at runtime via Constants.expoConfig).
 */
const SCRIPT = path.resolve(__dirname, '..', 'generate-update-manifest.mjs');
const DEV_GATEWAY = 'https://dev.test.example';
const PROD_GATEWAY = 'https://www.test.example';
// The base URL baked into the manifest when no concrete OTA_GATEWAY_URL is
// set. The manifest API route swaps it for the running environment's gateway at
// request time. Kept in sync with GATEWAY_PLACEHOLDER in the script under test.
const PLACEHOLDER = '__OTA_GATEWAY_BASE_URL__';
const BUNDLE_PATH = '_expo/static/js/ios/entry-abc.hbc';
const ASSET_PATH = 'assets/0123456789abcdef0123456789abcdef';
// The fixture file contents, hashed the way the script does, drive the
// ?h= cache-buster expected in every static asset URL. Static paths serve
// with immutable caching, and Metro's entry-<hash> filename can stay the
// same across deploys with different bytes -- the content-hash query string
// is what keeps a stale edge cache from serving the previous deploy's file.
const BUNDLE_BUSTER = createHash('sha256')
  .update('console.log("x")')
  .digest('base64url')
  .slice(0, 16);
const ASSET_BUSTER = createHash('sha256').update('png-bytes').digest('base64url').slice(0, 16);
const BUILD_ENV = {
  BUILD_NUMBER: '1.1.162',
  BUILD_VCS_NUMBER: 'ac8386140e9cdfbb72cd9dc9d7294679bf10105e',
};

interface PlatformManifest {
  launchAsset: { url: string; key: string };
  assets: Array<{ url: string; contentType: string; fileExtension: string }>;
  extra: {
    otaAppVersion: string;
    expoClient: { updates: { url: string }; extra: { gatewayUrl: string } };
  };
}

function makeWorkspace(withGatewayUrls: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gen-manifest-'));
  const appJson = {
    expo: {
      name: 'ota-gateway-app',
      slug: 'ota-gateway-app',
      version: '1.2.3',
      runtimeVersion: '1',
      updates: { url: `${DEV_GATEWAY}/api/v2/updates/manifest` },
      ...(withGatewayUrls
        ? { extra: { gatewayUrls: { development: DEV_GATEWAY, production: PROD_GATEWAY } } }
        : {}),
    },
  };
  writeFileSync(path.join(dir, 'app.json'), JSON.stringify(appJson));
  const bundleAbs = path.join(dir, 'dist', 'native-export', BUNDLE_PATH);
  mkdirSync(path.dirname(bundleAbs), { recursive: true });
  writeFileSync(bundleAbs, 'console.log("x")');
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
  return dir;
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

interface StoredUpdate {
  key: string;
  otaAppVersion: string;
  gatewayPlaceholder?: string;
  gatewayUrls?: { development?: string; production?: string };
  files?: string[];
  ios: PlatformManifest;
  android: PlatformManifest;
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
function readStoredManifest(cwd: string): StoredUpdate {
  return readStore(cwd).updates[0];
}

describe('generate-update-manifest.mjs', () => {
  it('emits API-prefixed asset URLs and bakes the runtime gateway placeholder by default', () => {
    const dir = makeWorkspace(true);
    try {
      runScript(dir, BUILD_ENV);
      const stored = readStoredManifest(dir);
      const ios = stored.ios;
      // The served PATH is content-addressed (entry-<contenthash>), never
      // Metro's filename: Metro's name is not reliably content-derived, and a
      // retained update whose on-disk file a newer export overwrote would fail
      // its SHA-256 check on rollback.
      expect(ios.launchAsset.url).toBe(
        `${PLACEHOLDER}/api/v2/updates/static/_expo/static/js/ios/entry-${BUNDLE_BUSTER}.hbc?h=${BUNDLE_BUSTER}`,
      );
      // The launch asset key is CONTENT-derived too: the on-device store
      // dedupes by key without re-hashing, so a filename key let a device
      // silently reuse a previous deploy's stale bundle bytes.
      expect(ios.launchAsset.key).toBe(`entry-${BUNDLE_BUSTER}`);
      expect(ios.assets).toEqual([
        expect.objectContaining({
          url: `${PLACEHOLDER}/api/v2/updates/static/${ASSET_PATH}?h=${ASSET_BUSTER}`,
          contentType: 'image/png',
          fileExtension: '.png',
          // The key is the MD5-named file (last path segment) -- it is what
          // Metro matches embedded assets by, so a derivation regression
          // breaks OTA asset resolution at runtime.
          key: ASSET_PATH.split('/').pop(),
          hash: createHash('sha256').update('png-bytes').digest('base64url'),
        }),
      ]);
      expect(ios.extra.expoClient.updates.url).toBe(`${PLACEHOLDER}/api/v2/updates/manifest`);
      expect(ios.extra.expoClient.extra.gatewayUrl).toBe(PLACEHOLDER);
      expect(ios.extra.otaAppVersion).toBe('1.1.162-ac83861');
      expect(stored.android.extra.otaAppVersion).toBe('1.1.162-ac83861');
      // The shared version doubles as the entry's store key (channel pointers
      // and OTA_UPDATE_PIN select by it).
      expect(stored.otaAppVersion).toBe('1.1.162-ac83861');
      expect(stored.key).toBe('1.1.162-ac83861');
      // The placeholder token and the env->host map are baked in so the manifest
      // API route can resolve the running environment's gateway per request.
      expect(stored.gatewayPlaceholder).toBe(PLACEHOLDER);
      expect(stored.gatewayUrls).toEqual({
        development: DEV_GATEWAY,
        production: PROD_GATEWAY,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bakes the placeholder regardless of OTA_ENVIRONMENT (environment is resolved at runtime)', () => {
    const dir = makeWorkspace(true);
    try {
      // A single image serves both environments, so the build must NOT resolve a
      // concrete host even when OTA_ENVIRONMENT is set. The manifest route does
      // the swap at request time instead.
      runScript(dir, { ...BUILD_ENV, OTA_ENVIRONMENT: 'production' });
      const ios = readStoredManifest(dir).ios;
      expect(ios.launchAsset.url).toBe(
        `${PLACEHOLDER}/api/v2/updates/static/_expo/static/js/ios/entry-${BUNDLE_BUSTER}.hbc?h=${BUNDLE_BUSTER}`,
      );
      expect(ios.extra.expoClient.updates.url).toBe(`${PLACEHOLDER}/api/v2/updates/manifest`);
      expect(ios.extra.expoClient.extra.gatewayUrl).toBe(PLACEHOLDER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('OTA_GATEWAY_URL pins a concrete host and omits the runtime placeholder', () => {
    const dir = makeWorkspace(true);
    try {
      runScript(dir, {
        ...BUILD_ENV,
        OTA_GATEWAY_URL: 'https://override.test.example',
      });
      const stored = readStoredManifest(dir);
      const ios = stored.ios;
      expect(ios.launchAsset.url).toBe(
        `https://override.test.example/api/v2/updates/static/_expo/static/js/ios/entry-${BUNDLE_BUSTER}.hbc?h=${BUNDLE_BUSTER}`,
      );
      expect(ios.extra.expoClient.extra.gatewayUrl).toBe('https://override.test.example');
      // No placeholder was stamped, so the route has nothing to swap and must
      // serve the manifest verbatim -- these fields are therefore omitted.
      expect(stored.gatewayPlaceholder).toBeUndefined();
      expect(stored.gatewayUrls).toBeUndefined();
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

      expect(readStoredManifest(dir).ios.extra.otaAppVersion).toBe('1.1.162-ac83861');
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

      expect(readStoredManifest(dir).ios.extra.otaAppVersion).toBe(
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
      // execFileSync attaches the child's stderr; the guard message must be there.
      // A single image serves both environments, so a placeholder that resolves
      // in only one (or neither) is a dead manifest -- the export must fail.
      expect(String((thrown as { stderr?: Buffer }).stderr)).toContain('gateway hosts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a storeVersion-2 store whose channels point at the new export', () => {
    const dir = makeWorkspace(true);
    try {
      runScript(dir, BUILD_ENV);
      const store = readStore(dir);
      expect(store.storeVersion).toBe(2);
      expect(store.updates).toHaveLength(1);
      expect(store.channels).toEqual({
        development: '1.1.162-ac83861',
        production: '1.1.162-ac83861',
      });
      // Every static file the update references is recorded for retention GC
      // (the bundle under its content-addressed name).
      expect(store.updates[0].files).toEqual(
        expect.arrayContaining([
          `_expo/static/js/ios/entry-${BUNDLE_BUSTER}.hbc`,
          ASSET_PATH,
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Re-seed dist/native-export (the script deletes it) for a follow-up export. */
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

  it('retains previous updates across exports and re-materializes their files', () => {
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
      expect(store.updates.map((u) => u.key)).toEqual([
        '1.1.163-bc83861',
        '1.1.162-ac83861',
      ]);
      // Channels advance to the newest export.
      expect(store.channels.production).toBe('1.1.163-bc83861');
      // Content-addressed bundle paths mean BOTH versions' bytes coexist in
      // dist/client -- the retained update's file was re-materialized from the
      // archive after the wipe, so a rollback can still serve it verbatim.
      const oldBuster = createHash('sha256')
        .update('console.log("x")')
        .digest('base64url')
        .slice(0, 16);
      const newBuster = createHash('sha256')
        .update('console.log("y")')
        .digest('base64url')
        .slice(0, 16);
      expect(
        readFileSync(
          path.join(dir, 'dist', 'client', '_expo/static/js/ios', `entry-${newBuster}.hbc`),
          'utf-8',
        ),
      ).toBe('console.log("y")');
      expect(
        readFileSync(
          path.join(dir, 'dist', 'client', '_expo/static/js/ios', `entry-${oldBuster}.hbc`),
          'utf-8',
        ),
      ).toBe('console.log("x")');
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
      expect(store.updates.map((u) => u.key)).toEqual([
        '1.1.164-cc83861',
        '1.1.163-bc83861',
      ]);
      // Shared, still-referenced files survive the GC ...
      expect(
        readFileSync(path.join(dir, '.ota-archive', 'static', ASSET_PATH), 'utf-8'),
      ).toBe('png-bytes');
      // ... and the PRUNED first export's now-unreferenced bundle is DELETED
      // (content-addressed names make each export's bundle a distinct file, so
      // an unbounded no-op GC would be visible here as a surviving file).
      const prunedBuster = createHash('sha256')
        .update('console.log("x")')
        .digest('base64url')
        .slice(0, 16);
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
      seedExport(dir, 'console.log("x")');
      runScript(dir, BUILD_ENV);

      expect(readStore(dir).updates).toHaveLength(1);
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
