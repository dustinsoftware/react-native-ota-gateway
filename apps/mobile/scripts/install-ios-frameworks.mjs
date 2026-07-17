/**
 * Install iOS brownfield frameworks into the tree the iOS host links + embeds --
 * ios/.brownfield/package/build/ (see hosts/ios/project.yml) -- either by
 * downloading a published release asset or by copying a local source build.
 *
 * Runtime mode (where JS comes from) is a property of the frameworks you
 * install, so this script is how you switch modes:
 *   - default : the Release asset -> Shipping mode (JS from OTA / embedded)
 *   - --debug : the Debug asset   -> Metro mode (JS from the Metro dev server)
 * Both are PREBUILT: neither requires compiling React Native from source, so
 * switching modes is a download plus a host rebuild.
 *
 * --local installs a source build instead of downloading (for a native change
 * the pinned release cannot contain, or a release that predates the Debug
 * asset). Because package-ios.sh mirrors a Debug build to build-debug/ before a
 * Release build overwrites build/, `--local --debug` installs that mirror --
 * which is how you get back into Metro mode after a `package-ios.sh` (Both) run
 * WITHOUT rebuilding the frameworks.
 *
 * The installed variant is recorded in .install-info.json beside the frameworks:
 * the tree itself is otherwise silent about which mode the host will come up in,
 * and a release must never be cut from an installed (rather than built) tree --
 * create-release.mjs rejects one.
 *
 * Installing REPLACES the destination wholesale; a `--local` install carries the
 * source tree's dSYMs/ across when it has them (downloaded assets have none).
 * The frameworks are embedded into the host app at build time, so nothing takes
 * effect until the host is rebuilt.
 *
 * Usage:
 *   node scripts/install-ios-frameworks.mjs [--debug] [--tag vX.Y.Z]
 *   node scripts/install-ios-frameworks.mjs --local [path] [--debug]
 *
 * A relative --local path is resolved against the directory you ran the command
 * in (pnpm's INIT_CWD), not apps/mobile.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Shared with the release gate on purpose: create-release.mjs reads both markers
// through these same constants, so a rename cannot leave the producer and the
// gate disagreeing about which files they mean.
import {
  BUILD_INFO_FILE,
  INSTALL_INFO_FILE,
  IOS_FRAMEWORKS,
  verifyMetroMarker,
} from "./ios-build-info.mjs";

const REPO = "dustinsoftware/react-native-ota-gateway";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(MOBILE_DIR, "../..");
const require = createRequire(import.meta.url);
const defaultTag = `v${require("../app.json").expo.version}`;

const PACKAGE_DIR = join(MOBILE_DIR, "ios", ".brownfield", "package");
// The only tree the iOS host links + embeds. --debug and --local change what is
// installed here, never where it lands.
export const DESTINATION = join(PACKAGE_DIR, "build");
export const DEBUG_MIRROR = join(PACKAGE_DIR, "build-debug");

const EXPO_PLIST = "Expo.plist";
const DSYM_DIR = "dSYMs";

function fatal(message) {
  throw new Error(message);
}

/**
 * Where a `--local` install reads from. With no path: the build-debug/ mirror for
 * --debug, otherwise build/ itself (which the caller reports as a no-op). A
 * relative path is resolved against the directory the USER ran the command in --
 * pnpm runs package scripts with cwd apps/mobile, so plain cwd would silently
 * anchor `--local ./tree` there no matter where it was typed. INIT_CWD is pnpm's
 * record of the original directory.
 *
 * @param {{
 *   debug?: boolean,
 *   localPath?: string | null,
 *   env?: Record<string, string | undefined>,
 *   cwd?: string,
 * }} options
 * @returns {string}
 */
export function resolveLocalSource({
  debug = false,
  localPath = null,
  env = process.env,
  cwd = process.cwd(),
}) {
  if (localPath) {
    return resolve(env.INIT_CWD || cwd, localPath);
  }
  return debug ? DEBUG_MIRROR : DESTINATION;
}

/** True when both paths are the same filesystem entry (device + inode). */
function isSameEntry(left, right) {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** Every ancestor of `path`, nearest first, stopping at the filesystem root. */
function ancestorsOf(path) {
  const chain = [];
  let current = resolve(path);
  for (let parent = dirname(current); parent !== current; parent = dirname(current)) {
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * Why `sourceDir` cannot be installed from, or null when it is safe. The install
 * replaces the destination, so a source that IS the destination, sits inside it
 * (an asset unzipped into build/), or contains it would be destroyed along with
 * it -- leaving no frameworks at all.
 *
 * Identity is decided by device + inode, not by comparing path strings: macOS is
 * case-insensitive but `realpathSync` does not canonicalise case, so
 * `--local <build with different case>` compared equal to nothing while being
 * the very directory about to be cleared. Inodes settle case, symlinks and
 * `..`-relative paths in one step.
 */
export function describeContainment(sourceDir, destination = DESTINATION) {
  if (isSameEntry(sourceDir, destination)) {
    return `it is the destination itself (${destination}).`;
  }
  if (ancestorsOf(sourceDir).some((parent) => isSameEntry(parent, destination))) {
    return `it lives inside the destination (${destination}).`;
  }
  if (ancestorsOf(destination).some((parent) => isSameEntry(parent, sourceDir))) {
    return `it contains the destination (${destination}).`;
  }
  return null;
}

export function parseArgs(args) {
  let debug = false;
  let local = false;
  let localPath = null;
  let tag = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--debug") {
      debug = true;
    } else if (arg === "--local") {
      local = true;
      // An optional path may follow, but --debug/--tag must not be eaten as one.
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        localPath = next;
        index += 1;
      }
    } else if (arg === "--tag") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        fatal("--tag requires a value such as v0.1.0.");
      }
      tag = value;
      index += 1;
    } else {
      fatal(`Unknown argument: ${arg}`);
    }
  }

  if (local && tag) {
    fatal("--tag applies to a download; it cannot be combined with --local.");
  }

  return { debug, local, localPath, tag: tag ?? defaultTag };
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

/** The configuration recorded in the tree's stamp, or null when it has none. */
function stampedVariant(sourceDir) {
  const stampPath = join(sourceDir, BUILD_INFO_FILE);
  if (!existsSync(stampPath)) {
    return null;
  }
  try {
    const { configuration } = JSON.parse(readFileSync(stampPath, "utf8"));
    if (configuration === "Debug") return "debug";
    if (configuration === "Release") return "release";
    return null;
  } catch {
    return null;
  }
}

/**
 * What a source tree really holds, independent of the caller's flag: the stamp
 * when package-ios.sh wrote one, else the binary itself. Published assets are
 * staged without the stamp (create-release.mjs ships frameworks + Expo.plist
 * only), so an extracted -debug asset has no stamp -- but only a Debug binary
 * carries the Metro fallback URL, which settles it. Returns null when neither
 * source of truth can answer.
 */
export function sourceVariant(sourceDir) {
  const stamped = stampedVariant(sourceDir);
  if (stamped) {
    return stamped;
  }
  if (verifyMetroMarker(sourceDir, "Debug") === null) {
    return "debug";
  }
  if (verifyMetroMarker(sourceDir, "Release") === null) {
    return "release";
  }
  return null;
}

/**
 * A tree is only allowed to replace the host's frameworks once it is complete.
 * Checked on the STAGING copy, so a rejected install leaves the existing tree
 * untouched -- an incomplete asset (an old release cut before one of these
 * frameworks existed, or a truncated download) must not cost a 30-60 minute
 * rebuild. Returns an error message, or null.
 */
export function describeIncompleteInstall(dir) {
  const missing = [...IOS_FRAMEWORKS, EXPO_PLIST].filter(
    (file) => !existsSync(join(dir, file)),
  );
  if (missing.length === 0) {
    return null;
  }
  return (
    `Missing:\n${missing.map((file) => `  - ${file}`).join("\n")}` +
    (missing.includes(EXPO_PLIST)
      ? `\n${EXPO_PLIST} is the expo-updates config the host bundles; repackage ` +
        "after 'pnpm prebuild --ios' so it is generated."
      : "")
  );
}

/** Copy that preserves xcframework symlinks and bundle metadata. */
function dittoCopy(from, to) {
  run("ditto", [from, to]);
}

/**
 * Replace `destination` with `staging` once, at the end. rename is atomic enough
 * for this purpose (same filesystem, since staging is a sibling) and means the
 * only window where the host has no frameworks is the rmSync immediately before
 * it -- rather than the whole download/copy, which is where an interrupted
 * install used to leave nothing.
 */
function swapIntoPlace(staging, destination) {
  rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
}

function writeInstallInfo(dir, info) {
  writeFileSync(
    join(dir, INSTALL_INFO_FILE),
    `${JSON.stringify({ ...info, installedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

function reportNextSteps(variant, log) {
  // Each variant gets its own derived-data path: reusing one across a variant
  // swap fails with "missing required module 'SwiftOnoneSupport'" (see
  // .claude/skills/verify-ios/SKILL.md, Footguns).
  const derivedData = variant === "debug" ? "build-metro" : "build";
  log(
    variant === "debug"
      ? "[install-ios] Debug frameworks installed (Metro mode -- JS from Metro). " +
          "Start Metro (pnpm --filter @ota-gateway/mobile start) before launching."
      : "[install-ios] Release frameworks installed (Shipping mode -- JS from OTA / embedded).",
  );
  log(
    "[install-ios] Next, rebuild the iOS host -- frameworks are embedded at " +
      "build time, so swapping them alone changes nothing:",
  );
  log("  cd hosts/ios && xcodegen");
  log(
    "  xcodebuild -project OtaHost.xcodeproj -scheme OtaHost -sdk iphonesimulator " +
      `-configuration Release -derivedDataPath ${derivedData} build`,
  );
  log(
    `  xcrun simctl install booted ${derivedData}/Build/Products/` +
      "Release-iphonesimulator/OtaHost.app",
  );
}

/**
 * Install a local source build. `destination` and `copy` are injectable so the
 * orchestration -- which guard runs before the destination is touched, and what
 * the destination looks like when one fires -- is testable without a real
 * xcframework or macOS `ditto`.
 *
 * @param {{
 *   debug?: boolean,
 *   localPath?: string | null,
 *   destination?: string,
 *   copy?: (from: string, to: string) => void,
 *   log?: (message: string) => void,
 * }} options
 */
export function installLocal({
  debug = false,
  localPath = null,
  destination = DESTINATION,
  copy = dittoCopy,
  log = console.log,
}) {
  const sourceDir = resolveLocalSource({ debug, localPath });
  const staging = `${destination}.incoming`;

  if (isSameEntry(sourceDir, destination)) {
    // Copying build/ onto itself would delete it. A Release source build already
    // sits where the host reads it, so there is nothing to install.
    log(
      `[install-ios] ${destination} IS the tree the host consumes -- a source ` +
        "build there is already installed. Nothing to do.\n" +
        "  (Use '--local --debug' to install the build-debug/ mirror instead.)",
    );
    return;
  }

  if (!existsSync(sourceDir)) {
    fatal(
      `Local build tree not found: ${sourceDir}\n` +
        (debug
          ? "Build it with './scripts/package-ios.sh --configuration Debug' " +
            "(which mirrors the Debug output to build-debug/)."
          : "Build it with './scripts/package-ios.sh --configuration Release'."),
    );
  }

  // A source that is, sits inside, or contains the destination cannot survive the
  // swap at the end -- an asset unzipped into build/ is the realistic case.
  // Reject it before anything is written.
  const containment = describeContainment(sourceDir, destination);
  if (containment) {
    fatal(
      `Refusing to install from ${sourceDir}: ${containment}\n` +
        `Installing replaces ${destination}, which would delete the source too. ` +
        "Copy the tree somewhere outside it (e.g. a temp dir) and retry.",
    );
  }

  const incomplete = describeIncompleteInstall(sourceDir);
  if (incomplete) {
    fatal(`Local build tree ${sourceDir} is incomplete. ${incomplete}`);
  }

  const flagVariant = debug ? "debug" : "release";
  const variant = sourceVariant(sourceDir) ?? flagVariant;
  if (variant !== flagVariant) {
    log(
      `[install-ios] NOTE: ${sourceDir} really holds ${variant} frameworks -- ` +
        `recording that, not '${flagVariant}'.`,
    );
  }

  log(`[install-ios] Installing local ${variant} frameworks from ${sourceDir}...`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const framework of IOS_FRAMEWORKS) {
      copy(join(sourceDir, framework), join(staging, framework));
    }
    // dSYMs come along when the source has them: without symbols, Metro mode --
    // the mode you are in *because* you are iterating -- cannot step into native
    // expo-module code in the host. The stamp comes too: it records the build
    // these frameworks came FROM (.install-info.json describes this install).
    for (const file of [EXPO_PLIST, BUILD_INFO_FILE, DSYM_DIR]) {
      const source = join(sourceDir, file);
      if (existsSync(source)) {
        copy(source, join(staging, file));
      }
    }

    const staged = describeIncompleteInstall(staging);
    if (staged) {
      fatal(
        `The staged ${variant} install is incomplete, so ${destination} was left ` +
          `as it was. ${staged}`,
      );
    }
    writeInstallInfo(staging, { source: "local", variant, sourcePath: sourceDir });
    swapIntoPlace(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  log(`[install-ios] Installed local ${variant} frameworks into ${destination}`);
  reportNextSteps(variant, log);
}

/**
 * Download a published asset and install it. `download`, `extract` and
 * `destination` are injectable so the orchestration is testable without network
 * access, `gh`, or macOS `ditto`.
 *
 * @param {{
 *   debug?: boolean,
 *   tag: string,
 *   destination?: string,
 *   download?: (args: {tag: string, assetName: string, workDir: string}) => void,
 *   extract?: (args: {archive: string, into: string}) => void,
 *   log?: (message: string) => void,
 * }} options
 */
export function installFromRelease({
  debug = false,
  tag,
  destination = DESTINATION,
  download = ghDownload,
  extract = dittoExtract,
  log = console.log,
}) {
  const variant = debug ? "debug" : "release";
  const assetName = debug
    ? `ota-gateway-ios-frameworks-${tag}-debug.zip`
    : `ota-gateway-ios-frameworks-${tag}.zip`;
  const workDir = join(tmpdir(), `install-ios-frameworks-${process.pid}`);
  const archive = join(workDir, assetName);
  const staging = `${destination}.incoming`;

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  try {
    log(`[install-ios] Downloading ${assetName} from ${REPO} release ${tag}...`);
    try {
      download({ tag, assetName, workDir });
    } catch {
      const debugHint = debug
        ? " This may be an older release that does not include the Debug asset;\n" +
          "  build it instead: './scripts/package-ios.sh --configuration Debug'," +
          " then '--local --debug'."
        : "";
      fatal(
        `Could not download ${assetName} from release ${tag}.${debugHint}\n` +
          `Check the release at https://github.com/${REPO}/releases/tag/${tag}.`,
      );
    }

    if (!existsSync(archive)) {
      fatal(
        `GitHub did not provide the expected asset ${assetName}.` +
          (debug ? " This release may predate the Debug framework asset." : ""),
      );
    }

    // Extract and verify BEFORE the existing tree is touched: a truncated or
    // incomplete asset used to leave the host with an empty build/ and a 30-60
    // minute rebuild as the only way back.
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    extract({ archive, into: staging });

    const staged = describeIncompleteInstall(staging);
    if (staged) {
      fatal(
        `${assetName} is incomplete, so ${destination} was left as it was. ${staged}`,
      );
    }
    writeInstallInfo(staging, { source: "release", variant, tag });
    swapIntoPlace(staging, destination);

    log(`[install-ios] Installed ${assetName} into ${destination}`);
    reportNextSteps(variant, log);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

function ghDownload({ tag, assetName, workDir }) {
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    REPO,
    "--pattern",
    assetName,
    "--dir",
    workDir,
  ]);
}

function dittoExtract({ archive, into }) {
  run("ditto", ["-x", "-k", archive, into]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.local) {
    installLocal(options);
  } else {
    installFromRelease(options);
  }
}

// Only run when invoked as a script: the exports above are unit-tested, and an
// import must not download a release or clear the host's framework tree.
if (process.argv[1] && isSameEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`[install-ios] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
