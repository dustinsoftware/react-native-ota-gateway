/**
 * Generates an Expo Updates Protocol v1 manifest from a native expo export.
 *
 * Reads: dist/native-export/metadata.json (written by expo export)
 * Writes: dist/server/update-manifest.json (read at runtime by the manifest API route)
 * Copies: native bundles and assets into dist/client/ so the server serves them statically
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
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const NATIVE_EXPORT_DIR = "dist/native-export";
const CLIENT_DIR = join("dist", "client");
const SERVER_DIR = join("dist", "server");
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
 * re-downloads. This baked id is environment-NEUTRAL: in the runtime-gateway
 * scheme the manifest API route re-derives a per-environment id from it at
 * request time (see deriveEnvironmentUpdateId in
 * src/app/api/v2/updates/manifest+api.ts) -- expo-updates treats ids as
 * globally unique, so dev and prod must never serve the same id with
 * different URLs.
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

/** Copy a file from the native export dir to dist/client/, creating dirs as needed. */
function copyToClient(srcPath, destRelative) {
  const dest = join(CLIENT_DIR, destRelative);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(srcPath, dest);
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

  copyToClient(bundleSrcPath, platMeta.bundle);

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
    url: withCacheBuster(`${BASE_URL}${STATIC_URL_PREFIX}/${platMeta.bundle}`, bundleHash),
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
// bundle), so surface it once at the top level too.
//
// When the base URL is the runtime placeholder, also bake the placeholder token
// and the full environment->gateway map so the manifest API route can resolve
// the running environment's host on each request. Omitted when a concrete
// OTA_GATEWAY_URL was stamped -- there is then no placeholder to swap.
const usedPlaceholder = BASE_URL === GATEWAY_PLACEHOLDER;
const stored = {
  runtimeVersion,
  otaAppVersion,
  ...(usedPlaceholder
    ? { gatewayPlaceholder: GATEWAY_PLACEHOLDER, gatewayUrls }
    : {}),
};
for (const platform of platforms) {
  stored[platform] = buildPlatformManifest(platform);
}

mkdirSync(SERVER_DIR, { recursive: true });
writeFileSync(
  join(SERVER_DIR, "update-manifest.json"),
  JSON.stringify(stored, null, 2),
);

console.log("[generate-update-manifest] Written dist/server/update-manifest.json");
console.log(`  runtimeVersion: ${runtimeVersion}`);
console.log(`  otaAppVersion: ${otaAppVersion}`);
for (const platform of platforms) {
  console.log(`  ${platform} bundle: ${stored[platform].launchAsset.url}`);
}

rmSync(NATIVE_EXPORT_DIR, { recursive: true, force: true });
console.log("[generate-update-manifest] Cleaned up dist/native-export/");
