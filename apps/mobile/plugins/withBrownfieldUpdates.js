const { withDangerousMod, withExpoPlist } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Wires runtime environment selection for expo-updates into the brownfield
 * artifacts, so the HOST app can tell the framework whether it is pointed at
 * the dev or production OTA gateway (e.g. from its dev-tools environment
 * selector). Three parts:
 *
 * 1. iOS Expo.plist: writes BOTH environments' manifest URLs
 *    (OtaUpdatesURLDevelopment / OtaUpdatesURLProduction) alongside the
 *    build-selected default EXUpdatesURL. The plist ships with the XCFramework.
 * 2. iOS OtaGatewayLib.swift: the @callstack/react-native-brownfield
 *    config plugin generates a stub that only exposes
 *    ensureExpoModulesProvider(). This injects initializeUpdates(environment:),
 *    which reads the per-environment URL from Expo.plist and applies it via
 *    AppController.overrideConfiguration BEFORE the updates controller is
 *    created (see docs/brownfield.md).
 * 3. Android ReactNativeHostManager.kt: injects an OtaUpdatesEnvironment enum
 *    (URLs baked at prebuild) and makes initialize(application, environment,
 *    onJSBundleLoaded) the ONLY public entry point (the template's
 *    environment-less initialize is demoted to a private boot helper), applying
 *    the matching expo-updates config via UpdatesController.overrideConfiguration
 *    before the RN host boots.
 *
 * Both entry points also publish the host's selection to the JS layer via
 * modules/host-environment (HostEnvironmentRegistry on iOS, HostEnvironment on
 * Android) before React Native boots, so src/api/client.ts can resolve the
 * gateway URL from the live host environment instead of a baked or OTA-cached
 * value.
 *
 * The environment parameter is REQUIRED on both platforms -- there is no
 * environment-less entry point. An environment-less path would either be
 * a silent-default footgun (iOS) or leave the updates controller silently
 * Disabled (Android, no meta-data in the host manifest).
 *
 * Both environments' URLs come from app.config.ts (`extra.updatesUrls`, derived
 * from app.json `extra.gatewayUrls`).
 *
 * Idempotent: each injection no-ops if its signature is already present, so
 * running prebuild more than once is safe.
 *
 * ORDERING: this plugin MUST be listed BEFORE "@callstack/react-native-brownfield"
 * in app.json. Expo's withDangerousMod runs each plugin's action and then its
 * nextMod (the previously-registered plugin), so the LAST-registered dangerous
 * mod runs FIRST. Registering this plugin before brownfield makes brownfield's
 * mod run first (creating the generated files), then this one injects.
 */

const PLIST_KEY_DEV = "OtaUpdatesURLDevelopment";
const PLIST_KEY_PROD = "OtaUpdatesURLProduction";

// Must track app.json -> expo.plugins["@callstack/react-native-brownfield"].ios.frameworkName.
const IOS_FRAMEWORK_NAME = "OtaGatewayLib";

// Must track app.json -> expo.plugins["@callstack/react-native-brownfield"].android.
const ANDROID_MODULE_NAME = "otagatewaylib";
const ANDROID_PACKAGE_PATH = "dev/otagateway";

function readUpdatesUrls(config) {
  const urls = config.extra?.updatesUrls;
  if (!urls?.development || !urls?.production) {
    throw new Error(
      "[withBrownfieldUpdates] extra.updatesUrls.development/production is " +
        "missing. app.config.ts derives it from app.json extra.gatewayUrls.",
    );
  }
  return urls;
}

// ---------------------------------------------------------------------------
// iOS
// ---------------------------------------------------------------------------

const UPDATES_IMPORT = "internal import EXUpdates";
// RCTBundleURLProvider (the Mode A / DEBUG Metro bundle URL override) lives in
// the React module. OtaGatewayLib inherits React-Core from the app target
// (ios/Podfile `inherit! :complete`), so this resolves the same way EXUpdates does.
const REACT_IMPORT = "internal import React";
const HOST_ENVIRONMENT_IMPORT = "internal import ExpoHostEnvironment";
const FOUNDATION_IMPORT = "import Foundation";

const INITIALIZE_UPDATES = `
  /// Which OTA gateway backend the host app is pointed at. Selects the OTA
  /// update endpoint via the ${PLIST_KEY_DEV} / ${PLIST_KEY_PROD}
  /// keys in Expo.plist (written at prebuild by plugins/withBrownfieldUpdates.js).
  public enum OtaUpdatesEnvironment {
    case development
    case production
  }

  /// Call before startReactNative() so expo-updates can resolve the JS bundle
  /// URL. Points expo-updates at the OTA endpoint for the given environment
  /// (read from Expo.plist in the host app's main bundle), then starts the
  /// controller asynchronously so it can load cached updates and check for new
  /// ones. If the startup procedure completes before the RN view requests a
  /// bundle URL, expo-updates provides it; otherwise the factory falls back to
  /// the embedded bundle from the framework.
  ///
  /// Call once, as early as possible; expo-updates configuration cannot be
  /// overridden after the controller is created, so switching environments
  /// requires an app restart.
  ///
  /// Also installs the \`bundleURLOverride\` for the build configuration: Debug
  /// points at the local Metro dev server (Mode A local hot reload); Release
  /// resolves expo-updates' launch asset so surfaces boot the launched OTA
  /// update rather than the framework's embedded bundle. See the inline notes.
  public func initializeUpdates(environment: OtaUpdatesEnvironment) {
    // Publish the host's selection to the JS layer (modules/host-environment)
    // BEFORE React Native starts, so the app resolves its gateway URL from the
    // live host environment instead of a baked or OTA-cached value.
    HostEnvironmentRegistry.shared.configure(
      environment: environment == .production ? "production" : "development"
    )
#if DEBUG
    // Mode A (local hot reload): the JS bundle comes from the Metro dev server,
    // not expo-updates (which is disabled in a Debug-built framework). Resolve
    // the packager URL through bundleURLOverride, which the brownfield runtime
    // returns BEFORE RCTBundleURLProvider runs its /status reachability probe.
    // That probe is flaky on fresh simulator installs and, when it fails, leaves
    // the bundle URL nil -- the "No script URL provided" RedBox. Honor an
    // explicit RCT_jsLocation (RN dev menu "Configure Bundler" / physical
    // device) and fall back to localhost:8081.
    let entryFile = self.entryFile
    self.bundleURLOverride = {
      let settings = RCTBundleURLProvider.sharedSettings()
      let jsLocation = settings.jsLocation ?? ""
      let packagerHost = jsLocation.isEmpty ? "localhost:8081" : jsLocation
      return RCTBundleURLProvider.jsBundleURL(
        forBundleRoot: entryFile,
        packagerHost: packagerHost,
        enableDev: true,
        enableMinification: false,
        inlineSourceMap: false
      )
    }
#else
    // Mode B (release): every brownfield surface must boot the bundle
    // expo-updates LAUNCHED, not the framework's embedded copy. The brownfield
    // runtime pins \`delegate.bundleURL()\` into each new RCTHost
    // (recreateRootView -> bundleURLBlock), and the delegate's release fallback
    // is the embedded main.jsbundle -- so without this override a runtime
    // restart after an OTA download boots stale bytes and the freshly-applied
    // update never renders. \`launchAssetUrl()\` is nil until the AppController
    // startup procedure finishes; the embedded bundle is the correct launch
    // fallback in that window (expo-updates swaps in the update on the next
    // surface rebuild).
    let bundle = self.bundle
    self.bundleURLOverride = {
      AppController.sharedInstance.launchAssetUrl()
        ?? bundle.url(forResource: "main", withExtension: "jsbundle")
    }
#endif
    let key = environment == .production
      ? "${PLIST_KEY_PROD}"
      : "${PLIST_KEY_DEV}"
    if let plistPath = Bundle.main.path(forResource: "Expo", ofType: "plist"),
       let plist = NSDictionary(contentsOfFile: plistPath),
       let updateUrl = plist[key] as? String {
      AppController.overrideConfiguration(configuration: ["EXUpdatesURL": updateUrl])
    } else {
      NSLog("[OtaGatewayLib] %@ missing from Expo.plist; using its default EXUpdatesURL", key)
    }
    AppController.initializeWithoutStarting()
    let controller = AppController.sharedInstance
    if controller.isActiveController {
      controller.start()
    }
  }

  /// Bridge-reload companion to \`initializeUpdates\`: advance expo-updates'
  /// launcher to the newest downloaded update, then call \`completion\` on the
  /// main thread. \`Updates.fetchUpdateAsync()\` only writes the update to the
  /// database -- nothing boots it until a RelaunchProcedure swaps the launcher,
  /// which in standalone apps happens inside \`reloadAsync()\` (unusable in
  /// brownfield). Call this BETWEEN \`stopReactNative()\` and
  /// \`startReactNative()\`: with no live RCTHost the procedure's RCT reload
  /// trigger is a no-op, and the next surface boots the new launch asset via
  /// the release \`bundleURLOverride\` installed by \`initializeUpdates\`.
  ///
  /// Always completes -- on failure (or when updates are disabled) the runtime
  /// restarts on the current launcher rather than wedging the reload.
  public func relaunchUpdates(completion: @escaping () -> Void) {
    let controller = AppController.sharedInstance
    guard controller.isActiveController else {
      DispatchQueue.main.async { completion() }
      return
    }
    controller.requestRelaunch {
      DispatchQueue.main.async { completion() }
    } error: { error in
      NSLog("[OtaGatewayLib] relaunchUpdates failed; restarting on current bundle: %@", error.description)
      DispatchQueue.main.async { completion() }
    }
  }
`;

/**
 * Pure transform of the brownfield-generated OtaGatewayLib.swift source:
 * injects the imports and the initializeUpdates(environment:) entry point.
 * Idempotent (returns the input unchanged once injected); throws on an
 * unexpected template shape. Exported for unit tests, which run it against
 * the real template in node_modules.
 */
function injectSwiftUpdates(src) {
  if (src.includes("func initializeUpdates")) {
    return src;
  }

  // Insert only the imports the injected code needs that are not already
  // present, after the template's `import ReactBrownfield` line:
  //   - Foundation: Bundle/NSDictionary/NSLog (usually already imported)
  //   - EXUpdates: AppController (OTA configuration)
  //   - React: RCTBundleURLProvider (the DEBUG Metro bundle URL override)
  //   - ExpoHostEnvironment: the registry the entry point publishes the
  //     host's environment into (read by src/api/client.ts via JS)
  const missingImports = [
    FOUNDATION_IMPORT,
    UPDATES_IMPORT,
    REACT_IMPORT,
    HOST_ENVIRONMENT_IMPORT,
  ].filter((imp) => !src.includes(imp));
  if (missingImports.length > 0) {
    src = src.replace(
      /(import ReactBrownfield\n)/,
      `$1${missingImports.join("\n")}\n`,
    );
  }
  // A drifted template would make the .replace() above silently no-op and
  // ship Swift that does not compile -- fail the prebuild loudly instead.
  if (
    !src.includes(UPDATES_IMPORT) ||
    !src.includes(FOUNDATION_IMPORT) ||
    !src.includes(REACT_IMPORT) ||
    !src.includes(HOST_ENVIRONMENT_IMPORT)
  ) {
    throw new Error(
      "[withBrownfieldUpdates] Could not inject imports into " +
        "OtaGatewayLib.swift (unexpected template shape). The " +
        "@callstack/react-native-brownfield template may have changed; " +
        "update this plugin.",
    );
  }

  // Insert the members before the final closing brace, which closes the
  // generated `extension ReactNativeBrownfield { ... }` block.
  const lastBrace = src.lastIndexOf("}");
  if (lastBrace === -1) {
    throw new Error(
      "[withBrownfieldUpdates] Could not find the extension closing brace " +
        "in OtaGatewayLib.swift.",
    );
  }
  return src.slice(0, lastBrace) + INITIALIZE_UPDATES + src.slice(lastBrace);
}

function withIosSwiftInjection(config) {
  return withDangerousMod(config, [
    "ios",
    async (config) => {
      const swiftPath = path.join(
        config.modRequest.platformProjectRoot,
        IOS_FRAMEWORK_NAME,
        `${IOS_FRAMEWORK_NAME}.swift`,
      );

      if (!fs.existsSync(swiftPath)) {
        throw new Error(
          `[withBrownfieldUpdates] Expected ${swiftPath} to exist. Did the ` +
            "@callstack/react-native-brownfield plugin run before this one?",
        );
      }

      const src = fs.readFileSync(swiftPath, "utf8");
      const injected = injectSwiftUpdates(src);
      if (injected !== src) {
        fs.writeFileSync(swiftPath, injected);
      }
      return config;
    },
  ]);
}

function withUpdatesEnvironmentPlistKeys(config) {
  return withExpoPlist(config, (config) => {
    const urls = readUpdatesUrls(config);
    config.modResults[PLIST_KEY_DEV] = urls.development;
    config.modResults[PLIST_KEY_PROD] = urls.production;
    return config;
  });
}

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

/**
 * expo config `updates.checkAutomatically` -> the native CHECK_ON_LAUNCH value
 * (mirrors expo-updates' own plugin mapping; passthrough covers native-style
 * values like the "ALWAYS" used in app.json).
 */
function toCheckOnLaunch(checkAutomatically) {
  switch (checkAutomatically) {
    case undefined:
    case "ON_LOAD":
      return "ALWAYS";
    case "ON_ERROR_RECOVERY":
      return "ERROR_RECOVERY_ONLY";
    default:
      return checkAutomatically;
  }
}

function buildKotlinInjection(config) {
  const urls = readUpdatesUrls(config);
  const runtimeVersion = config.runtimeVersion;
  if (typeof runtimeVersion !== "string" || runtimeVersion.length === 0) {
    throw new Error(
      "[withBrownfieldUpdates] expo.runtimeVersion must be a non-empty string " +
        "to bake the Android updates override configuration.",
    );
  }
  const checkOnLaunch = toCheckOnLaunch(config.updates?.checkAutomatically);
  const launchWaitMs = config.updates?.launchWaitMs ?? 0;
  const hasEmbeddedUpdate = config.updates?.useEmbeddedUpdate !== false;

  const enumDecl = `
/**
 * Which OTA gateway backend the host app is pointed at. The OTA endpoints are
 * baked at prebuild from app.json (extra.gatewayUrls) by
 * plugins/withBrownfieldUpdates.js.
 */
enum class OtaUpdatesEnvironment(internal val updateUrl: String) {
    DEVELOPMENT("${urls.development}"),
    PRODUCTION("${urls.production}"),
}
`;

  const initializeEntryPoint = `
    /**
     * Boots the RN runtime, pointing expo-updates at the OTA endpoint for
     * [environment] before the updates controller is created. The override
     * carries the full updates configuration, so it does not depend on
     * expo-updates meta-data in the host app's manifest -- without it the
     * controller initializes silently Disabled and no OTA ever happens. Call
     * once, as early as possible; expo-updates configuration cannot be
     * overridden after initialization, so switching environments requires an
     * app restart.
     */
    fun initialize(
        application: Application,
        environment: OtaUpdatesEnvironment,
        onJSBundleLoaded: OnJSBundleLoaded? = null,
    ) {
        // Publish the host's selection to the JS layer
        // (modules/host-environment) BEFORE React Native boots, so the app
        // resolves its gateway URL from the live host environment instead of
        // a baked or OTA-cached value.
        HostEnvironment.configure(
            if (environment == OtaUpdatesEnvironment.PRODUCTION) "production" else "development",
        )
        UpdatesController.overrideConfiguration(
            application,
            mapOf(
                "enabled" to true,
                "updateUrl" to Uri.parse(environment.updateUrl),
                "runtimeVersion" to "${runtimeVersion}",
                "checkOnLaunch" to "${checkOnLaunch}",
                "launchWaitMs" to ${launchWaitMs},
                "hasEmbeddedUpdate" to ${hasEmbeddedUpdate},
            ),
        )
        bootReactNative(application, onJSBundleLoaded)
    }
`;

  return { enumDecl, initializeEntryPoint };
}

/**
 * Pure transform of the brownfield-generated ReactNativeHostManager.kt source:
 * injects the imports and the OtaUpdatesEnvironment enum, demotes the
 * template's environment-less initialize to a private boot helper, and injects
 * the environment-required initialize entry point. `config` supplies the baked
 * URLs and updates settings (see buildKotlinInjection). Idempotent (returns
 * the input unchanged once injected); throws on an unexpected template shape.
 * Exported for unit tests, which run it against the real template in
 * node_modules.
 */
function injectKotlinUpdates(src, config) {
  if (src.includes("OtaUpdatesEnvironment")) {
    return src;
  }

  const { enumDecl, initializeEntryPoint } = buildKotlinInjection(config);

  src = src.replace(
    /(import android\.app\.Application\n)/,
    "$1import android.net.Uri\n",
  );
  if (!src.includes("import expo.modules.updates.UpdatesController")) {
    src = src.replace(
      /(import expo\.modules\.ApplicationLifecycleDispatcher\n)/,
      "$1import expo.modules.updates.UpdatesController\n",
    );
  }
  if (!src.includes("import expo.modules.hostenvironment.HostEnvironment")) {
    src = src.replace(
      /(import expo\.modules\.ApplicationLifecycleDispatcher\n)/,
      "$1import expo.modules.hostenvironment.HostEnvironment\n",
    );
  }

  // Demote the template's environment-less initialize to a private boot
  // helper: the environment is REQUIRED, and an environment-less entry point
  // would silently leave the updates controller Disabled (no expo-updates
  // meta-data in the host manifest).
  const templateInitialize =
    "fun initialize(application: Application, onJSBundleLoaded: OnJSBundleLoaded? = null) {";
  src = src.replace(
    templateInitialize,
    "private fun bootReactNative(application: Application, onJSBundleLoaded: OnJSBundleLoaded?) {",
  );

  const objectDecl = "object ReactNativeHostManager {";
  if (
    !src.includes("import android.net.Uri") ||
    !src.includes("import expo.modules.updates.UpdatesController") ||
    !src.includes("import expo.modules.hostenvironment.HostEnvironment") ||
    !src.includes("private fun bootReactNative") ||
    !src.includes(objectDecl)
  ) {
    throw new Error(
      "[withBrownfieldUpdates] Could not inject into ReactNativeHostManager.kt " +
        "(unexpected template shape). The @callstack/react-native-brownfield " +
        "template may have changed; update this plugin.",
    );
  }

  src = src.replace(objectDecl, `${enumDecl}\n${objectDecl}`);

  // Insert the entry point before the final closing brace of the object.
  const lastBrace = src.lastIndexOf("}");
  return src.slice(0, lastBrace) + initializeEntryPoint + src.slice(lastBrace);
}

function withAndroidKotlinInjection(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const kotlinPath = path.join(
        config.modRequest.platformProjectRoot,
        ANDROID_MODULE_NAME,
        "src",
        "main",
        "java",
        ANDROID_PACKAGE_PATH,
        "ReactNativeHostManager.kt",
      );

      if (!fs.existsSync(kotlinPath)) {
        throw new Error(
          `[withBrownfieldUpdates] Expected ${kotlinPath} to exist. Did the ` +
            "@callstack/react-native-brownfield plugin run before this one?",
        );
      }

      const src = fs.readFileSync(kotlinPath, "utf8");
      const injected = injectKotlinUpdates(src, config);
      if (injected !== src) {
        fs.writeFileSync(kotlinPath, injected);
      }
      return config;
    },
  ]);
}

module.exports = function withBrownfieldUpdates(config) {
  config = withUpdatesEnvironmentPlistKeys(config);
  config = withIosSwiftInjection(config);
  config = withAndroidKotlinInjection(config);
  return config;
};

// Pure transforms, exported for plugins/__tests__ (the plugin function above
// remains the module's default export for expo's plugin resolution).
module.exports.injectSwiftUpdates = injectSwiftUpdates;
module.exports.injectKotlinUpdates = injectKotlinUpdates;

// Cross-layer coupling constants, exported so plugins/__tests__/drift-guard.test.ts
// can assert they stay in sync with app.json's brownfield plugin config and the
// native host sources. Not used by expo's plugin resolution.
module.exports.IOS_FRAMEWORK_NAME = IOS_FRAMEWORK_NAME;
module.exports.ANDROID_MODULE_NAME = ANDROID_MODULE_NAME;
module.exports.ANDROID_PACKAGE_PATH = ANDROID_PACKAGE_PATH;
module.exports.PLIST_KEY_DEV = PLIST_KEY_DEV;
module.exports.PLIST_KEY_PROD = PLIST_KEY_PROD;
