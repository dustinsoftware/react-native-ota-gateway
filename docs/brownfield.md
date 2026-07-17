# Brownfield Integration

This app is packaged as brownfield artifacts -- an iOS **XCFramework** and an
Android **AAR** -- that an existing native app embeds to render React Native
screens. It builds on stock **`@callstack/react-native-brownfield`** (pinned
exact `3.6.x`) plus two local Expo config plugins and a few build-script extras.

The golden rule: the native host never imports React Native APIs directly. It
consumes a clean facade (`ReactNativeBrownfield` / the generated host manager)
and renders any route by passing an `initialUrl` prop. One module, `OtaGatewayApp`,
boots the full Expo Router app; a new brownfield screen is a native-side change
only.

Genericized names: iOS framework/scheme `OtaGatewayLib`, Android module
`otagatewaylib`, package/group `dev.otagateway`, AAR coordinate
`dev.otagateway:otagatewaylib:0.1.0-SNAPSHOT`, RN module `OtaGatewayApp`.

## Packaging pipeline

The Callstack CLI does the heavy lifting (prebuild, pod install / gradle, build
device + simulator, merge XCFrameworks, publish the AAR). Our additions are the
two config plugins (applied automatically during every prebuild) and the extras
in `scripts/package-ios.sh`.

### iOS: `scripts/package-ios.sh`

A thin wrapper around `brownfield package:ios --scheme OtaGatewayLib
--configuration <cfg>`. It adds what the CLI does not:

- **Invokes the CLI via `pnpm exec brownfield`** -- in this hoisted pnpm
  workspace the `brownfield` binary is symlinked into the **workspace-root**
  `node_modules/.bin`, not `apps/mobile/node_modules/.bin`, so a hardcoded
  `apps/mobile/node_modules/.bin/brownfield` path does not exist. Mirrors the
  Android publish flow.
- **Forces `OTA_ENVIRONMENT=production`** (and unsets `OTA_GATEWAY_URL`) so the
  embedded bundle's baked default can never carry a dev gateway regardless of the
  caller's shell. Dev traffic is selected at runtime by the host (see the
  host-environment seam in [configuration.md](./configuration.md)).
- **Exports `CCACHE_BINARY`** -- RN is built from source, so builds are slow;
  ccache caches C/C++/ObjC across builds (install with `brew install ccache`).
  Cold builds run 30-60+ min; with a warm ccache a Release package is ~2-6 min.
- **Builds `OtaGatewayLib` with an `@rpath` install name** -- passes
  `DYLIB_INSTALL_NAME_BASE=@rpath` in `--extra-params`. Without it the framework
  target inherits Xcode's default `INSTALL_PATH=/Library/Frameworks` and bakes an
  **absolute** install name (`/Library/Frameworks/OtaGatewayLib.framework/...`);
  a host that Embed & Signs the framework (reached via its
  `@executable_path/Frameworks` rpath) then crashes at launch with a dyld
  `Library not loaded: /Library/Frameworks/OtaGatewayLib.framework/...` error.
  It must be set **at build time** -- a post-build `install_name_tool` fixup
  invalidates the code signature and yields a `CODESIGNING "Invalid Page"` crash
  instead. (`hermesvm.xcframework` already ships `@rpath`; `ReactBrownfield` is a
  stripped interface archive with no install name.)
- **Copies `Expo.plist`** (expo-updates config) into the package output. The CLI
  does not. Verify the slug-derived source path after the first prebuild
  (expected `ios/otagatewayapp/Supporting/Expo.plist`).
- **Harvests dSYMs** -- forces `DEBUG_INFORMATION_FORMAT=dwarf-with-dsym` and
  copies the standalone dSYMs into the build output, so the native surface (all
  statically linked into `OtaGatewayLib`) can be debugged in the host.

```
./scripts/package-ios.sh                        # Release (default) -- Mode B
./scripts/package-ios.sh --configuration Debug  # Debug (loads JS from Metro) -- Mode A
```

Output: `ios/.brownfield/package/build/` containing `OtaGatewayLib.xcframework`,
`ReactBrownfield.xcframework` (interface-only, binary stripped -- its symbols are
already linked into `OtaGatewayLib`), `hermesvm.xcframework`, `Expo.plist`, and
`dSYMs/`.

iOS native config is fully declarative (`expo-build-properties` sets
`ios.useFrameworks: "static"` and `ios.buildReactNativeFromSource: true`), so a
clean prebuild reproduces it -- no Podfile/pbxproj post-patching. Static
frameworks are required so `ReactBrownfield` builds as a real `.framework` the
CLI can merge and strip; build-from-source is required because the brownfield
pod imports `React_RCTAppDelegate`, a Swift module that only exists when RN is
built from source.

### Android: prebuild + publish

```
node scripts/prebuild.mjs --android                                        # applies our patches
OTA_ENVIRONMENT=production pnpm exec brownfield publish:android --module-name otagatewaylib
```

Publishes to `mavenLocal()`
(`~/.m2/repository/dev/otagateway/otagatewaylib/0.1.0-SNAPSHOT/`). The publish
sets `OTA_ENVIRONMENT=production` inline for the same reason iOS does.

## The two config plugins

Both are listed **before** `@callstack/react-native-brownfield` in `app.json`.
Expo runs the last-registered dangerous mod first, so brownfield's mod runs first
(generating the files) and ours then rewrites them. Both are **idempotent** (they
no-op once their signature is present) and **fail loud** if the template shape
drifts (so a template bump produces a clear build error, not silently broken
native code).

### `plugins/withBrownfieldUpdates.js`

Wires runtime environment selection for expo-updates into the artifacts so the
host can point the framework at dev or prod, and publishes that selection to the
JS layer before RN boots.

- **iOS `Expo.plist`** -- writes both environments' manifest URLs,
  `OtaUpdatesURLDevelopment` and `OtaUpdatesURLProduction`, alongside the
  build-selected default `EXUpdatesURL`. The plist ships with the XCFramework.
- **iOS `ios/OtaGatewayLib/OtaGatewayLib.swift`** -- injects an
  `OtaUpdatesEnvironment` enum and an `initializeUpdates(environment:)` entry
  point into the CLI-generated stub. It reads the per-environment URL from
  `Expo.plist` and applies it via `AppController.overrideConfiguration` **before**
  the updates controller is created, then starts the controller. It also:
  - publishes the host's selection to the JS layer via
    `HostEnvironmentRegistry` (`modules/host-environment`), so
    `src/api/gateway-url.ts` resolves the gateway from the live host selection
    rather than a baked or OTA-cached value;
  - under `#if DEBUG` only, installs a `bundleURLOverride` that resolves the
    Metro packager URL directly (honoring an explicit `RCT_jsLocation`, else
    `localhost:8081`) and returns it **before** `RCTBundleURLProvider`'s
    `/status` reachability probe (which is flaky on fresh installs and, when it
    fails, leaves the bundle URL nil -- the "No script URL provided" RedBox).
    Compiled out of Release, so it never coexists with expo-updates owning the
    URL.
- **Android
  `android/otagatewaylib/src/main/java/dev/otagateway/ReactNativeHostManager.kt`**
  -- injects an `OtaUpdatesEnvironment` enum (URLs baked at prebuild), **demotes
  the template's environment-less `initialize` to a private `bootReactNative`
  helper**, and injects the environment-**required**
  `initialize(application, environment, onJSBundleLoaded)` entry point. That
  entry point applies a full expo-updates config
  (`enabled`, `updateUrl`, `runtimeVersion`, `checkOnLaunch`, `launchWaitMs`,
  `hasEmbeddedUpdate`) via `UpdatesController.overrideConfiguration` before the
  RN host boots, and publishes the selection to the JS layer via
  `HostEnvironment` (`modules/host-environment`).

The environment parameter is **required** on both platforms -- there is no
environment-less entry point. On iOS an environment-less path was a
silent-default footgun; on Android a host that relies on expo-updates meta-data
absent from its merged manifest initializes the controller **silently Disabled**,
so no OTA ever happens. expo-updates config cannot be overridden after the
controller initializes, so the environment is chosen once, early; switching
requires an app restart, and initializing twice throws.

### `plugins/withBrownfieldAndroidPublishing.js`

Rewrites the CLI-generated `otagatewaylib/build.gradle.kts`. Doing this as a
config plugin (not a `patches/` entry) is deliberate: the brownfield CLI re-runs
prebuild internally before every package/publish and would revert a patch, but
runs every config plugin.

- **`singleVariant("release")`** (with `withSourcesJar()`) instead of
  `multipleVariants { allVariants() }`. Publishing all variants forces the debug
  variant to build, which pulls in `expo-dev-launcher` / `expo-dev-menu` whose
  duplicate resources (`drawable/home`, `raw/keep`) fail
  `packageDebugResources`. We only consume the release AAR.
- **Publish the `release` software component** (was `default`).
- **Exclude `**/libc++_shared.so`** -- expo-updates bundles one built with a
  different NDK than react-android; the host must use react-android's.
- **Re-declare expo-updates' dropped runtime deps as `api`.** expo-updates
  declares several deps `implementation`, which the fat-AAR publish drops from
  the POM -- so a minimal host (one without a large transitive dependency tree
  that happens to supply them) crashes with `NoClassDefFoundError` the moment
  updates initialize. Re-declared as `api`, with versions read from
  expo-updates' own gradle so they can never drift:
  - **`okhttp-brotli`** -- the enabled controller's OkHttp client uses
    `BrotliInterceptor` (in `FileDownloader`).
  - **`androidx.room` (`room-runtime` + `room-ktx`)** -- expo-updates persists
    its update database with Room; `UpdatesController.initialize` touches
    `RoomDatabase` immediately (crash: `NoClassDefFoundError androidx.room.RoomDatabase`).
  - **`org.bouncycastle:bcutil-jdk15to18`** -- expo-updates' manifest
    code-signing helpers link it.
  (A production host with a large transitive dependency tree typically supplies
  room/bouncycastle already, so a production brownfield library need not declare
  them. This demo's minimal host does not, hence the explicit re-declaration.)

  This list is **empirically derived** -- it is the set observed crashing this
  minimal host, not a proof of completeness. expo-updates/expo-modules-core
  declare other deps `implementation` too (e.g. `okhttp`, `okhttp-urlconnection`
  are supplied transitively by react-android; `kotlin-reflect` resolves via the
  fat-AAR's merged classes). A host with a different dependency tree could surface
  another dropped POM dep as a fresh `NoClassDefFoundError`; add it here the same
  way (version read from expo-updates' gradle).
- **Stamp the AAR version** `0.1.0-SNAPSHOT` (from `app.json` `expo.version`)
  instead of the template's static `0.0.1-SNAPSHOT`.
- **`ota.keepNativeSymbols` gate** -- adds `keepDebugSymbols += "**/*.so"` only
  when `-Pota.keepNativeSymbols=true`, so the default published AAR stays lean
  (unstripped `.so`s add tens of MB) but native symbols are available on demand.

## Patches and prebuild ordering

`patches/` holds two Android patches (already dependency-free) applied to the
**generated** `android/` tree via `git apply` by `scripts/prebuild.mjs`. The
brownfield CLI's internal prebuild does **not** run `scripts/prebuild.mjs`, so it
skips these patches -- always run `node scripts/prebuild.mjs --android` first,
and keep any durable gradle change in the config plugin (which the CLI *does*
run), never in a patch. The CLI only runs its internal prebuild when the platform
directory is missing.

`scripts/prebuild.mjs` also runs `ensureReactNativeResolvable()` before an
Android prebuild: the `@callstack/react-native-brownfield` Android library reads
the RN version from a hardcoded relative path
(`apps/mobile/android/../node_modules/react-native/package.json`). In this pnpm
workspace with `nodeLinker: hoisted`, react-native lives only in the
**workspace-root** `node_modules`, so that path misses and the lib bakes
`RN_VERSION="unknown"` into its `BuildConfig`. `"unknown"` compares as `< 0.80.0`,
so `ReactNativeBrownfield.initialize()` calls `DefaultNewArchitectureEntryPoint.load()`
a **second** time (after `loadReactNative` already did) and the host crashes at
launch with `"Feature flags cannot be overridden more than once"`. The helper
symlinks `apps/mobile/node_modules/react-native` to the hoisted package so the RN
version is detected correctly (`0.83.6`) and the redundant load is skipped.

---

## Host integration recipe -- iOS

The host is `hosts/ios`, an XcodeGen project (`project.yml` checked in, the
`.xcodeproj` gitignored), simulator-only (`CODE_SIGNING_ALLOWED=NO`). Target name
`OtaHost`.

### `project.yml` framework rules (load-bearing)

| Framework | Rule |
| --- | --- |
| `OtaGatewayLib.xcframework` | **Link + Embed & Sign** |
| `hermesvm.xcframework` | **Embed & Sign** |
| `ReactBrownfield.xcframework` | **Link only** -- interface-only, never embed (its binary is stripped; its symbols live inside `OtaGatewayLib`) |
| `Expo.plist` | **Copy Bundle Resources** -- exact filename, into the main bundle (expo-updates looks it up by exact name in `Bundle.main`; without it `Updates.isEnabled` is silently false) |

Framework paths are relative into the `apps/mobile` iOS build output
(`ios/.brownfield/package/build/`).

### Bootstrap order

`AppDelegate` / `SceneDelegate` set a `UINavigationController` whose root is
`HostShellViewController`, and run the bootstrap on launch.
`BrownfieldBootstrap.swift` does, in this order:

```
1  ReactNativeBrownfield.shared.bundle = ReactNativeBundle
2  ReactNativeBrownfield.shared.ensureExpoModulesProvider()
3  ReactNativeBrownfield.shared.initializeUpdates(environment: <from UserDefaults>)
4  ReactNativeBrownfield.shared.startReactNative { ... }
5  subscribe: ReactNativeBrownfield.shared.onMessage { msg in
       if msg.type == "reload" { BrownfieldReloader.shared.reload() }
   }
```

`initializeUpdates` must run before `startReactNative`. **Retain the `onMessage`
subscription token** (store it on the delegate); if it is deallocated the reload
message is dropped.

### Native tabs and `BrownfieldReloader.swift`

`HostShellViewController.swift` owns a native `UITabBar` with Developer, Sky,
and Spinner items plus one content slot. It does **not** use
`UITabBarController`, because retaining one RN controller per item would create
multiple simultaneous Expo Router roots in the shared JS runtime. A tab
selection first removes the current `ReactNativeViewController`, then creates a
new tracked controller through `BrownfieldReloader` with `/developer`, `/sky`,
or `/spinner` as `initialUrl`.

The reloader tracks the one live RN controller weakly. On reload it stops and
restarts RN, then asks the host shell to recreate the currently selected route.
The native shell, selected tab, and presented settings controller remain in
place. `Updates.reloadAsync()` is never called from the host (it crashes in
brownfield); the JS side posts `{ type: 'reload' }`.

### Host Settings

The Developer tab shows a native Settings action.
`HostSettingsViewController.swift` contains the environment segmented control
(persisted to `UserDefaults`, labeled "restart required"), OTA URL for the
selected environment, and manual RN reload. Routes are selected only by the
native tab bar; the old "Open RN" buttons no longer exist.

### ATS

`Info.plist` sets **`NSAllowsLocalNetworking: true`** so App Transport Security
permits `http://localhost` (the simulator reaches the demo servers directly).

### Mode A on iOS

No runtime Metro toggle exists on iOS (a Release framework's enabled expo-updates
owns the bundle URL and always beats a host override). Instead build the Debug
artifact (`./scripts/package-ios.sh --configuration Debug`, which disables
expo-updates and installs the `#if DEBUG` `bundleURLOverride` -> `:8081`) and
rebuild the host against it. See [development-workflow.md](./development-workflow.md).

---

## Host integration recipe -- Android

The host is `hosts/android`, a standalone Gradle project mirroring the generated
project (Gradle 8.14.4, compileSdk 36, minSdk 24, JDK 17).

### `app/build.gradle.kts`

- Depend on the AAR from `mavenLocal()`:
  `implementation("dev.otagateway:otagatewaylib:0.1.0-SNAPSHOT")`.
- `packaging { jniLibs { pickFirsts += "**/libc++_shared.so"; pickFirsts += "**/libfbjni.so" } }`
  (Kotlin DSL) -- the AAR and react-android both ship these `.so`s.
- The AAR is **release-only**, so the host's debug build type must add
  `matchingFallbacks += "release"` (otherwise the debug build fails to resolve
  the dependency).
- **REQUIRED: force the `release` variant of `react-android` / `hermes-android`
  via variant-aware dependency substitution.** `react-android` publishes
  separate debug/release variants of `libreactnative.so` whose C++ Props struct
  layouts differ (the debug variant carries extra members). The AAR's Fabric
  codegen (`libappmodules.so`, `libreact_codegen_rnscreens.so`, ...) is compiled
  against the **release** headers. A host **debug** build otherwise resolves the
  **debug** `react-android`, so at launch the debug `libreactnative`'s
  `HostPlatformViewProps` constructor writes debug-only fields past the end of
  the smaller release-layout object the AAR's codegen allocated -- a native
  write **SIGSEGV** during Fabric `ComponentDescriptorRegistry` construction,
  before any JS runs:

  ```
  signal 11 (SIGSEGV) ... (write)
  #00 libreactnative.so  HostPlatformViewProps::HostPlatformViewProps(..., std::function<bool(string const&)> const&)+124
  #01 libreact_codegen_rnscreens.so  RNSScreenStackHeaderConfigProps::...
  ...  RawPropsParser::prepare -> Scheduler -> FabricUIManagerBinding::installFabricUIManager
  ```

  Neither standalone build hits this (debug app = debug react-android + debug
  headers; release app = release + release). Only a brownfield host that mixes a
  debug build type with the release AAR does. The `libreactnative.so`/`libc++`
  are byte-identical across working/crashing debug APKs, so it is invisible to a
  naive debug-vs-debug comparison. Fix (Kotlin DSL; versions **must track the
  AAR's react-native version**):

  ```kotlin
  import com.android.build.api.attributes.BuildTypeAttr

  configurations.configureEach {
      resolutionStrategy.dependencySubstitution {
          substitute(module("com.facebook.react:react-android"))
              .using(variant(module("com.facebook.react:react-android:0.83.6")) {
                  attributes {
                      attribute(BuildTypeAttr.ATTRIBUTE, objects.named(BuildTypeAttr::class.java, "release"))
                  }
              })
          substitute(module("com.facebook.hermes:hermes-android"))
              .using(variant(module("com.facebook.hermes:hermes-android:0.14.1")) {
                  attributes {
                      attribute(BuildTypeAttr.ATTRIBUTE, objects.named(BuildTypeAttr::class.java, "release"))
                  }
              })
      }
  }
  ```

  Verify by comparing the host APK's `libreactnative.so` sha against the
  `react-android-<ver>-release.aar` in `~/.gradle/caches` -- they must match.
  (Mirrors a production brownfield host's `build.gradle`.)

### `OtaHostApplication.kt`

Must implement `ReactApplication` and expose the brownfield react host --
`RelaunchProcedure` requires it. The getter guards against being read before RN
is initialized (the brownfield `shared`/`reactHost` are `lateinit`):

```kotlin
override val reactHost: ReactHost?
    get() = try {
        ReactNativeBrownfield.shared.reactHost
    } catch (e: UninitializedPropertyAccessException) {
        null
    }
```

`onCreate` initializes RN based on the Metro pref:

```kotlin
if (DebugPrefs.useMetro(this)) {
    ReactNativeDevHostManager.initialize(this)                       // Mode A
} else {
    ReactNativeHostManager.initialize(this, envFromPrefs(this), null) // Mode B
}
// then install the reload handler (below)
```

Only the Mode B path (`ReactNativeHostManager.initialize`) publishes the
selected environment to the `host-environment` native module
(`HostEnvironment.configure`). Mode A leaves `HostEnvironment.current` unset, so
under Metro the JS falls back toward the production API gateway regardless of the
environment radio -- the radio is effectively an **OTA/Mode-B control**. (Metro
owns the bundle in Mode A; wiring the radio into Mode A would mean calling
`HostEnvironment.configure` from `ReactNativeDevHostManager` too.)

### `ReactNativeDevHostManager.kt` (Mode A)

Mirrors the generated `ReactNativeHostManager` but points RN at Metro:
`ExpoReactHostFactory.getDefaultReactHost(useDevSupport = true)` plus
`ReactNativeBrownfield.initialize(...)`. This is what the "Use Metro dev server"
toggle selects; the runtime toggle works on Android because bundle resolution
honors `useDevSupport` at runtime (no iOS-style constraint).

### `BrownfieldReloadHandler.kt`

Subscribes to `onMessage`; on `type == "reload"` calls
`UpdatesController.instance.relaunchReactApplicationForModule()`. (Log via
`android.util.Log` -- no Timber dependency in the demo.) Android needs no
`BrownfieldReloader` equivalent: relaunching the RN root here is enough.

### `RNHostActivity.kt` (launcher and native tab shell)

`RNHostActivity` owns a native Material `BottomNavigationView` with Developer,
Sky, and Spinner items, a toolbar, and one fragment container. It creates one
`ReactNativeFragment` with the selected route:

```kotlin
ReactNativeFragment.createReactNativeFragment(
    "OtaGatewayApp",
    bundleOf("initialUrl" to selectedRoute.path),
)
```

Callstack's `createView` registers an Activity-scoped Back callback without a
Fragment lifecycle owner. Replacing several fragments inside one Activity would
leave callbacks from removed surfaces registered. A tab selection therefore
persists the route, removes the current fragment, and recreates the Activity.
The old callback and RN root die with the old Activity before the new route
mounts. `HostRoutePrefs` restores the selected tab after tab changes, OTA
relaunch, or process death.

### `HostSettingsActivity.kt`

The Developer toolbar action opens native Host Settings: OTA URLs, environment
radio, "Use Metro dev server" toggle, and Relaunch. The former native-only
`MainActivity` and its route-opening buttons were removed.

### Cleartext networking

`res/xml/network_security_config.xml` must permit **cleartext for `localhost` and
`10.0.2.2`** (API 28+ blocks `http` by default; without it OTA against the local
servers silently fails). `DebugPrefs.kt` holds the pref accessors.

### Networking

`adb reverse tcp:3000 tcp:3000`, `tcp:3001`, `tcp:8081` -- on the emulator too,
not just physical devices. See [development-workflow.md](./development-workflow.md).

---

## Gotchas

- **Plugin order.** Both config plugins must precede
  `@callstack/react-native-brownfield` in `app.json` (last-registered dangerous
  mod runs first). Wrong order and our injectors run against files that do not
  exist yet and throw.
- **Patches vs the CLI's internal prebuild.** The brownfield CLI re-runs prebuild
  itself and skips `scripts/prebuild.mjs`, so a `patches/` entry would be
  reverted on every package/publish. Durable gradle changes live in the config
  plugin; always run `prebuild.mjs` before any manual gradle work.
- **`react-android` debug/release variant mismatch (host SIGSEGV).** A brownfield
  host debug build must substitute the **release** variant of
  `react-android`/`hermes-android` -- see the `app/build.gradle.kts` REQUIRED
  item above. Without it the host crashes natively at launch in Fabric registry
  construction.
- **Pin the expo family exact.** `apps/mobile/package.json` pins `expo`,
  `expo-router`, `expo-updates`, and the rest of the `expo-*` / `@expo/*` family
  to **exact** versions (no `~`), matching the versions the brownfield AAR was
  built against. The `expo` package drives autolinking, the Android gradle plugin,
  and `loadReactNative` (the RN init path), so a floated patch bump can desync the
  host's runtime init from the AAR's compiled codegen. (This did not cause the
  variant-mismatch SIGSEGV above, but exact pins keep the host on the same
  on-device-proven combination as the source repo.)
- **iOS framework `@rpath` install name (host dyld crash).** `OtaGatewayLib`
  must be packaged with an `@rpath` install name (`DYLIB_INSTALL_NAME_BASE=@rpath`
  in `package-ios.sh`); otherwise the host crashes at launch with a dyld `Library
  not loaded: /Library/Frameworks/OtaGatewayLib.framework/...`. See the
  packaging-pipeline item above. Fix it at build time, never with a post-build
  `install_name_tool` (that breaks the signature -> `CODESIGNING "Invalid Page"`).
- **ATS / cleartext.** iOS needs `NSAllowsLocalNetworking: true`; Android needs
  the cleartext `network_security_config.xml`. Missing either makes OTA against
  `http://localhost` fail silently.
- **`backBehavior="none"`.** The brownfield tab layout (`app-tabs.tsx`) sets
  `backBehavior={isBrownfieldHost() ? 'none' : 'initialRoute'}`. Under a host the
  RN tab bar is hidden; with the Android default (`initialRoute`) a hardware
  back press can jump within that hidden navigator instead of bubbling to the
  native host. With `'none'` the visible RN route delegates Back to the host.
- **`freshRouteContext` route-bleed fix (identity-fragile).**
  `src/brownfield/runtime.ts` wraps the require-context in a *new identity* per
  mount. expo-router's module-global store restores the previous navigation state
  on Android when the same context object mounts again, so without it a second
  native screen renders the previous screen's route instead of its own
  `initialUrl`. This depends on expo-router internals -- keep the warning comment,
  keep versions pinned, and re-verify on any expo-router bump.
- **iOS later-mount intermittent blank (known issue, not yet closed).** Before
  native tabs, opening `/developer` as the second pushed RN surface sometimes
  produced a blank screen. The host now permits only one mounted RN surface at
  a time, but tab switching still creates a later surface in the same shared
  runtime. Re-run repeated Developer -> Sky -> Spinner -> Developer cycles
  before treating the old symptom as resolved. Never retain concurrent Expo
  Router roots in this host; keep the `freshRouteContext` warning above and
  re-verify both issues on any expo-router bump.

## Related docs

- [ota-updates.md](./ota-updates.md) -- the OTA protocol and the reload contract.
- [configuration.md](./configuration.md) -- the host-environment seam and the
  per-environment update-URL wiring.
- [development-workflow.md](./development-workflow.md) -- building and running the
  hosts, Mode A/B steps.
