/**
 * Clean prebuild: regenerate ios/ and android/ from app.json + Expo config,
 * install CocoaPods for iOS, then apply platform-specific fixups.
 *
 * Usage:
 *   node scripts/prebuild.mjs            # both platforms
 *   node scripts/prebuild.mjs --ios      # iOS only
 *   node scripts/prebuild.mjs --android  # Android only
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const PATCHES_DIR = join("patches");

/**
 * Make `react-native` resolvable at `apps/mobile/node_modules/react-native`.
 *
 * The @callstack/react-native-brownfield Android library reads the RN version
 * from `rootProject.file("../node_modules/react-native/package.json")` (a
 * hardcoded path relative to the generated android/ project). In this pnpm
 * workspace with `nodeLinker: hoisted`, react-native lives only in the
 * workspace-root node_modules, so that path misses and the lib bakes
 * RN_VERSION="unknown" into its BuildConfig. "unknown" compares as < 0.80.0, so
 * ReactNativeBrownfield.initialize() redundantly calls
 * DefaultNewArchitectureEntryPoint.load() a second time (after loadReactNative
 * already did), and the host crashes at launch with "Feature flags cannot be
 * overridden more than once". A symlink to the hoisted package fixes detection
 * (bakes the real 0.83.6) so the second load is skipped.
 */
function ensureReactNativeResolvable() {
  const localLink = join("node_modules", "react-native");
  if (existsSync(join(localLink, "package.json"))) {
    return;
  }
  // A dangling symlink (its target pruned by a later hoist/reinstall) leaves the
  // path present but unresolvable, so the check above misses it while the
  // symlinkSync below would throw EEXIST. Self-heal by removing a BROKEN symlink
  // before relinking. Anything else at this path -- a real file/dir, or a
  // symlink that still resolves but lacks package.json -- is a genuine conflict
  // left for symlinkSync to fail loudly on rather than silently clobbered.
  let existing = null;
  try {
    existing = lstatSync(localLink);
  } catch {
    existing = null;
  }
  if (existing?.isSymbolicLink() && !existsSync(localLink)) {
    console.log(`[prebuild] Removing dangling ${localLink} symlink before relinking`);
    unlinkSync(localLink);
  }
  const require = createRequire(import.meta.url);
  const target = dirname(require.resolve("react-native/package.json"));
  mkdirSync("node_modules", { recursive: true });
  const relTarget = relative("node_modules", target);
  console.log(`[prebuild] Linking ${localLink} -> ${relTarget} (brownfield RN_VERSION detection)`);
  symlinkSync(relTarget, localLink, "dir");
}

const args = process.argv.slice(2);
const iosOnly = args.includes("--ios");
const androidOnly = args.includes("--android");
const platforms = iosOnly ? ["ios"] : androidOnly ? ["android"] : ["ios", "android"];

/**
 * `expo prebuild` bakes the OTA code-signing certificate into the native
 * projects (iOS Expo.plist EXUpdatesCodeSigningCertificate, Android manifest
 * meta-data expo.modules.updates.CODE_SIGNING_CERTIFICATE) from app.json's
 * updates.codeSigningCertificate path. The config plugin throws a generic
 * "File not found" if it is missing; check first and fail with a pointer at the
 * setup script instead. There is no unsigned mode -- see
 * docs/ota-updates.md#code-signing.
 */
function ensureCodeSigningCertificate() {
  const appJson = JSON.parse(readFileSync("app.json", "utf-8"));
  const certRelPath = appJson.expo?.updates?.codeSigningCertificate;
  if (!certRelPath) {
    return;
  }
  if (!existsSync(certRelPath)) {
    console.error(
      `[prebuild] Missing OTA code-signing certificate: ${certRelPath}.\n`
        + "  Run `node scripts/generate-code-signing-keys.mjs` first (once per clone).\n"
        + "  There is no unsigned mode -- see docs/ota-updates.md#code-signing.",
    );
    process.exit(1);
  }
}

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

// 0. Fail loudly before regenerating native projects if the verify certificate
// prebuild bakes into the hosts is missing.
ensureCodeSigningCertificate();

// 0b. Ensure the brownfield Android library can detect the RN version.
if (platforms.includes("android")) {
  ensureReactNativeResolvable();
}

// 1. Remove native directories
for (const platform of platforms) {
  run(`rm -rf ${platform}`);
}

// 2. Run expo prebuild
const platformFlag = platforms.length === 1 ? ` --platform ${platforms[0]}` : "";
run(`npx expo prebuild${platformFlag} --no-install`);

// 3. iOS: install pods.
// All native iOS config is now declarative and applied by `expo prebuild`
// above: expo-build-properties (static frameworks + build-RN-from-source) and
// ./plugins/withBrownfieldUpdates.js (the initializeUpdates() entry point). No
// post-prebuild patching of the Podfile / pbxproj / scheme is needed.
if (platforms.includes("ios")) {
  console.log("\n[prebuild] Running pod install...");
  run("pod install --project-directory=ios");
}

// 4. Apply Android patches
if (platforms.includes("android")) {
  const patches = readdirSync(PATCHES_DIR)
    .filter((f) => f.startsWith("android-") && f.endsWith(".patch"))
    .sort();

  for (const patch of patches) {
    const patchPath = join(PATCHES_DIR, patch);
    console.log(`\n[prebuild] Applying patch: ${patch}`);
    run(`git apply ${patchPath}`);
  }
}

console.log("\n[prebuild] Done!");
