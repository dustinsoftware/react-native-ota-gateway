import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A pre-materialized, pre-signed manifest variant: the exact JSON bytes served
 * as the multipart manifest part and the structured-field value for the
 * expo-signature response header that authenticates them. Produced at export
 * time by scripts/generate-update-manifest.mjs (the signature covers `body`
 * byte-for-byte). This route serves both untouched.
 */
interface ManifestVariant {
  body: string;
  signature: string;
}

/** Per-environment variants of one platform's manifest. */
interface PlatformVariants {
  development?: ManifestVariant;
  production?: ManifestVariant;
}

interface StoredUpdate {
  // Stable identity of this update in the store (the export's otaAppVersion);
  // channel pointers and the OTA_UPDATE_PIN override select by this key.
  key: string;
  createdAt: string;
  runtimeVersion: string;
  // Platform-independent build identifier. This route ignores it and serves
  // the per-platform variants below.
  otaAppVersion?: string;
  // Relative static paths this update's launch asset + assets occupy; used by
  // the export script's retention GC, ignored here.
  files?: string[];
  // Per-platform, per-environment pre-signed variants. A placeholder export
  // has distinct development/production variants (different gateway host and
  // update id); a concrete-host export stores the same single variant under
  // both keys.
  ios?: PlatformVariants;
  android?: PlatformVariants;
}

/**
 * The versioned update store (dist/server/update-manifest.json, storeVersion
 * 3). The export script RETAINS recent updates, materializes+signs each
 * update's per-environment variants, and repoints the per-environment channel
 * pointers at the newest one; this route resolves the pointer for its
 * OTA_ENVIRONMENT (or the OTA_UPDATE_PIN override), picks the matching
 * environment variant, and serves its stored bytes verbatim. Retention +
 * pointers are what make rollback an ops action: repoint (or pin a container)
 * to a retained key -- no rebuild, no redeploy of the JS.
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
 * Serve a pre-signed variant verbatim: the stored body becomes the multipart
 * manifest part byte-for-byte, and the stored signature is emitted as an
 * `expo-signature` header ON THE MANIFEST PART -- for multipart responses the
 * expo-updates client reads the signature from the part headers, not the
 * top-level HTTP headers (it only consults the HTTP header for non-multipart
 * responses). The HTTP-level header is also set, harmlessly, for curl-ability.
 * The body MUST NOT be parsed and re-serialized -- the signature covers those
 * exact bytes, and any change fails client verification.
 */
function buildMultipartResponse(variant: ManifestVariant): Response {
  const boundary = 'expo-update-response';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json',
    'Content-Disposition: form-data; name="manifest"',
    `expo-signature: ${variant.signature}`,
    '',
    variant.body,
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
      'expo-signature': variant.signature,
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
  if (store.storeVersion !== 3) {
    console.error(
      `[updates/manifest] Unsupported store version ${JSON.stringify(store.storeVersion)}; expected 3.`,
    );
    return new Response('Internal Server Error', { status: 500 });
  }
  if (!Array.isArray(store.updates) || store.updates.length === 0) {
    return noUpdate();
  }

  // Select the update: an explicit per-instance pin wins (the blue/green /
  // rollback lever -- point one container at a retained key), then this
  // environment's channel pointer. Same strict-'production' polarity as the
  // variant selection below. Unknown keys fall back to the newest retained
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

  const variants = platform === 'ios' ? stored.ios : stored.android;
  if (!variants) {
    return noUpdate();
  }

  // Pick this instance's pre-signed environment variant. Same strict
  // '=== production' polarity used across the server: anything other than
  // 'production' (unset, 'development', a typo) resolves to the dev variant.
  const variant = variants[channel];
  if (!variant) {
    // No variant materialized for the running environment. The export fails
    // before shipping a store that lacks a required variant, so this is a
    // deploy anomaly: withhold the update (keep the app on its current bundle)
    // rather than hand out an unsigned or wrong-host body -- the same withhold
    // polarity as the pre-signing era's missing-gateway case.
    console.error(
      `[updates/manifest] No stored variant for OTA_ENVIRONMENT=${JSON.stringify(
        process.env.OTA_ENVIRONMENT,
      )} (channel "${channel}") on update ${JSON.stringify(stored.key)}; withholding the update.`,
    );
    return noUpdate();
  }

  return buildMultipartResponse(variant);
}
