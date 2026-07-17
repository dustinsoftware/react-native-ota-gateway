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

interface StoredManifest {
  runtimeVersion: string;
  // Platform-independent build identifier. This route ignores it and serves
  // the per-platform manifests below.
  otaAppVersion?: string;
  // Present when the manifest was built for the single-export / runtime-gateway
  // scheme (scripts/generate-update-manifest.mjs): every environment-specific
  // URL in the platform manifests is stamped with `gatewayPlaceholder`, and
  // `gatewayUrls` maps the deploy environment to its real gateway host. This
  // route swaps the placeholder for the running environment's host
  // (OTA_ENVIRONMENT) on each request, so one export serves both environments.
  // Absent for exports pinned to a concrete OTA_GATEWAY_URL, which are
  // already environment-specific and served verbatim.
  gatewayPlaceholder?: string;
  gatewayUrls?: { development?: string; production?: string };
  ios?: UpdateManifest;
  android?: UpdateManifest;
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
  gatewayUrls: NonNullable<StoredManifest['gatewayUrls']>,
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

  let stored: StoredManifest;
  try {
    const raw = readFileSync(
      join(process.cwd(), 'dist', 'server', 'update-manifest.json'),
      'utf-8',
    );
    stored = JSON.parse(raw) as StoredManifest;
  } catch (err) {
    if (isEnoent(err)) {
      // No manifest on disk -- no update available (normal on first deploy)
      return noUpdate();
    }
    // Real failure: log so it surfaces in the server logs and return 500
    console.error('[updates/manifest] Failed to read update manifest:', err);
    return new Response('Internal Server Error', { status: 500 });
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
