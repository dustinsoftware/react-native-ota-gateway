import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Asset {
  url: string;
  contentType: string;
  key: string;
  hash: string;
  fileExtension?: string;
}

interface UpdateManifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: Asset;
  assets: Asset[];
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

interface StoredUpdate {
  // Stable identity of this update in the store (the export's otaAppVersion);
  // channel pointers and the OTA_UPDATE_PIN override select by this key.
  key: string;
  createdAt: string;
  runtimeVersion: string;
  // Platform-independent build identifier. This route ignores it and serves
  // the per-platform manifests below.
  otaAppVersion?: string;
  // Present when the update was built for the placeholder / runtime-gateway
  // scheme (scripts/generate-update-manifest.mjs): every environment-specific
  // URL in the platform manifests is stamped with `gatewayPlaceholder`, and
  // `gatewayUrls` maps the deploy environment to its real gateway host. This
  // route swaps the placeholder for the running environment's host
  // (OTA_ENVIRONMENT) on each request, so one export serves both environments.
  // Absent for exports pinned to a concrete OTA_GATEWAY_URL, which are
  // already environment-specific and served verbatim.
  gatewayPlaceholder?: string;
  gatewayUrls?: { development?: string; production?: string };
  // Relative static paths this update's launch asset + assets occupy; used by
  // the export script's retention GC, ignored here.
  files?: string[];
  ios?: UpdateManifest;
  android?: UpdateManifest;
}

/**
 * The versioned update store (dist/server/update-manifest.json, storeVersion
 * 2). The export script RETAINS recent updates and repoints the per-environment
 * channel pointers at the newest one; this route resolves the pointer for its
 * OTA_ENVIRONMENT (or the OTA_UPDATE_PIN override) and serves that update.
 * Retention + pointers are what make rollback an ops action: repoint (or pin a
 * container) to a retained key -- no rebuild, no redeploy of the JS.
 */
interface UpdateStore {
  storeVersion: number;
  channels: { development?: string; production?: string };
  updates: StoredUpdate[];
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

const NO_UPDATE_HEADERS = {
  'expo-protocol-version': '1',
  'expo-sfv-version': '0',
  'cache-control': 'private, max-age=0',
};

function noUpdate(): Response {
  return new Response(null, { status: 204, headers: NO_UPDATE_HEADERS });
}

/**
 * Resolve the gateway host this instance should advertise in the manifest.
 * Mirrors the strict `=== 'production'` deploy-environment check used across the
 * server: any value other than 'production' -- unset, 'development', a typo --
 * resolves to the dev gateway. Returns undefined when no host is configured for
 * the resolved environment.
 */
function resolveGatewayBase(
  gatewayUrls: NonNullable<StoredUpdate['gatewayUrls']>,
): string | undefined {
  const key = process.env.OTA_ENVIRONMENT === 'production' ? 'production' : 'development';
  // No cross-environment fallback: a production instance missing its production
  // host must NOT silently advertise the dev gateway (that is the exact
  // wrong-environment failure this route exists to prevent). Returning undefined
  // routes to the withhold path below instead.
  return gatewayUrls[key];
}

/**
 * Derive the environment-specific update id served to clients.
 *
 * The baked id identifies the bundle content, so both environments bake the
 * SAME id -- but expo-updates treats update ids as globally unique. A client
 * that cached this update while pointed at one gateway and then receives the
 * same id from the other logs "this is a server error", rewrites the stored
 * update's scope key, and relaunches the CACHED update -- so the manifest it
 * exposes to JS (Constants.expoConfig, including extra.gatewayUrl) never
 * follows an environment switch. Hashing the baked id with the resolved
 * gateway base URL keeps the served id deterministic per (build, environment)
 * while guaranteeing the two environments never share one. Assets are still
 * deduplicated client-side by content hash, so re-pointing an environment
 * only inserts a new update row -- it does not re-download the bundle.
 */
function deriveEnvironmentUpdateId(bakedId: string, base: string): string {
  const hex = createHash('sha256').update(`${bakedId}\n${base}`).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Replace every occurrence of the baked placeholder with the resolved host. */
function applyGatewayBase(
  manifest: UpdateManifest,
  placeholder: string,
  base: string,
): UpdateManifest {
  // Pass a replacer function so `base` is inserted literally -- a string
  // replacement would interpret `$&`, `$$`, etc. in the host.
  return JSON.parse(
    JSON.stringify(manifest).replaceAll(placeholder, () => base),
  ) as UpdateManifest;
}

function buildMultipartResponse(manifest: UpdateManifest): Response {
  const boundary = 'expo-update-response';
  const manifestJson = JSON.stringify(manifest);
  const body = [
    `--${boundary}`,
    'Content-Type: application/json',
    'Content-Disposition: form-data; name="manifest"',
    '',
    manifestJson,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return new Response(body, {
    status: 200,
    headers: {
      'expo-protocol-version': '1',
      'expo-sfv-version': '0',
      'expo-manifest-filters': '',
      'expo-server-defined-headers': '',
      'cache-control': 'private, max-age=0',
      'content-type': `multipart/mixed; boundary=${boundary}`,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const platform = request.headers.get('expo-platform');
  const runtimeVersion = request.headers.get('expo-runtime-version');
  const protocolVersion = request.headers.get('expo-protocol-version');

  if (platform !== 'ios' && platform !== 'android') {
    return new Response('Unsupported platform', { status: 400 });
  }

  if (protocolVersion !== '1') {
    return new Response('Unsupported protocol version', { status: 406 });
  }

  let store: UpdateStore;
  try {
    const raw = readFileSync(
      join(process.cwd(), 'dist', 'server', 'update-manifest.json'),
      'utf-8',
    );
    store = JSON.parse(raw) as UpdateStore;
  } catch (err) {
    if (isEnoent(err)) {
      // No store on disk -- no update available (normal on first deploy)
      return noUpdate();
    }
    // Real failure: log so it surfaces in the server logs and return 500
    console.error('[updates/manifest] Failed to read update manifest:', err);
    return new Response('Internal Server Error', { status: 500 });
  }

  // The store format is versioned and the serving image is rebuilt with every
  // export, so an unknown version is a deploy bug, not a migration case.
  if (store.storeVersion !== 2) {
    console.error(
      `[updates/manifest] Unsupported store version ${JSON.stringify(store.storeVersion)}; expected 2.`,
    );
    return new Response('Internal Server Error', { status: 500 });
  }
  if (!Array.isArray(store.updates) || store.updates.length === 0) {
    return noUpdate();
  }

  // Select the update: an explicit per-instance pin wins (the blue/green /
  // rollback lever -- point one container at a retained key), then this
  // environment's channel pointer. Same strict-'production' polarity as the
  // gateway resolution below. Unknown keys fall back to the newest retained
  // update, loudly: serving SOMETHING compatible beats a silent outage, but
  // a dangling pointer is an ops mistake worth surfacing.
  const channel = process.env.OTA_ENVIRONMENT === 'production' ? 'production' : 'development';
  const requestedKey = process.env.OTA_UPDATE_PIN ?? store.channels?.[channel];
  let stored = store.updates.find((update) => update.key === requestedKey);
  if (!stored) {
    console.error(
      `[updates/manifest] No retained update matches key ${JSON.stringify(requestedKey)} `
        + `for channel "${channel}"; falling back to the newest retained update.`,
    );
    stored = store.updates[0];
  }

  if (stored.runtimeVersion !== runtimeVersion) {
    // Client's native runtime is not compatible with this update
    return noUpdate();
  }

  const manifest = platform === 'ios' ? stored.ios : stored.android;
  if (!manifest) {
    return noUpdate();
  }

  // The manifest is baked once with a gateway placeholder so a single export can
  // serve either environment; swap it for this instance's gateway before
  // responding. When no placeholder was baked (a concrete OTA_GATEWAY_URL
  // export) the manifest is already environment-specific and served as-is.
  const { gatewayPlaceholder, gatewayUrls } = stored;
  if (gatewayPlaceholder && gatewayUrls) {
    const base = resolveGatewayBase(gatewayUrls);
    if (!base) {
      // The manifest expects a runtime host but none is configured for this
      // environment. Serving the raw placeholder would point the app at a bogus
      // host, so withhold the update (fail visibly in the logs, keep the app on
      // its current bundle) rather than hand out a broken one.
      console.error(
        '[updates/manifest] Manifest has a gateway placeholder but no gateway URL resolves for '
          + `OTA_ENVIRONMENT=${JSON.stringify(process.env.OTA_ENVIRONMENT)}; withholding the update.`,
      );
      return noUpdate();
    }
    const resolved = applyGatewayBase(manifest, gatewayPlaceholder, base);
    // The environments must not serve the same update id with different URLs
    // (see deriveEnvironmentUpdateId); stamp the per-environment id.
    resolved.id = deriveEnvironmentUpdateId(manifest.id, base);
    return buildMultipartResponse(resolved);
  }

  return buildMultipartResponse(manifest);
}
