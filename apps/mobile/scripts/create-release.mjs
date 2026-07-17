/**
 * Publish the brownfield artifacts for this monorepo as one GitHub release.
 *
 * Each release carries two iOS assets:
 *   - ota-gateway-ios-frameworks-<tag>.zip       (Release -- Shipping mode / OTA)
 *   - ota-gateway-ios-frameworks-<tag>-debug.zip (Debug -- Metro mode / hot reload)
 * so a developer switches runtime modes by downloading the other prebuilt asset
 * (scripts/install-ios-frameworks.mjs) instead of compiling React Native from
 * source.
 *
 * Android needs no separate Debug asset. The release AAR supports Metro through
 * the Android host's runtime "Use Metro dev server" toggle.
 *
 * Prerequisites:
 *   - Build both iOS configurations -- a bare package-ios.sh does Debug (mirrored
 *     to build-debug/) then Release (build/), in that order:
 *       ./scripts/package-ios.sh
 *   - Publish the Android AAR to mavenLocal:
 *       node scripts/prebuild.mjs --android
 *       pnpm brownfield:publish:android
 *   - Install and authenticate the `gh` CLI.
 *
 * Usage:
 *   node scripts/create-release.mjs [--skip-ios-debug] [--dry-run]
 *
 *   --skip-ios-debug  Publish without the Debug iOS asset. Hosts pinned to the
 *                     release cannot download a Metro-enabled framework.
 *   --dry-run         Verify and zip all local artifacts, print what would be
 *                     published, skip GitHub network calls, then clean up.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IOS_FRAMEWORKS,
  verifyBuildInfo,
  verifyMetroMarker,
  verifyNotInstalled,
} from "./ios-build-info.mjs";

const REPO = "dustinsoftware/react-native-ota-gateway";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(MOBILE_DIR, "../..");

const require = createRequire(import.meta.url);
const version = require("../app.json").expo.version;
const tag = `v${version}`;
const headSha = git(["rev-parse", "HEAD"]).trim();

const IOS_PACKAGE_DIR = join(MOBILE_DIR, "ios", ".brownfield", "package", "build");
const IOS_DEBUG_PACKAGE_DIR = join(
  MOBILE_DIR,
  "ios",
  ".brownfield",
  "package",
  "build-debug",
);
const IOS_EXPO_PLIST = "Expo.plist";

const ANDROID_AAR_VERSION = `${version}-SNAPSHOT`;
const ANDROID_AAR_RELDIR = join(
  "dev",
  "otagateway",
  "otagatewaylib",
  ANDROID_AAR_VERSION,
);
const ANDROID_AAR_DIR = join(
  homedir(),
  ".m2",
  "repository",
  ANDROID_AAR_RELDIR,
);
const ANDROID_AAR_NAME = `otagatewaylib-${ANDROID_AAR_VERSION}.aar`;

const WORK_DIR = join(tmpdir(), `ota-release-frameworks-${process.pid}`);
const IOS_ZIP_NAME = `ota-gateway-ios-frameworks-${tag}.zip`;
const IOS_DEBUG_ZIP_NAME = `ota-gateway-ios-frameworks-${tag}-debug.zip`;
const ANDROID_ZIP_NAME = `ota-gateway-android-framework-${tag}.zip`;

const args = process.argv.slice(2);
const supportedArgs = new Set(["--skip-ios-debug", "--dry-run"]);
const unknownArgs = args.filter((arg) => !supportedArgs.has(arg));
const skipIosDebug = args.includes("--skip-ios-debug");
const dryRun = args.includes("--dry-run");

function fatal(message) {
  throw new Error(message);
}

function run(command, commandArgs, options = {}) {
  console.log(`$ ${command} ${commandArgs.join(" ")}`);
  return execFileSync(command, commandArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...options,
  });
}

function git(gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function releaseExists() {
  try {
    execFileSync("gh", ["release", "view", tag, "--repo", REPO], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function formatAge(mtime) {
  const ageMs = Date.now() - mtime.getTime();
  const hours = Math.floor(ageMs / 3_600_000);
  const minutes = Math.floor((ageMs % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m ago` : `${minutes}m ago`;
}

/**
 * The release gate for one iOS package tree, in order: was this tree installed
 * rather than built, does its stamp match this cut, and does the binary agree
 * with the stamp. Order matters -- an installed tree also fails the stamp checks,
 * but with a message about versions that buries the real reason -- so the
 * composition is exported and pinned by a test rather than left to a comment.
 * Returns an error message, or null.
 */
export function describeIosBuildProblem({
  dir,
  expectedConfiguration,
  expectedVersion,
  expectedHeadSha,
}) {
  return (
    verifyNotInstalled(dir) ??
    verifyBuildInfo({
      dir,
      expectedConfiguration,
      expectedVersion,
      expectedHeadSha,
    }) ??
    verifyMetroMarker(dir, expectedConfiguration)
  );
}

function verifyIosBuild(dir, expectedConfiguration) {
  const error = describeIosBuildProblem({
    dir,
    expectedConfiguration,
    expectedVersion: version,
    expectedHeadSha: headSha,
  });

  if (error) {
    fatal(error);
  }
}

function verifyFrameworks(dir, label) {
  const missing = IOS_FRAMEWORKS.filter(
    (framework) => !existsSync(join(dir, framework)),
  );
  if (missing.length === 0) {
    return;
  }

  if (label === "Debug") {
    fatal(
      `iOS Debug (Metro mode) frameworks not found in ${dir}:\n` +
        missing.map((framework) => `  - ${framework}`).join("\n") +
        "\nDebug must be built BEFORE Release (the second build overwrites\n" +
        "build/, which is why Debug is mirrored to build-debug/). A bare\n" +
        "package-ios.sh does both in that order:\n" +
        "  ./scripts/package-ios.sh\n" +
        "or pass --skip-ios-debug to publish without the Metro-enabled asset.",
    );
  }

  fatal(
    `iOS Release (Shipping mode / OTA) frameworks not found in ${dir}:\n` +
      missing.map((framework) => `  - ${framework}`).join("\n") +
      "\nRun './scripts/package-ios.sh' first.",
  );
}

function printFrameworkAges(dir, label) {
  console.log(`[release] iOS ${label} frameworks found:`);
  for (const framework of IOS_FRAMEWORKS) {
    const stat = statSync(join(dir, framework));
    console.log(`  ${framework} (built ${formatAge(stat.mtime)})`);
  }
}

function zipIosFrameworks(sourceDir, outputZip, label) {
  console.log(`[release] Zipping iOS frameworks (${label})...`);
  const stagingDir = join(WORK_DIR, `ios-frameworks-staging-${label.toLowerCase()}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  for (const framework of IOS_FRAMEWORKS) {
    run("ditto", [
      join(sourceDir, framework),
      join(stagingDir, framework),
    ]);
  }

  const expoPlist = join(sourceDir, IOS_EXPO_PLIST);
  if (existsSync(expoPlist)) {
    run("ditto", [expoPlist, join(stagingDir, IOS_EXPO_PLIST)]);
  }

  run("ditto", ["-c", "-k", "--sequesterRsrc", stagingDir, outputZip]);
  rmSync(stagingDir, { recursive: true, force: true });
  printArchiveSize(outputZip);
}

function zipAndroidArtifacts(outputZip) {
  console.log("[release] Zipping Android Maven artifacts...");
  const stagingDir = join(WORK_DIR, "android-maven-staging");
  const stagingVersionDir = join(stagingDir, ANDROID_AAR_RELDIR);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(dirname(stagingVersionDir), { recursive: true });
  run("ditto", [ANDROID_AAR_DIR, stagingVersionDir]);

  const localMetadata = join(ANDROID_AAR_DIR, "maven-metadata-local.xml");
  if (existsSync(localMetadata)) {
    copyFileSync(
      localMetadata,
      join(stagingVersionDir, "maven-metadata.xml"),
    );
  }

  run("ditto", ["-c", "-k", "--sequesterRsrc", stagingDir, outputZip]);
  rmSync(stagingDir, { recursive: true, force: true });
  printArchiveSize(outputZip);
}

function printArchiveSize(archive) {
  const size = (statSync(archive).size / 1024 / 1024).toFixed(1);
  console.log(`  ${archive} (${size} MB)`);
}

function getPreviousTag() {
  try {
    const tags = git([
      "tag",
      "--list",
      "v*",
      "--sort=-version:refname",
      "--merged",
      "HEAD",
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    const currentIndex = tags.indexOf(tag);
    return currentIndex >= 0 ? (tags[currentIndex + 1] ?? null) : (tags[0] ?? null);
  } catch {
    return null;
  }
}

function generateReleaseNotes() {
  const previousTag = getPreviousTag();
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";

  try {
    const log = git(["--no-pager", "log", "--oneline", range]).trim();
    const changes = log
      .split("\n")
      .filter(Boolean)
      .map((line) => `- ${line.replace(/^[a-f0-9]+ /, "")}`);

    return [
      `## Brownfield artifacts ${tag}`,
      "",
      "- iOS Release frameworks -- Shipping mode (JS from OTA / embedded)",
      ...(skipIosDebug
        ? []
        : ["- iOS Debug frameworks -- Metro mode (local hot reload)"]),
      "- Android Maven artifact subtree",
      "",
      "## Changes",
      "",
      ...(changes.length > 0 ? changes : [`- Release ${tag}`]),
      "",
    ].join("\n");
  } catch {
    return `# Brownfield artifacts ${tag}\n`;
  }
}

function preflight() {
  if (unknownArgs.length > 0) {
    fatal(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  }

  console.log(`[release] Version: ${version}`);
  console.log(`[release] Tag:     ${tag}`);
  console.log(`[release] HEAD:    ${headSha}`);
  console.log(`[release] Repo:    ${REPO}`);
  console.log(`[release] Mode:    ${dryRun ? "dry run" : "publish"}`);
  console.log();

  if (dryRun) {
    console.log("[release] Dry run: skipping 'gh release view' preflight.");
  } else if (releaseExists()) {
    fatal(
      `Release ${tag} already exists on ${REPO}.\n` +
        `Delete it first with: gh release delete ${tag} --repo ${REPO} --yes`,
    );
  }

  verifyFrameworks(IOS_PACKAGE_DIR, "Release");
  verifyIosBuild(IOS_PACKAGE_DIR, "Release");
  printFrameworkAges(IOS_PACKAGE_DIR, "Release");

  const releasePlist = join(IOS_PACKAGE_DIR, IOS_EXPO_PLIST);
  if (existsSync(releasePlist)) {
    console.log(
      `  ${IOS_EXPO_PLIST} (built ${formatAge(statSync(releasePlist).mtime)})`,
    );
  } else {
    console.warn(
      `[release] WARNING: ${IOS_EXPO_PLIST} not found in ${IOS_PACKAGE_DIR}.\n` +
        "  OTA updates will not work in the host app without this file.\n" +
        "  Run 'pnpm prebuild --ios' and re-run './scripts/package-ios.sh'.",
    );
  }

  if (skipIosDebug) {
    console.warn(
      "[release] WARNING: --skip-ios-debug was provided. No Debug (Metro mode) " +
        "iOS asset will be published, so hosts pinned to this release cannot " +
        "download a Metro-enabled framework.",
    );
  } else {
    verifyFrameworks(IOS_DEBUG_PACKAGE_DIR, "Debug");
    verifyIosBuild(IOS_DEBUG_PACKAGE_DIR, "Debug");
    printFrameworkAges(IOS_DEBUG_PACKAGE_DIR, "Debug");

    const debugPlist = join(IOS_DEBUG_PACKAGE_DIR, IOS_EXPO_PLIST);
    if (!existsSync(debugPlist)) {
      fatal(
        `${IOS_EXPO_PLIST} not found in ${IOS_DEBUG_PACKAGE_DIR}. Every consumer\n` +
          "of the Debug asset would fail to install it. Rebuild with:\n" +
          "  ./scripts/package-ios.sh --configuration Debug",
      );
    }
    console.log(
      `  ${IOS_EXPO_PLIST} (built ${formatAge(statSync(debugPlist).mtime)})`,
    );
  }

  const aarPath = join(ANDROID_AAR_DIR, ANDROID_AAR_NAME);
  if (!existsSync(ANDROID_AAR_DIR) || !existsSync(aarPath)) {
    fatal(
      `Android AAR subtree not found at:\n  ${ANDROID_AAR_DIR}\n` +
        `Expected ${ANDROID_AAR_NAME}.\n` +
        "Run 'node scripts/prebuild.mjs --android' and " +
        "'pnpm brownfield:publish:android' first.",
    );
  }

  console.log(
    `[release] Android AAR found:\n  ${ANDROID_AAR_NAME} ` +
      `(built ${formatAge(statSync(aarPath).mtime)})`,
  );
  console.log();
}

function main() {
  preflight();

  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const iosZip = join(WORK_DIR, IOS_ZIP_NAME);
  const iosDebugZip = join(WORK_DIR, IOS_DEBUG_ZIP_NAME);
  const androidZip = join(WORK_DIR, ANDROID_ZIP_NAME);
  const notesFile = join(WORK_DIR, "release-notes.md");

  try {
    zipIosFrameworks(IOS_PACKAGE_DIR, iosZip, "Release");
    if (!skipIosDebug) {
      zipIosFrameworks(IOS_DEBUG_PACKAGE_DIR, iosDebugZip, "Debug");
    }
    zipAndroidArtifacts(androidZip);
    writeFileSync(notesFile, generateReleaseNotes());

    const assets = [
      iosZip,
      ...(skipIosDebug ? [] : [iosDebugZip]),
      androidZip,
    ];

    if (dryRun) {
      console.log(`[release] Dry run: would publish ${tag} to ${REPO}:`);
      for (const asset of assets) {
        console.log(`  - ${basename(asset)}`);
      }
      console.log(`  - release notes from ${basename(notesFile)}`);
      return;
    }

    console.log(`[release] Creating release ${tag} on ${REPO}...`);
    const output = run("gh", [
      "release",
      "create",
      tag,
      "--repo",
      REPO,
      "--title",
      tag,
      "--notes-file",
      notesFile,
      ...assets,
    ]);
    if (output.trim()) {
      console.log(output.trim());
    }

    console.log("[release] Done!");
    console.log(`[release] https://github.com/${REPO}/releases/tag/${tag}`);
  } finally {
    rmSync(WORK_DIR, { recursive: true, force: true });
  }
}

// Only when invoked as a script: importing this module (the gate composition is
// unit-tested) must not zip artifacts or call `gh`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    rmSync(WORK_DIR, { recursive: true, force: true });
    console.error(`[release] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
