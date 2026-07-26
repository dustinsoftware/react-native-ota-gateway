/**
 * Generates an Expo Updates Protocol v1 manifest from a native expo export.
 *
 * Reads: dist/native-export/metadata.json (written by expo export)
 * Writes: dist/server/update-manifest.json -- a storeVersion-3 UPDATE STORE:
 *         the newest export plus up to OTA_RETAIN_UPDATES-1 retained previous
 *         updates, and per-environment channel pointers (repointed at the
 *         newest export). For each retained update x platform it MATERIALIZES
 *         and SIGNS the final per-environment manifest variants (development +
 *         production) -- the exact JSON bytes the manifest API route serves
 *         verbatim, each with its RSA signature. The route does no request-time
 *         stamping, id derivation, or signing.
 * Archives: retained updates + their static files under .ota-archive/ so they
 *         survive expo export wiping dist/ between deploys. The archived store
 *         keeps the pre-materialization PLACEHOLDER form of each entry (see
 *         buildPlatformManifest) so retained updates can be re-materialized and
 *         re-signed on every export; materialized+signed variants live only in
 *         the served store.
 * Copies: every RETAINED update's bundles/assets into dist/client/ so the
 *         server can still serve a rolled-back update's files.
 * Cleans: dist/native-export/ (temp dir)
 *
 * Usage:
 *   node scripts/generate-update-manifest.mjs
 *
 * Env:
 *   OTA_GATEWAY_URL       Pin the base URL for asset URLs to a concrete host.
 *                         Defaults to a placeholder token that the manifest API
 *                         route swaps for the running environment's gateway at
 *                         request time (see GATEWAY_PLACEHOLDER below), so one
 *                         export serves both environments. Set this only for a
 *                         one-off export against a specific host; that host must
 *                         run a server that mounts /api/v2/updates/static.
 *   BUILD_NUMBER          CI build number used as the deployed OTA version
 *                         base. Falls back to expo.version for local exports.
 *   BUILD_VCS_NUMBER      Git commit SHA used to identify the source revision.
 *                         Falls back to the local repository HEAD.
 *   OTA_RETAIN_UPDATES    How many updates the store retains (default 3).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";

import {
  convertCertificatePEMToCertificate,
  convertPrivateKeyPEMToPrivateKey,
  signBufferRSASHA256AndVerify,
} from "@expo/code-signing-certificates";

const NATIVE_EXPORT_DIR = "dist/native-export";
const CLIENT_DIR = join("dist", "client");
const SERVER_DIR = join("dist", "server");
// Retained updates survive `expo export` wiping dist/: their manifests live in
// ARCHIVE_DIR/store.json and their static files under ARCHIVE_DIR/static/,
// re-materialized into dist/client on every export.
const ARCHIVE_DIR = ".ota-archive";
const ARCHIVE_STATIC_DIR = join(ARCHIVE_DIR, "static");
const RETAIN_UPDATES = Math.max(1, Number(process.env.OTA_RETAIN_UPDATES ?? 3));
const appJson = JSON.parse(readFileSync("app.json", "utf-8"));
const expoConfig = appJson.expo;
const runtimeVersion = String(expoConfig.runtimeVersion ?? "1");
const scopeKey = `@anonymous/${expoConfig.slug}`;
const SHORT_SHA_LENGTH = 7;

const gatewayUrls = expoConfig.extra?.gatewayUrls ?? {};

/**
 * The manifest is built once and served by either the dev or production server
 * instance, chosen at runtime by OTA_ENVIRONMENT. The per-environment gateway
 * host is therefore NOT resolved here: the base URL is stamped as this
 * placeholder token, and the manifest API route
 * (src/app/api/v2/updates/manifest+api.ts) swaps it for the running
 * environment's gateway (from the gatewayUrls map baked below) on every
 * request. Keeping the environment a runtime concern is what lets one export
 * serve both. Set a concrete OTA_GATEWAY_URL only for one-off exports pinned to
 * a host; no placeholder is then emitted and the route serves the manifest
 * as-is.
 */
const GATEWAY_PLACEHOLDER = "__OTA_GATEWAY_BASE_URL__";
const BASE_URL = process.env.OTA_GATEWAY_URL ?? GATEWAY_PLACEHOLDER;

/**
 * OTA bundle/asset URLs live under the API prefix (mirrored by the server's
 * /api/v2/updates/static static mount).
 */
const STATIC_URL_PREFIX = "/api/v2/updates/static";
if (!BASE_URL) {
  throw new Error(
    "[generate-update-manifest] OTA_GATEWAY_URL was set but empty; unset it to use the runtime gateway placeholder",
  );
}

// The placeholder is only useful if the manifest route can later resolve it to a
// real host. A single export serves BOTH environments, so both hosts must be
// configured -- fail the export rather than ship a manifest that resolves in one
// environment and silently has no gateway in the other.
if (
  BASE_URL === GATEWAY_PLACEHOLDER &&
  (!gatewayUrls.development || !gatewayUrls.production)
) {
  throw new Error(
    "[generate-update-manifest] Incomplete gateway hosts: app.json extra.gatewayUrls must define both development and production (or pin OTA_GATEWAY_URL)",
  );
}

// -- Code-signing keys (required; no unsigned mode) --
// The signature covers the EXACT served manifest bytes, so signing happens
// here (where the private key lives) rather than per request. The export fails
// loudly, pointing at the setup script, when the key material is missing.
const CERTS_DIR = "certs";
const PRIVATE_KEY_PATH = join(CERTS_DIR, "private-key.pem");
const CERTIFICATE_PATH = join(CERTS_DIR, "certificate.pem");
let signingPrivateKey;
let signingCertificate;
try {
  signingPrivateKey = convertPrivateKeyPEMToPrivateKey(
    readFileSync(PRIVATE_KEY_PATH, "utf-8"),
  );
  signingCertificate = convertCertificatePEMToCertificate(
    readFileSync(CERTIFICATE_PATH, "utf-8"),
  );
} catch (err) {
  if (err && err.code === "ENOENT") {
    throw new Error(
      "[generate-update-manifest] Missing OTA code-signing keys "
        + `(${PRIVATE_KEY_PATH}, ${CERTIFICATE_PATH}). Run `
        + "`node scripts/generate-code-signing-keys.mjs` first (once per clone). "
        + "There is no unsigned mode -- see docs/ota-updates.md#code-signing.",
    );
  }
  throw err;
}

/**
 * The keyid baked into the hosts (app.json updates.codeSigningMetadata) and
 * echoed in the expo-signature response header. The alg defaults to
 * rsa-v1_5-sha256 on the client when omitted from the header.
 */
const SIGNING_KEYID = "main";

/**
 * Sign a manifest variant's exact bytes and pair them with the structured-field
 * expo-signature header value the route serves untouched. The body string MUST
 * be stored and served byte-for-byte: any re-serialization would change the
 * signed bytes and fail client verification.
 */
function signVariant(body) {
  const signature = signBufferRSASHA256AndVerify(
    signingPrivateKey,
    signingCertificate,
    Buffer.from(body, "utf-8"),
  );
  return { body, signature: `sig="${signature}", keyid="${SIGNING_KEYID}"` };
}

function readGitSha() {
  const configuredSha = process.env.BUILD_VCS_NUMBER?.trim();
  if (configuredSha) {
    return configuredSha;
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "[generate-update-manifest] No Git SHA: set BUILD_VCS_NUMBER or run the export from a Git worktree",
    );
  }
}

function buildOtaAppVersion() {
  const gitSha = readGitSha();
  if (!/^[0-9a-f]{7,40}$/i.test(gitSha)) {
    throw new Error(
      "[generate-update-manifest] BUILD_VCS_NUMBER must be a 7-40 character hexadecimal Git SHA",
    );
  }

  const shortSha = gitSha.slice(0, SHORT_SHA_LENGTH).toLowerCase();
  const buildNumber =
    process.env.BUILD_NUMBER?.trim() || String(expoConfig.version ?? "").trim();
  if (!buildNumber) {
    throw new Error(
      "[generate-update-manifest] No build number: set BUILD_NUMBER or add expo.version to app.json",
    );
  }

  // CI feature builds already end in ".<shortSha>". Normalize that suffix
  // before adding the canonical "-<shortSha>" form.
  const normalizedBuildNumber = buildNumber.replace(
    new RegExp(`[.-]${shortSha}$`, "i"),
    "",
  );
  if (!normalizedBuildNumber) {
    throw new Error(
      "[generate-update-manifest] BUILD_NUMBER must contain a version before its Git SHA suffix",
    );
  }

  return `${normalizedBuildNumber}-${shortSha}`;
}

const otaAppVersion = buildOtaAppVersion();

/**
 * The Expo config served inside the manifest (surfaced to the app as
 * Constants.expoConfig on OTA launches). app.json alone carries the static dev
 * defaults, so stamp the base URL the manifest route will resolve at runtime:
 * the BFF base URL (extra.gatewayUrl, read by src/api/client.ts) and the updates
 * URL both carry the placeholder and are rewritten per request to match the
 * gateway that served this manifest.
 */
const servedExpoConfig = {
  ...expoConfig,
  updates: { ...expoConfig.updates, url: `${BASE_URL}/api/v2/updates/manifest` },
  extra: { ...expoConfig.extra, gatewayUrl: BASE_URL },
};

const rawMetadata = readFileSync(
  join(NATIVE_EXPORT_DIR, "metadata.json"),
  "utf-8",
);
const metadata = JSON.parse(rawMetadata);

/** Compute base64url-encoded SHA-256 hash of a file (required by protocol). */
function sha256Base64Url(filePath) {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("base64url");
}

/**
 * Derive a deterministic UUID from a base64url SHA-256 hash.
 * Same bundle content always produces the same ID, preventing unnecessary
 * re-downloads. This baked id is environment-NEUTRAL: at materialization time
 * (below) each per-environment variant derives its OWN served id from this one
 * via deriveEnvironmentUpdateId -- expo-updates treats ids as globally unique,
 * so dev and prod must never serve the same id with different URLs.
 */
function hashToUUID(base64urlHash) {
  const hex = Buffer.from(base64urlHash, "base64url").toString("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Derive the environment-specific update id served to clients.
 *
 * The baked id identifies bundle content, so both environments would otherwise
 * carry the SAME id with DIFFERENT gateway URLs -- but expo-updates treats
 * update ids as globally unique. A client that cached this update while pointed
 * at one gateway and then receives the same id from the other logs "this is a
 * server error", rewrites the stored update's scope key, and relaunches the
 * CACHED manifest -- so the embedded gateway URL never follows a host
 * environment switch. Hashing the baked id with the resolved gateway base keeps
 * the served id deterministic per (build, environment) while guaranteeing the
 * two environments never share one. Assets still dedupe client-side by content
 * hash, so re-pointing an environment only inserts a new update row -- it does
 * not re-download the bundle.
 *
 * The formula (SHA-256 of "<bakedId>\n<base>", first 128 bits as a UUID) is
 * unchanged from the request-time era; only its location moved (from the route
 * into this generator) so the id becomes part of the signed bytes.
 */
function deriveEnvironmentUpdateId(bakedId, base) {
  const hex = createHash("sha256").update(`${bakedId}\n${base}`).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

// Platform manifests live under these keys on a stored update entry.
const PLATFORM_KEYS = ["ios", "android"];

/**
 * Materialize one platform manifest's per-environment variants from the
 * archived PLACEHOLDER form, ready to serve verbatim:
 *  - placeholder exports: replace the placeholder with each environment's host
 *    and derive that environment's served id, then sign -- producing distinct
 *    development + production variants.
 *  - concrete OTA_GATEWAY_URL exports: the manifest is already environment-
 *    specific, so a SINGLE variant (id served as-is) is stored under both
 *    environment keys and the route serves it regardless of OTA_ENVIRONMENT.
 */
function materializePlatformVariants(manifest, gatewayPlaceholder, envGatewayUrls) {
  if (gatewayPlaceholder && envGatewayUrls) {
    const variants = {};
    for (const env of ["development", "production"]) {
      const base = envGatewayUrls[env];
      const resolved = JSON.parse(
        JSON.stringify(manifest).replaceAll(gatewayPlaceholder, () => base),
      );
      resolved.id = deriveEnvironmentUpdateId(manifest.id, base);
      variants[env] = signVariant(JSON.stringify(resolved));
    }
    return variants;
  }
  const variant = signVariant(JSON.stringify(manifest));
  return { development: variant, production: variant };
}

/**
 * Turn an archived (placeholder-form) update entry into the served form: the
 * store metadata plus, per platform, the materialized+signed environment
 * variants. Retained updates are re-materialized and re-signed on every export
 * (the key is present at export time), so a rollback target's variants stay
 * correctly signed even though its bundle was built by an earlier export.
 */
function materializeUpdate(update) {
  const served = {
    key: update.key,
    createdAt: update.createdAt,
    runtimeVersion: update.runtimeVersion,
    otaAppVersion: update.otaAppVersion,
    files: update.files,
  };
  for (const platform of PLATFORM_KEYS) {
    if (update[platform]) {
      served[platform] = materializePlatformVariants(
        update[platform],
        update.gatewayPlaceholder,
        update.gatewayUrls,
      );
    }
  }
  return served;
}

const EXT_TO_CONTENT_TYPE = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  js: "application/javascript",
  // Hermes bytecode -- expo-updates treats it as JS
  hbc: "application/javascript",
};

function toContentType(ext) {
  return EXT_TO_CONTENT_TYPE[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Copy a file from the native export dir to dist/client/ AND into the archive
 * (so it survives the next export wiping dist/), recording the relative path
 * on the update entry for retention GC.
 */
const newUpdateFiles = new Set();
function copyToClient(srcPath, destRelative) {
  const dest = join(CLIENT_DIR, destRelative);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(srcPath, dest);

  const archived = join(ARCHIVE_STATIC_DIR, destRelative);
  mkdirSync(dirname(archived), { recursive: true });
  copyFileSync(srcPath, archived);
  newUpdateFiles.add(destRelative);
}

// 16 base64url chars = 96 bits of the content hash: far more than enough for
// a unique edge-cache key per byte-version of a single file, while keeping
// the URLs short.
const CACHE_BUSTER_HASH_CHARS = 16;

/**
 * Append a content-hash cache-buster to a static asset URL.
 *
 * The static mount serves these paths with `public, max-age=31536000,
 * immutable`, which is only safe if the URL changes whenever the bytes do.
 * Metro's `entry-<hash>` filename does NOT guarantee that: it appears to be
 * derived before Hermes compilation, and two deploys have produced the same
 * filename with different .hbc bytes -- a stale cached copy then fails every
 * client's expo-updates SHA-256 check and bricks OTA until the cache is purged.
 * Keying the query string on the actual content hash (base64url, already
 * URL-safe) makes the cached entry genuinely immutable. The server ignores the
 * query string when resolving the file, and expo-updates dedupes assets by
 * `key`, not URL. This relies on the edge cache key including the query string
 * -- an "Ignore Query String" cache rule on this path would silently disable
 * the buster.
 */
function withCacheBuster(url, contentHash) {
  return `${url}?h=${contentHash.slice(0, CACHE_BUSTER_HASH_CHARS)}`;
}

function buildPlatformManifest(platform) {
  const platMeta = metadata.fileMetadata[platform];

  const bundleSrcPath = join(NATIVE_EXPORT_DIR, platMeta.bundle);
  const bundleHash = sha256Base64Url(bundleSrcPath);

  // Serve/archive the bundle under a CONTENT-ADDRESSED path, not Metro's
  // entry-<hash> filename: Metro's name is not reliably content-derived (see
  // withCacheBuster), so two retained updates could collide on the same
  // on-disk filename with different bytes -- the newer export would silently
  // overwrite the older RETAINED update's bundle and a rollback to it would
  // fail expo-updates' SHA-256 check. A content-derived filename makes every
  // byte-version its own immutable file, which is what retention requires.
  const bundleDest = join(
    dirname(platMeta.bundle),
    `entry-${bundleHash.slice(0, CACHE_BUSTER_HASH_CHARS)}${extname(platMeta.bundle)}`,
  );
  copyToClient(bundleSrcPath, bundleDest);

  // The launch asset's key is derived from the CONTENT hash, not Metro's
  // entry-<hash> filename. expo-updates' on-device store dedupes and names
  // downloaded assets by key WITHOUT re-hashing files already on disk, and
  // Metro's filename is not reliably content-addressed across deploys (see
  // withCacheBuster) -- a filename-derived key let a device silently reuse a
  // previous deploy's stale bundle bytes for a new update. A content-derived
  // key makes new bytes a new asset on-device. Regular assets (below) keep
  // Metro's key: those filenames ARE content hashes, and the bundle resolves
  // embedded assets by that exact key at runtime.
  const launchAsset = {
    url: withCacheBuster(`${BASE_URL}${STATIC_URL_PREFIX}/${bundleDest}`, bundleHash),
    contentType: "application/javascript",
    key: `entry-${bundleHash.slice(0, CACHE_BUSTER_HASH_CHARS)}`,
    hash: bundleHash,
  };

  const assets = platMeta.assets.map((asset) => {
    const assetSrcPath = join(NATIVE_EXPORT_DIR, asset.path);
    const hash = sha256Base64Url(assetSrcPath);
    // Key is the MD5 hash filename (no extension) -- matches what Metro embeds in the bundle
    const key = asset.path.split("/").pop();

    copyToClient(assetSrcPath, asset.path);

    return {
      url: withCacheBuster(`${BASE_URL}${STATIC_URL_PREFIX}/${asset.path}`, hash),
      contentType: toContentType(asset.ext),
      key,
      hash,
      fileExtension: `.${asset.ext}`,
    };
  });

  return {
    id: hashToUUID(bundleHash),
    createdAt: new Date().toISOString(),
    runtimeVersion,
    launchAsset,
    assets,
    metadata: {},
    extra: {
      scopeKey,
      otaAppVersion,
      expoClient: servedExpoConfig,
    },
  };
}

const platforms = Object.keys(metadata.fileMetadata);
// otaAppVersion is identical across platforms (it identifies the build, not the
// bundle), so it doubles as the update's stable store key: channel pointers
// and the serve-time OTA_UPDATE_PIN override select by it, and re-exporting
// the same build replaces its entry instead of duplicating it.
//
// When the base URL is the runtime placeholder, also bake the placeholder token
// and the full environment->gateway map so the manifest API route can resolve
// the running environment's host on each request. Omitted when a concrete
// OTA_GATEWAY_URL was stamped -- there is then no placeholder to swap.
const usedPlaceholder = BASE_URL === GATEWAY_PLACEHOLDER;
const entry = {
  key: otaAppVersion,
  createdAt: new Date().toISOString(),
  runtimeVersion,
  otaAppVersion,
  ...(usedPlaceholder
    ? { gatewayPlaceholder: GATEWAY_PLACEHOLDER, gatewayUrls }
    : {}),
};
for (const platform of platforms) {
  entry[platform] = buildPlatformManifest(platform);
}
entry.files = [...newUpdateFiles].sort();

// -- Retention: fold the new entry into the archived store --
// Same-key re-exports replace their entry (newest first); the store keeps at
// most RETAIN_UPDATES entries. Rollback stays possible exactly as far back as
// retention reaches.
const archiveStorePath = join(ARCHIVE_DIR, "store.json");
let retained = [];
if (existsSync(archiveStorePath)) {
  try {
    const parsed = JSON.parse(readFileSync(archiveStorePath, "utf-8"));
    if (Array.isArray(parsed.updates)) {
      retained = parsed.updates;
    }
  } catch (err) {
    console.warn(
      "[generate-update-manifest] Ignoring unreadable archive store:",
      err instanceof Error ? err.message : err,
    );
  }
}
const updates = [entry, ...retained.filter((u) => u.key !== entry.key)].slice(
  0,
  RETAIN_UPDATES,
);

// -- Retention GC: drop archived files no retained update references --
// Files are content-addressed and SHARED between updates (an unchanged image
// keeps its filename across exports), so deletion must be reference-counted
// against the union of every retained entry's file list, never per-entry.
const referenced = new Set(updates.flatMap((u) => u.files ?? []));
function walkFiles(dir, base = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? walkFiles(join(dir, d.name), join(base, d.name))
      : [join(base, d.name)],
  );
}
let pruned = 0;
for (const relative of walkFiles(ARCHIVE_STATIC_DIR)) {
  if (!referenced.has(relative)) {
    rmSync(join(ARCHIVE_STATIC_DIR, relative), { force: true });
    pruned += 1;
  }
}

// -- Materialize retained updates' files into dist/client --
// expo export wiped dist/, so every RETAINED (non-new) update's files must be
// copied back from the archive or a rollback would 404 its assets.
let materialized = 0;
for (const update of updates) {
  for (const relative of update.files ?? []) {
    const dest = join(CLIENT_DIR, relative);
    if (existsSync(dest)) continue;
    const src = join(ARCHIVE_STATIC_DIR, relative);
    if (!existsSync(src)) {
      throw new Error(
        `[generate-update-manifest] Retained update ${update.key} references `
          + `missing archived file ${relative}; delete ${ARCHIVE_DIR}/ to reset retention`,
      );
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    materialized += 1;
  }
}

// Channel pointers both advance to the new export by default. Serving-time
// divergence (canary/rollback) is per-instance: set OTA_UPDATE_PIN on a
// container to a retained key, or hand-edit the pointers before deploy.
//
// The served store carries storeVersion 3: each retained update is materialized
// into per-platform, per-environment { body, signature } variants (the exact
// bytes the route serves verbatim). The ARCHIVE keeps the placeholder form
// (below) so retained updates can be re-materialized and re-signed next export.
const store = {
  storeVersion: 3,
  channels: { development: entry.key, production: entry.key },
  updates: updates.map(materializeUpdate),
};

mkdirSync(SERVER_DIR, { recursive: true });
writeFileSync(join(SERVER_DIR, "update-manifest.json"), JSON.stringify(store, null, 2));
mkdirSync(ARCHIVE_DIR, { recursive: true });
// Atomic write: a crash mid-write would leave a truncated store.json, the
// next export would reset retention to empty, and the GC would then delete
// every archived file -- destroying rollback history. tmp+rename keeps the
// previous store intact until the new one is fully on disk.
writeFileSync(`${archiveStorePath}.tmp`, JSON.stringify({ updates }, null, 2));
renameSync(`${archiveStorePath}.tmp`, archiveStorePath);

console.log("[generate-update-manifest] Written dist/server/update-manifest.json");
console.log(`  runtimeVersion: ${runtimeVersion}`);
console.log(`  otaAppVersion: ${otaAppVersion}`);
console.log(
  `  retained updates: ${updates.map((u) => u.key).join(", ")} `
    + `(retain ${RETAIN_UPDATES}; ${materialized} archived file(s) re-materialized, ${pruned} pruned)`,
);
for (const platform of platforms) {
  console.log(`  ${platform} bundle: ${entry[platform].launchAsset.url}`);
}

rmSync(NATIVE_EXPORT_DIR, { recursive: true, force: true });
console.log("[generate-update-manifest] Cleaned up dist/native-export/");
