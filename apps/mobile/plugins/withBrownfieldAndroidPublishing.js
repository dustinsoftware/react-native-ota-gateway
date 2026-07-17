const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The @callstack/react-native-brownfield config plugin generates the Android
 * library module's build.gradle.kts from a template that (a) publishes ALL
 * build variants (`multipleVariants { allVariants() }` + the "default" software
 * component), (b) does not exclude the duplicate native lib that expo-updates
 * ships, and (c) hardcodes the AAR version to 0.0.1-SNAPSHOT. Three problems follow:
 *
 *   1. `brownfield publish:android` runs `publishToMavenLocal`, which - with
 *      allVariants() - forces the DEBUG variant to build. The debug variant pulls
 *      in expo-dev-launcher and expo-dev-menu, which declare the same resources
 *      (drawable/home, raw/keep), so packageDebugResources fails with "Duplicate
 *      resources". We only ever consume the release AAR, so publish release only.
 *   2. expo-updates bundles a libc++_shared.so built with a different NDK than
 *      react-android; it must be excluded so the host app uses react-android's.
 *   3. The AAR coordinate should carry the app version (from app.json
 *      expo.version) with a Maven -SNAPSHOT qualifier, not the template's static
 *      0.0.1-SNAPSHOT.
 *
 * This was previously a patches/ entry, but the brownfield CLI re-runs
 * `expo prebuild` internally (runExpoPrebuildIfNeeded) before every
 * package/publish WITHOUT applying our patches, so the patch was reverted every
 * time. A config plugin runs on every prebuild, including the CLI's, making the
 * change durable.
 *
 * Idempotent: it no-ops once the release-only publishing block is present.
 *
 * ORDERING: this plugin MUST be listed BEFORE "@callstack/react-native-brownfield"
 * in app.json so brownfield's dangerous mod (which writes build.gradle.kts) runs
 * first and this one rewrites the generated file. See withBrownfieldUpdates.js for
 * the same last-registered-runs-first reasoning.
 */
// Must track app.json -> expo.plugins["@callstack/react-native-brownfield"].android.moduleName.
const MODULE_NAME = "otagatewaylib";

/**
 * Read expo-updates' own android/build.gradle so the api dependencies injected
 * below can pin the exact versions expo-updates compiles against (they can
 * never drift). Resolve expo-updates by module resolution rather than assuming
 * a project-local node_modules: in a pnpm workspace with nodeLinker: hoisted
 * the package lives in the workspace-root node_modules, not projectRoot's.
 */
function readExpoUpdatesGradle(projectRoot) {
  const pkgJson = require.resolve("expo-updates/package.json", {
    paths: [projectRoot],
  });
  return fs.readFileSync(
    path.join(path.dirname(pkgJson), "android", "build.gradle"),
    "utf8",
  );
}

/** Pull a version out of expo-updates' gradle, failing loud if it moved. */
function extractVersion(gradleSrc, regex, description) {
  const match = gradleSrc.match(regex);
  if (!match) {
    throw new Error(
      `[withBrownfieldAndroidPublishing] Could not read ${description} from ` +
        "expo-updates' android/build.gradle. expo-updates may have changed how " +
        "it declares the dependency; update this plugin.",
    );
  }
  return match[1];
}

/**
 * The expo-updates runtime dependencies the fat-AAR publish drops from the POM
 * because expo-updates declares them `implementation`. Each must be re-declared
 * `api` so it reaches the consumer's runtime classpath -- otherwise the HOST
 * app crashes with NoClassDefFoundError the moment updates are enabled:
 *   - okhttp-brotli: the enabled controller's OkHttp client uses
 *     BrotliInterceptor (FileDownloader).
 *   - androidx.room (room-runtime / room-ktx): expo-updates persists its
 *     update database with Room; UpdatesController.initialize touches
 *     RoomDatabase immediately.
 *   - bouncycastle bcutil: expo-updates' manifest code-signing helpers link it.
 */
function readExpoUpdatesRuntimeVersions(projectRoot) {
  const gradleSrc = readExpoUpdatesGradle(projectRoot);
  return {
    brotli: extractVersion(gradleSrc, /okhttp-brotli:([\d.]+)/, "the okhttp-brotli version"),
    room: extractVersion(gradleSrc, /room_version\s*=\s*"([\d.]+)"/, "the androidx.room version"),
    bouncycastle: extractVersion(
      gradleSrc,
      /bcutil-jdk15to18:([\d.]+)/,
      "the bouncycastle bcutil version",
    ),
  };
}

const PACKAGING_BLOCK = `
    packaging {
        jniLibs {
            // expo-updates bundles a libc++_shared.so built with a different NDK than
            // react-android. Exclude it so the consuming app uses react-android's version.
            excludes += "**/libc++_shared.so"
            // Keep native (.so) debug symbols so expo-module C++ can be debugged in the
            // consuming host app. Off by default: AGP strips .so symbols when packaging
            // the AAR, and keeping them adds tens of MB to the published artifact -- which
            // every consumer would pay for. Opt in per build with -Pota.keepNativeSymbols=true.
            if (project.findProperty("ota.keepNativeSymbols") == "true") {
                keepDebugSymbols += "**/*.so"
            }
        }
    }
`;

/**
 * Pure transform of the brownfield-generated build.gradle.kts source. Applies
 * all four rewrites (release-only publishing, release software component,
 * libc++_shared.so exclusion, AAR version stamp) plus the okhttp-brotli api
 * dependency. Idempotent (returns the input unchanged once transformed);
 * throws if any transform silently no-ops against a drifted template.
 * Kept pure and exported (below) so it can be unit-tested in isolation against
 * the real template in node_modules.
 */
function rewriteGradle(src, { aarVersion, brotliVersion, roomVersion, bouncycastleVersion }) {
  // Idempotent: the release-only block is our signature transform.
  if (src.includes('singleVariant("release")')) {
    return src;
  }

  // 1. Publish only the release software component.
  src = src.replace(
    'from(components.getByName("default"))',
    'from(components.getByName("release"))',
  );

  // 2. Publish a single release variant (avoids building the broken debug variant).
  src = src.replace(
    /publishing \{\s*multipleVariants \{\s*allVariants\(\)\s*\}\s*\}/,
    'publishing {\n        singleVariant("release") {\n            withSourcesJar()\n        }\n    }',
  );

  // 3. Drop the conflicting libc++_shared.so before buildTypes.
  if (!src.includes('excludes += "**/libc++_shared.so"')) {
    src = src.replace(/\n    buildTypes \{/, `${PACKAGING_BLOCK}\n    buildTypes {`);
  }

  // 3b. Re-declare the expo-updates runtime dependencies the fat-AAR publish
  // drops from the POM (declared `implementation` in expo-updates) as `api`,
  // so they reach the consumer's runtime classpath. Without them the HOST app
  // crashes with NoClassDefFoundError the moment updates are enabled (brotli in
  // FileDownloader's OkHttp client; androidx.room the moment
  // UpdatesController.initialize touches its RoomDatabase; bouncycastle in the
  // manifest code-signing helpers).
  const runtimeDependencies = [
    `api("com.squareup.okhttp3:okhttp-brotli:${brotliVersion}")`,
    `api("androidx.room:room-runtime:${roomVersion}")`,
    `api("androidx.room:room-ktx:${roomVersion}")`,
    `api("org.bouncycastle:bcutil-jdk15to18:${bouncycastleVersion}")`,
  ];
  src = src.replace(
    /(dependencies \{\n)/,
    `$1${runtimeDependencies.map((d) => `    ${d}`).join("\n")}\n`,
  );

  // 4. Stamp the AAR version -- the app version (app.json expo.version) plus a
  // Maven -SNAPSHOT qualifier -- instead of the brownfield template's static
  // 0.0.1-SNAPSHOT.
  src = src.replace(
    'version = "0.0.1-SNAPSHOT"',
    `version = "${aarVersion}"`,
  );

  // Fail loud if any transform silently no-op'd: a future brownfield template
  // version could reformat the strings above so a .replace() matches nothing,
  // which would otherwise let the original all-variants config (and the broken
  // debug publish) return with no error. Better a clear build failure here.
  const missing = [
    ['singleVariant("release")', src.includes('singleVariant("release")')],
    ['release software component', src.includes('from(components.getByName("release"))')],
    ['libc++_shared.so exclusion', src.includes('excludes += "**/libc++_shared.so"')],
    ['keepNativeSymbols gate', src.includes('ota.keepNativeSymbols')],
    ...runtimeDependencies.map((d) => [`api dependency ${d}`, src.includes(d)]),
    [`version ${aarVersion}`, src.includes(`version = "${aarVersion}"`)],
  ].filter(([, applied]) => !applied);
  if (missing.length > 0 || src.includes('components.getByName("default")')) {
    throw new Error(
      "[withBrownfieldAndroidPublishing] Failed to rewrite build.gradle.kts " +
        `(${missing.map(([name]) => name).join(", ") || "stale default component"}). ` +
        "The @callstack/react-native-brownfield template may have changed; update this plugin.",
    );
  }

  return src;
}

module.exports = function withBrownfieldAndroidPublishing(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const gradlePath = path.join(
        config.modRequest.platformProjectRoot,
        MODULE_NAME,
        "build.gradle.kts",
      );

      if (!fs.existsSync(gradlePath)) {
        throw new Error(
          `[withBrownfieldAndroidPublishing] Expected ${gradlePath} to exist. ` +
            "Did the @callstack/react-native-brownfield plugin run before this one?",
        );
      }

      // The AAR coordinate carries the app version (app.json expo.version) with
      // a Maven -SNAPSHOT qualifier.
      const aarBase = config.version;
      if (!aarBase) {
        throw new Error(
          "[withBrownfieldAndroidPublishing] expo.version is missing from " +
            "app.json; it supplies the AAR coordinate version.",
        );
      }

      const src = fs.readFileSync(gradlePath, "utf8");
      // Read from expo-updates itself so an upgrade cannot leave a stale pin.
      const versions = readExpoUpdatesRuntimeVersions(config.modRequest.projectRoot);
      const rewritten = rewriteGradle(src, {
        aarVersion: `${aarBase}-SNAPSHOT`,
        brotliVersion: versions.brotli,
        roomVersion: versions.room,
        bouncycastleVersion: versions.bouncycastle,
      });
      if (rewritten !== src) {
        fs.writeFileSync(gradlePath, rewritten);
      }
      return config;
    },
  ]);
};

// Pure transforms, exported so they can be unit-tested in isolation (the plugin
// function above remains the module's default export for expo's plugin resolution).
module.exports.rewriteGradle = rewriteGradle;
module.exports.readExpoUpdatesRuntimeVersions = readExpoUpdatesRuntimeVersions;
// Exported so plugins/__tests__/drift-guard.test.ts can assert it stays in sync
// with app.json's brownfield module name and the Android host's AAR coordinate.
module.exports.MODULE_NAME = MODULE_NAME;
