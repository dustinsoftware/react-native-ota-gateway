/**
 * Verification of the .build-info.json stamp that scripts/package-ios.sh
 * writes into each iOS package tree (build/ = Release, build-debug/ = Debug),
 * plus an objective binary check of the built framework.
 *
 * The stamp records the requested configuration, resolved version, and HEAD
 * sha at build time. Because it is a self-reported label, verifyMetroMarker
 * additionally inspects every slice of the actual OtaGatewayLib binary: only a
 * Debug build compiles in the Metro fallback URL (`localhost:8081`, injected by
 * plugins/withBrownfieldUpdates.js under #if DEBUG).
 *
 * Every function returns an error message string, or null when the check
 * passes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BUILD_INFO_FILE = ".build-info.json";
// Written by scripts/install-ios-frameworks.mjs into the tree the host consumes.
export const INSTALL_INFO_FILE = ".install-info.json";

// Both markers can sit in the same tree, and they answer different questions.
// .build-info.json records the BUILD that produced these frameworks (written by
// package-ios.sh, and copied along by an install, so in an installed tree it
// describes the build they came FROM). .install-info.json records THIS install.
// When both are present the install marker is the one that says what the host
// will boot into. Note the deliberate shape difference: the stamp stores
// `configuration: "Debug" | "Release"` (the xcodebuild term), the install marker
// stores `variant: "debug" | "release"` (the release-asset term).

// The frameworks every iOS package tree must carry. Shared so the producer
// (package-ios.sh mirrors this list in shell), the installer and the release
// gate cannot disagree about what "complete" means.
export const IOS_FRAMEWORKS = [
  "OtaGatewayLib.xcframework",
  "ReactBrownfield.xcframework",
  "hermesvm.xcframework",
];

const METRO_MARKER = "localhost:8081";
const XCFRAMEWORK_DIR = "OtaGatewayLib.xcframework";
const FRAMEWORK_RELPATH = join("OtaGatewayLib.framework", "OtaGatewayLib");

/**
 * Every slice binary in the xcframework (`ios-arm64`,
 * `ios-arm64_x86_64-simulator`, ...). All slices are checked, not just the
 * device one: the whole point of the Debug asset is SIMULATOR hot reload, so a
 * Debug build whose simulator slice lacked the marker would pass a
 * device-only gate and publish an asset that silently does nothing (Fast
 * Refresh with no error). Non-directory entries -- the xcframework's own
 * Info.plist -- are skipped.
 */
function sliceBinaries(dir) {
  const xcframeworkDir = join(dir, XCFRAMEWORK_DIR);
  if (!existsSync(xcframeworkDir)) {
    return [];
  }

  return readdirSync(xcframeworkDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(xcframeworkDir, entry.name, FRAMEWORK_RELPATH))
    .sort();
}

/**
 * Reject a tree that was INSTALLED (downloaded from a release, or copied from
 * another tree by scripts/install-ios-frameworks.mjs) rather than built here.
 * Such a tree carries someone else's frameworks, so republishing it would
 * silently re-cut an old artifact under a new tag. Checked before the stamp
 * checks, whose "stamp not found" / version-mismatch message would otherwise
 * bury the real reason. Returns an error message, or null.
 */
export function verifyNotInstalled(dir) {
  const infoPath = join(dir, INSTALL_INFO_FILE);
  if (!existsSync(infoPath)) {
    return null;
  }

  let described = "";
  try {
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    const origin = `${info.source}${info.tag ? ` ${info.tag}` : ""}`;
    described = ` (source: ${origin}, variant: ${info.variant})`;
  } catch {
    described = "";
  }

  return (
    `${dir} holds frameworks installed by scripts/install-ios-frameworks.mjs` +
    `${described}, not built from this checkout -- a release must not republish ` +
    `them. Rebuild before cutting:\n  ./scripts/package-ios.sh`
  );
}

/**
 * Verify the stamp in `dir` matches the expected configuration, version, and
 * HEAD sha. Returns an error message, or null if the stamp checks out.
 */
export function verifyBuildInfo({
  dir,
  expectedConfiguration,
  expectedVersion,
  expectedHeadSha,
}) {
  const infoPath = join(dir, BUILD_INFO_FILE);
  const rebuildHint = `Rebuild: ./scripts/package-ios.sh --configuration ${expectedConfiguration}`;
  if (!existsSync(infoPath)) {
    return (
      `${infoPath} not found. Rebuild with the current scripts/package-ios.sh\n` +
      `(it stamps the build configuration + version this script verifies):\n` +
      `  ${rebuildHint}`
    );
  }

  let info;
  try {
    info = JSON.parse(readFileSync(infoPath, "utf8"));
  } catch {
    return `${infoPath} is not valid JSON. Rebuild with scripts/package-ios.sh.`;
  }

  if (info.configuration !== expectedConfiguration) {
    return (
      `${dir} contains a ${info.configuration} build but this release step ` +
      `needs ${expectedConfiguration}.\n${rebuildHint}`
    );
  }
  if (info.version !== expectedVersion) {
    return (
      `${dir} was built as version '${info.version}' but this cut resolves to ` +
      `'${expectedVersion}' (stale tree, or HEAD moved since the build).\n` +
      rebuildHint
    );
  }
  if (info.headSha !== expectedHeadSha) {
    return (
      `${dir} was built at commit ${info.headSha || "(unknown)"} but HEAD is ` +
      `now ${expectedHeadSha} (stale tree from an older commit).\n${rebuildHint}`
    );
  }
  return null;
}

/**
 * Check that the Metro fallback URL is present in a Debug binary and absent
 * from a Release binary, for EVERY slice of the xcframework. Returns an error
 * message, or null on success.
 */
export function verifyMetroMarker(dir, expectedConfiguration) {
  const binaries = sliceBinaries(dir);
  if (binaries.length === 0) {
    return (
      `No ${XCFRAMEWORK_DIR} slice binaries found under ${dir} -- ` +
      `cannot verify the build configuration.`
    );
  }

  for (const binaryPath of binaries) {
    // A slice directory with no binary fails loudly rather than being skipped:
    // silently ignoring it would let a half-merged xcframework pass the gate on
    // whichever slice happens to be intact.
    if (!existsSync(binaryPath)) {
      return (
        `${binaryPath} not found -- the xcframework has a slice with no binary, ` +
        `so the build configuration cannot be verified.\n` +
        `Rebuild: ./scripts/package-ios.sh --configuration ${expectedConfiguration}`
      );
    }
    const hasMarker = readFileSync(binaryPath).includes(METRO_MARKER);
    if (expectedConfiguration === "Release" && hasMarker) {
      return (
        `${binaryPath} contains the Metro dev-server URL ('${METRO_MARKER}') -- ` +
        `this is a Debug binary regardless of what the stamp says. It must not ` +
        `ship as the Release asset.\nRebuild: ./scripts/package-ios.sh --configuration Release`
      );
    }
    if (expectedConfiguration === "Debug" && !hasMarker) {
      return (
        `${binaryPath} does not contain the Metro dev-server URL ` +
        `('${METRO_MARKER}') -- this is not a Debug binary, so the -debug asset ` +
        `would not load JS from Metro.\n` +
        `Rebuild: ./scripts/package-ios.sh --configuration Debug`
      );
    }
  }
  return null;
}
