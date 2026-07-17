# Brownfield Integration

This app is packaged as brownfield artifacts -- an iOS **XCFramework** and an
Android **AAR** -- that an existing native app embeds to render React Native
screens. It builds on stock **`@callstack/react-native-brownfield`** (pinned
exact) plus two local Expo config plugins and a few build-script extras. Which of
those additions exist only because of the pinned versions -- and which upstream
has since absorbed -- is recorded in
[Relationship to upstream](#relationship-to-upstream).

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
- **Verifies framework versioning** (App Store gate): fails the package if any
  `OtaGatewayLib.framework` slice's `Info.plist` is missing
  `CFBundleShortVersionString` / `CFBundleVersion`, or carries a version that
  does not match `app.json`'s `expo.version`. App Store uploads reject a host
  IPA whose embedded framework lacks `CFBundleShortVersionString`
  (ITMS-90057). The value comes from `MARKETING_VERSION`, which `app.config.ts`
  stamps into the `@callstack/react-native-brownfield` plugin's
  `ios.buildSettings` from `expo.version` -- the same source as the Android AAR
  coordinate. Without the stamp, the plugin's `Info.plist` template references
  `$(MARKETING_VERSION)` with no build setting defined and Xcode drops the key.
  The plugin only writes build settings when it CREATES the target, and the
  CLI's internal `expo prebuild` is not clean (only `pnpm prebuild` deletes
  `ios/`) -- the value-match check is what catches a stale `ios/` still stamped
  with a pre-bump version. On a gate failure, run
  `pnpm --filter @ota-gateway/mobile prebuild --ios` (or delete
  `apps/mobile/ios/`) and rerun. The gate itself lives in
  `scripts/verify-ios-framework-version.sh` (called by `package-ios.sh`) so its
  failure branches are unit-tested against fixture plists
  (`scripts/__tests__/verify-ios-framework-version.test.ts`; macOS-only -- it
  uses `PlistBuddy` -- so the Linux CI merge gate skips it).

  The same package + gate can be run in CI on demand (never automatically): the
  manual-only `iOS Framework Verify` workflow
  (`.github/workflows/ios-framework-verify.yml`, `workflow_dispatch`) packages
  Release on a macOS runner and uploads the xcframeworks as an artifact --
  dispatch it on a PR branch before merging a packaging-affecting change, or on
  `main`. Never make it automatic: an RN-from-source iOS build costs 1-2 hours
  of macOS runner time.
- **Copies `Expo.plist`** (expo-updates config) into the package output. The CLI
  does not. Verify the slug-derived source path after the first prebuild
  (expected `ios/otagatewayapp/Supporting/Expo.plist`). The copied plist must
  include the code-signing keys (`EXUpdatesCodeSigningCertificate` /
  `EXUpdatesCodeSigningMetadata`) prebuild baked into it, or the host ships
  without a verify cert (see [ota-updates.md](./ota-updates.md#code-signing)).
- **Harvests dSYMs** -- forces `DEBUG_INFORMATION_FORMAT=dwarf-with-dsym` and
  copies the standalone dSYMs into the build output, so the native surface (all
  statically linked into `OtaGatewayLib`) can be debugged in the host.
- **Stamps `.build-info.json`** (configuration + resolved version + HEAD sha +
  `builtAt`) into the package output, and for a **Debug** build mirrors the
  frameworks + `Expo.plist` + the Debug dSYMs + stamp to
  `ios/.brownfield/package/build-debug/`. The prior stamp, any
  `.install-info.json` an install left behind, and the mirror are all removed
  **before** the build starts and the stamp is written **last** (after the CLI
  package, the version gate, the `Expo.plist` copy, and the dSYM harvest), so an
  interrupted run under `set -euo pipefail` leaves no stamp -- a downstream
  release then treats the tree as unbuilt and refuses to ship it. The brownfield
  CLI hardcodes `build/` as its only output, so a release cut builds **Debug
  first** (mirrored aside to `build-debug/`), then **Release** (overwrites
  `build/`); `create-release.mjs` verifies both stamps AND greps each built
  binary for the Metro fallback URL (`localhost:8081`, compiled in only under
  `#if DEBUG`), so a wrong-configuration or stale tree can never ship under the
  wrong asset name (`scripts/ios-build-info.mjs`).

Framework packaging keeps **code signing enabled** (ad-hoc, identity `-`) -- it
never passes `CODE_SIGNING_ALLOWED=NO`. Note which binary the risk is about: the
entitlements SecureStore needs come from the **host** target's signing (see
"Running on a physical device"), and the framework's own ad-hoc signature is
discarded and re-applied when the host embeds and signs it. So disabling signing
here is very likely harmless -- but the failure it would cause is silent (the OTA
gate treats every launch as stale), and nobody has verified it on this host.

> Open trade-off: packaging unsigned would let a machine with no Apple
> Development certificate build the **device** slice, which the framework build
> needs and a simulator-only host build does not -- the main barrier for a fresh
> clone. Verifying it means an OTA run across relaunches, which has not been done
> here.

```
./scripts/package-ios.sh                          # DEFAULT: both, Debug then Release
./scripts/package-ios.sh --configuration Debug    # Debug only (loads JS from Metro -- Metro mode)
./scripts/package-ios.sh --configuration Release  # Release only (OTA / embedded -- Shipping mode)
```

The default builds **both** variants back to back, so cutting a release is one
command instead of two. Debug runs FIRST on purpose: the brownfield CLI hardcodes
`build/` as its output, so the Debug tree is mirrored to `build-debug/` before the
Release build overwrites `build/`. Reversing the order would leave `build/`
holding Debug frameworks for `create-release.mjs` to publish as the Release asset.
Each pass is a fresh re-invocation of this script, so the stamp invalidation and
the versioning gate run per configuration and a Debug failure aborts before the
Release pass. Expect roughly double a single build's time -- pin
`--configuration Release` when only the shippable artifact matters (as
`.github/workflows/ios-framework-verify.yml` does).

Output: `ios/.brownfield/package/build/` containing `OtaGatewayLib.xcframework`,
`ReactBrownfield.xcframework` (interface-only, binary stripped -- its symbols are
already linked into `OtaGatewayLib`), `hermesvm.xcframework`, `Expo.plist`,
`dSYMs/`, and `.build-info.json`. A Debug build additionally mirrors the
frameworks + `Expo.plist` + the Debug dSYMs + stamp to
`ios/.brownfield/package/build-debug/`.

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

## Releasing and consuming frameworks

Building the iOS frameworks from source costs 30-60+ min (RN is compiled from
source; see ccache above). To avoid paying that per developer, a release
publishes the prebuilt frameworks as GitHub release assets and the host
downloads a pinned copy instead of building locally.

### `scripts/create-release.mjs` (`pnpm release:frameworks`)

Publishes a GitHub release tagged `v<version>` on
`dustinsoftware/react-native-ota-gateway` (single-repo model -- iOS and Android
assets ride the same release). The version comes from `app.json`'s
`expo.version` (this repo has no git-tag version derivation). Assets:

- `ota-gateway-ios-frameworks-<tag>.zip` -- the **Release** `build/` tree
  (Shipping mode: JS from OTA / the embedded bundle).
- `ota-gateway-ios-frameworks-<tag>-debug.zip` -- the **Debug** `build-debug/` tree
  (Metro mode: local hot reload), so developers install the Metro-enabled
  framework instead of building RN from source.
- `ota-gateway-android-framework-<tag>.zip` -- the full mavenLocal Maven subtree for
  `dev.otagateway:otagatewaylib`.

Prerequisites: iOS frameworks built **Debug first, then Release** -- a bare
`./scripts/package-ios.sh` does exactly that (the Debug build is mirrored to
`build-debug/`, and both trees' `.build-info.json` stamps plus their per-slice
Metro markers are verified against the release version before anything is
uploaded) -- and the Android AAR published. Flags: `--skip-ios-debug` publishes without the Debug
asset (escape hatch only -- Android needs no debug asset because its release AAR
already supports Metro via the host's runtime toggle); `--dry-run` runs every
gate and stages the zips but makes no `gh` network calls.

### `scripts/install-ios-frameworks.mjs` (`pnpm install:ios`)

Installs frameworks into `ios/.brownfield/package/build/` -- the only directory
`hosts/ios/project.yml` references, and therefore the one tree the host links and
embeds. Everything lands there; the flags select *what* is installed, not where
(runtime mode is a property of which framework you install):

| Invocation | Installs |
| --- | --- |
| `pnpm install:ios` | the release's Release asset -> Shipping mode |
| `pnpm install:ios --debug` | the release's Debug asset -> Metro mode |
| `pnpm install:ios --tag v0.1.2` | a specific release instead of `app.json`'s version |
| `pnpm install:ios --local --debug` | the local `build-debug/` mirror -> Metro mode, **no repackage** |
| `pnpm install:ios --local <path>` | any source-build tree (e.g. an extracted asset), which must sit **outside** `build/`. A relative path resolves against the directory you ran the command in, not `apps/mobile` |

Downloads use `gh release download` and extract with `ditto -x -k`; `--local`
copies with `ditto` so xcframework symlinks and bundle metadata survive.

`--local --debug` is what makes switching modes free after a source build: a bare
`package-ios.sh` leaves Release in `build/` and Debug in `build-debug/`, so
installing the mirror puts the host back in Metro mode without recompiling React
Native. Note the asymmetry: there is no `build-release/` mirror, so the return
trip installs the release asset (`pnpm install:ios`) or rebuilds Release.
`build-debug/` is otherwise a producer-side release-staging mirror and is never a
host consumption path. `--local` with no path and no `--debug` resolves to
`build/` itself and is reported as a no-op rather than deleting the tree.

A `--local` install refuses a source tree missing any framework or `Expo.plist`,
and one that sits inside (or is a symlink to) the destination -- both checks run
*before* the destination is cleared, since clearing it would otherwise take the
source with it. Debug `dSYMs/` ride along when the source has them, so Metro mode
keeps native symbols.

Each install records `.install-info.json` -- `{source, variant, tag | sourcePath,
installedAt}` -- beside the frameworks. Two reasons: the tree is otherwise silent
about which mode the host will boot into, and `create-release.mjs` refuses to
publish a tree carrying that marker (`verifyNotInstalled`), so a downloaded
artifact can never be re-cut under a new tag. `package-ios.sh` deletes the marker
at the start of every build, so a genuine rebuild is publishable again.

The recorded variant is ground truth, not the flag: it comes from the source
tree's `.build-info.json` stamp when there is one, otherwise from the framework
binary itself (only a Debug binary carries the Metro fallback URL -- published
assets ship without the stamp, so an extracted `-debug` asset is identified this
way). `--local <a Debug tree>` is therefore recorded as `debug` even without
`--debug`. In an installed tree a copied `.build-info.json` describes the build
the frameworks came FROM; `.install-info.json` is the file that describes what is
installed here.

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
  The plist also carries the code-signing keys baked by prebuild
  (`EXUpdatesCodeSigningCertificate`, `EXUpdatesCodeSigningMetadata`; see
  [ota-updates.md](./ota-updates.md#code-signing)) -- these must ride along in the
  copied plist and survive the `overrideConfiguration` below, or the host starts
  expo-updates without a verify cert.
- **iOS `ios/OtaGatewayLib/OtaGatewayLib.swift`** -- injects an
  `OtaUpdatesEnvironment` enum and an `initializeUpdates(environment:)` entry
  point into the CLI-generated stub. It reads the per-environment URL from
  `Expo.plist` and applies it via `AppController.overrideConfiguration` **before**
  the updates controller is created, then starts the controller.
  `overrideConfiguration` **merges** the override dictionary onto the full
  `Expo.plist` config (expo-updates' `configWithExpoPlist(mergingOtherDictionary:)`),
  so the code-signing keys (`EXUpdatesCodeSigningCertificate` /
  `EXUpdatesCodeSigningMetadata`) baked into the plist survive automatically.
  The entry point nonetheless **copies them forward explicitly** into the
  override dictionary alongside the URL, as defense-in-depth: if the merge
  semantics ever change, signature verification must not silently switch off.
  It also:
  - publishes the host's selection to the JS layer via
    `HostEnvironmentRegistry` (`modules/host-environment`), so
    `src/api/gateway-url.ts` resolves the gateway from the live host selection
    rather than a baked or OTA-cached value;
  - under `#if DEBUG`, installs a `bundleURLOverride` that resolves the
    Metro packager URL directly (honoring an explicit `RCT_jsLocation`, else
    `localhost:8081`) and returns it **before** `RCTBundleURLProvider`'s
    `/status` reachability probe (which is flaky on fresh installs and, when it
    fails, leaves the bundle URL nil -- the "No script URL provided" RedBox);
  - in Release, installs a `bundleURLOverride` resolving
    `AppController.launchAssetUrl()` (falling back to the framework's embedded
    `main.jsbundle` while startup is in flight). Required because the
    brownfield runtime pins `delegate.bundleURL()` into every new RCTHost;
    without the override a restarted runtime boots the embedded bundle and OTA
    updates never render in place (see the reloader section below);
  - exposes `relaunchUpdates(completion:)`, the bridge-reload companion:
    advances expo-updates' launcher to the newest downloaded update via
    `requestRelaunch`. The host calls it between `stopReactNative()` and
    `startReactNative()`.
- **Android
  `android/otagatewaylib/src/main/java/dev/otagateway/ReactNativeHostManager.kt`**
  -- injects an `OtaUpdatesEnvironment` enum (URLs baked at prebuild), **demotes
  the template's environment-less `initialize` to a private `bootReactNative`
  helper**, and injects the environment-**required**
  `initialize(application, environment, onJSBundleLoaded)` entry point. That
  entry point applies the expo-updates config
  (`enabled`, `updateUrl`, `runtimeVersion`, `checkOnLaunch`, `launchWaitMs`,
  `hasEmbeddedUpdate`) via `UpdatesController.overrideConfiguration` before the
  RN host boots, and publishes the selection to the JS layer via
  `HostEnvironment` (`modules/host-environment`). The code-signing meta-data
  (`expo.modules.updates.CODE_SIGNING_CERTIFICATE` / `...CODE_SIGNING_METADATA`)
  is baked into the library manifest at prebuild and rides the AAR -> host
  manifest merge. The override deliberately **omits** the code-signing keys:
  when a key is absent from the override map, expo-updates'
  `UpdatesConfiguration` falls back per-key to the host manifest meta-data, so
  the baked certificate keeps verifying manifests without the override having to
  re-supply it (see [ota-updates.md](./ota-updates.md#code-signing)).

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

## Relationship to upstream

Several of the pieces described above exist because the upstream library did not
do them **at the versions this repo pins**. Upstream is a moving target and has
since absorbed some of them, so the pins are recorded here and worth re-checking
on every bump -- otherwise these workarounds quietly become permanent.

Versions below were checked 2026-07-28. To refresh: `npm view
@callstack/react-native-brownfield version` and `npm view expo-updates@sdk-55
version` (the `sdk-55` dist-tag is the line this repo tracks).

| Package | Pinned here | Latest |
| --- | --- | --- |
| `@callstack/react-native-brownfield` | `3.6.1` | `5.0.0` |
| `@callstack/brownfield-cli` | `3.6.1` | `5.0.0` |
| `expo` | `55.0.19` | `55.0.28` (`sdk-55`) |
| `expo-updates` | `55.0.20` | `55.0.26` (`sdk-55`) |

### What upstream covers

The CLI at this pin has three packaging commands -- `package:ios`,
`package:android`, `publish:android` (plus `brownie` and navigation codegen); run
`pnpm exec brownfield --help` to confirm. `package:ios` can archive for App Store
Connect / TestFlight and `publish:android` publishes to Maven **local**, but there
is no artifact *version gating* and no release-hosting concept -- which is why
`scripts/create-release.mjs` and `scripts/install-ios-frameworks.mjs` exist here.

Upstream does document expo-updates for brownfield -- `guides/expo-updates/how-to.mdx`
and `guides/expo-updates/expo-55.mdx` at
[oss.callstack.com/react-native-brownfield](https://oss.callstack.com/react-native-brownfield/).
The first is an entry point (do the brownfield plugin setup, then Expo's own
updates setup); the second is six **Android** patches to expo-updates itself,
marked temporary, three of which are relaunch plumbing
(`RelaunchProcedure`, `RecreateReactContextProcedure`,
`RestartReactAppExtensions`). iOS gets one line on both pages: "Supported out of
the box from version `expo-updates@55.0.21` and onwards." Neither page covers a
self-hosted update server, per-environment update URLs, code signing, or Metro in
a host. Note our two `patches/` files are unrelated to those Android patches --
ours patch the *generated* `android/` tree (an annotations conflict and the Gradle
version), theirs patch `expo-updates` in `node_modules`.

### Absorbed upstream -- deletion candidates on a bump

Published `5.0.0` does two of the things `plugins/withBrownfieldUpdates.js`
injects by hand (see [the two config plugins](#the-two-config-plugins) for why
each exists):

- `ios/Expo/ExpoHostRuntime.swift:132` calls
  `AppController.initializeWithoutStarting()`, and `:219` resolves the non-Debug
  bundle URL from `launchAssetUrl()`. Note the paired `start()` lives in
  `ios/Views/ReactNativeViewController.swift` upstream, not in the runtime.
- The pinned `3.6.1` ships the same runtime at `ios/ExpoHostRuntime.swift` -- it is
  where `bundleURLOverride` itself lives -- but contains neither call:
  `grep -rn 'initializeWithoutStarting\|launchAssetUrl'
  node_modules/@callstack/react-native-brownfield/` returns nothing.

Three iOS brownfield fixes also sit **one patch above** our `expo-updates` pin,
per the `sdk-55` branch changelog
([raw](https://raw.githubusercontent.com/expo/expo/sdk-55/packages/expo-updates/CHANGELOG.md);
`main` lists the same commits under 56.0.0, which is why they are easy to miss):

| Fix | Ships in |
| --- | --- |
| "[ios] Fix loading assets in brownfield" ([#44724](https://github.com/expo/expo/pull/44724)) | after `55.0.20` -- it merged 2026-04-14, five days after `55.0.20` was published, and is absent from the installed tarball |
| "[ios] resolve `Expo.plist` lookup in brownfield xcframework builds" ([#44645](https://github.com/expo/expo/pull/44645)) | `55.0.21` |
| "[ios] Support multiple root view creations in brownfield" ([#44771](https://github.com/expo/expo/pull/44771)) | `55.0.21` |

That makes the re-test a **patch bump** (`55.0.20` -> latest `55.0.x`), not an SDK
56 migration. The `Expo.plist` lookup fix *overlaps* the plist copy in
`scripts/package-ios.sh`, but does not by itself make it removable: upstream's fix
changes where expo-updates looks (main bundle, else the framework bundle), while
our copy exists to get the file to the host at all, and the injected Swift reads
it from `Bundle.main`. Deleting the copy would also mean shipping the plist as an
xcframework resource and changing that read.

### Grey area -- re-check, do not assume

The `#if DEBUG` Metro override is neither absorbed nor clearly ours. `3.6.1`
already has a Debug path, but it goes through `RCTBundleURLProvider`'s `/status`
reachability probe, which is flaky on fresh simulator installs and leaves the
bundle URL nil when it fails ("No script URL provided"). Ours takes precedence via
`bundleURLOverride`, which the runtime checks first
(`ios/ExpoHostRuntime.swift:168`).

### Stays ours

No upstream equivalent, so do not go looking for one:

- The self-hosted gateway -- the Expo Updates protocol server
  (`src/app/api/v2/updates/manifest+api.ts`), signed multipart manifests,
  per-environment update ids, `OtaGate`. See [ota-updates.md](./ota-updates.md).
  This is the bulk of the OTA code and is an Expo Updates concern, not a
  brownfield one.
- `relaunchUpdates` -- advancing the expo-updates launcher between
  `stopReactNative()` and `startReactNative()`. Upstream handles no reload on iOS
  (`requestRelaunch` appears nowhere in their tree; their relaunch work is the
  Android guide above).
- Per-environment update URLs via `AppController.overrideConfiguration`, carrying
  the code-signing keys forward. See [configuration.md](./configuration.md).
- Everything under [Packaging pipeline](#packaging-pipeline) and [Releasing and
  consuming frameworks](#releasing-and-consuming-frameworks): the App Store
  versioning gate, dSYM harvest, `.build-info.json` stamps, the two-configuration
  build, release assets and `install:ios`.

> Before bumping: a brownfield or expo-updates upgrade with ABI impact is a
> native-contract change, so it forces a `runtimeVersion` bump, which orphans every
> host in the field until it takes an app-store update -- see
> [version-skew.md](./version-skew.md). And treat a bump as an experiment on a
> branch rather than a cleanup: nothing above has been tested against a newer pin,
> the whole OTA path here is verified against `3.6.1` behavior, and two of the
> seams would change owner.

---

## Host integration recipe -- iOS

The host is `hosts/ios`, an XcodeGen project (`project.yml` checked in, the
`.xcodeproj` gitignored), built for the **simulator by default** and **ad-hoc
signed** (identity `-`, with `OtaHost/OtaHost.entitlements`); device and App
Store builds are per-build overrides, below. Ad-hoc signing costs nothing (no
certificates or team). What it buys over a fully unsigned
`CODE_SIGNING_ALLOWED=NO` build is that signing stays *enabled*, so
`ProcessProductPackaging` runs, expands the entitlements file into
`OtaHost.app-Simulated.xcent`, and the linker embeds that into the binary's
`__TEXT,__entitlements` section -- which is where the simulator reads the
keychain entitlements expo-secure-store needs. An unsigned host has no such
section and fails every `SecItemAdd`/`SecItemCopyMatching` with
`errSecMissingEntitlement`, so the OTA staleness timestamp
(`src/utils/ota-timestamp.ts`) silently never persists and the OTA gate treats
every launch as stale. Never pass `CODE_SIGNING_ALLOWED=NO` for a host you
intend to run; it overrides the project settings and re-breaks this. Target name
`OtaHost`.

Note that the ad-hoc code *signature* carries an empty entitlement dict, so
`codesign -d --entitlements - <app>` printing `[Dict]` on a simulator build is
expected and is **not** evidence the setup is broken. Check the real thing:

```
plutil -p <DerivedData>/Build/Intermediates.noindex/OtaHost.build/\
Release-iphonesimulator/OtaHost.build/OtaHost.app-Simulated.xcent
```

### Running on a physical device

The default flow is the simulator, but the host builds and signs for a real
device without editing `project.yml`. Both values in
`OtaHost/OtaHost.entitlements` are written against
`$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)` rather than a literal
bundle id, precisely so that a device build works: a hardcoded id fails signing
with *"provisioning profile ... doesn't match the entitlements file's value for
the application-identifier entitlement"* the moment the bundle id differs from
it. `$(AppIdentifierPrefix)` expands to the team prefix whenever Xcode can
resolve a team on the build machine -- including team-free ad-hoc simulator
builds, where it resolves one from the installed signing identities -- and to
nothing when it cannot. The prefix is therefore machine-dependent; the keychain
access group stays app-private either way, so the one file covers both.

Signing still needs a team, which `project.yml` deliberately does not set (it
would break the team-free simulator flow). Pass it per-build:

```
xcodebuild -project OtaHost.xcodeproj -scheme OtaHost \
  -sdk iphoneos -configuration Debug -destination 'generic/platform=iOS' \
  -derivedDataPath build-device -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<TEAMID> CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_IDENTITY="Apple Development" build
```

`-allowProvisioningUpdates` is not optional on a fresh machine: without it,
automatic signing cannot create a profile and the build fails with *"No profiles
for '<bundle id>' were found"* (exit 65). It succeeds without the flag only if
the Xcode UI has already produced a matching profile under
`~/Library/Developer/Xcode/UserData/Provisioning Profiles/`. The first run also
needs Xcode signed in to an Apple ID on the team.

Setting the team in the Xcode UI works too, but the `.xcodeproj` is generated
and gitignored -- the next `xcodegen` run discards that edit.

### App Store distribution

Uploading the host to App Store Connect runs server-side validation that a local
build does not. Three of its requirements are already satisfied in
`Info.plist` / `project.yml`, and each one is easy to undo by accident:

| Requirement | Where | Failure if removed |
| --- | --- | --- |
| An `AppIcon` set in an asset catalog | `Assets.xcassets`, `ASSETCATALOG_COMPILER_APPICON_NAME` | ITMS-90713, ITMS-90022, ITMS-90023 |
| All **four** interface orientations | `UISupportedInterfaceOrientations` | ITMS-90474 |
| A privacy manifest for the host's own required-reason APIs | `OtaHost/PrivacyInfo.xcprivacy` | ITMS-91053 |

The orientation rule catches people out: the target ships for iPad
(`TARGETED_DEVICE_FAMILY: "1,2"`), and an iPad app must support portrait,
portrait-upside-down and both landscapes or it cannot support multitasking.
`UIRequiresFullScreen` was the old opt-out and is defunct as of the iOS 26 SDK,
so the choices are all four orientations or dropping to iPhone-only (family
`1`). `xcodebuild` warns about this -- *"All interface orientations must be
supported unless the app requires full screen"* -- so treat that warning as an
upload blocker rather than noise. **The warning is emitted only for an
`-sdk iphoneos` build**, not for the simulator build the default flow uses, so
the default flow will never show it. An unsigned device-SDK build is enough to
surface it and needs no certificate, team or profile:

```
xcodebuild -project OtaHost.xcodeproj -scheme OtaHost \
  -sdk iphoneos -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath build-validate \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
```

`CODE_SIGNING_ALLOWED=NO` is safe *here* specifically because this build is only
ever inspected, never launched -- see the SecureStore warning above before
reusing the flag for anything you intend to run.

`PrivacyInfo.xcprivacy` is needed because the host itself touches `UserDefaults`
(`Brownfield.swift`, `HostStateStore.swift`), which is a required-reason API. The
pods inside `OtaGatewayLib.framework` carry their own manifests and Apple
aggregates them; the host's file covers only host code. If host code starts
using another required-reason API (file timestamps, disk space, `mach_absolute`
uptime), add it there.

When an upload fails, read
`~/Library/Developer/Xcode/Archives/<date>/<archive>` rather than trusting the
log alone: `ContentDelivery.log` replays *saved uploader state* from earlier
attempts, so already-fixed errors reappear alongside the live one. Confirm what
was actually uploaded with:

```
plutil -p <archive>.xcarchive/Products/Applications/OtaHost.app/Info.plist
```

The host app id (`com.regalcinemas.reactnativetest`) is duplicated across
`project.yml`, the Android `applicationId`, every `.maestro/` flow and the
`verify-ios` skill, because each of those launches the app by id. That coupling
is pinned by the drift guard (`apps/mobile/plugins/__tests__/drift-guard.test.ts`),
so a partial rename fails `pnpm test` rather than only failing on-device --
`.maestro/verify-rotation-android-part2.yaml` in particular has no `launchApp`,
so nothing validates its `appId` at runtime.

### `project.yml` framework rules (load-bearing)

| Framework | Rule |
| --- | --- |
| `OtaGatewayLib.xcframework` | **Link + Embed & Sign** |
| `hermesvm.xcframework` | **Embed & Sign** |
| `ReactBrownfield.xcframework` | **Link only** -- interface-only, never embed (its binary is stripped; its symbols live inside `OtaGatewayLib`) |
| `Expo.plist` | **Copy Bundle Resources** -- exact filename, into the main bundle (expo-updates looks it up by exact name in `Bundle.main`; without it `Updates.isEnabled` is silently false) |
| `OtaHost/PrivacyInfo.xcprivacy` | **Copy Bundle Resources** -- declared explicitly (and excluded from the `OtaHost` directory sweep) so it does not depend on xcodegen's fallback rule for unrecognised extensions. Must sit at the `.app` root or upload fails ITMS-91053 |
| `OtaHost/Assets.xcassets` | Swept in by the `OtaHost` directory source; compiled by `actool`, which is what emits `CFBundleIconName` (see `ASSETCATALOG_COMPILER_APPICON_NAME`) |

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

The reloader tracks the one live RN controller weakly. On reload it (1) stops
RN, (2) calls `OtaGatewayLib.relaunchUpdates` -- which runs expo-updates'
`requestRelaunch` to advance the launcher to the newest downloaded update --
and (3) on completion restarts RN and asks the host shell to recreate the
currently selected route. The native shell, selected tab, and presented
settings controller remain in place. `Updates.reloadAsync()` is never called
from the host (it crashes in brownfield); the JS side posts
`{ type: 'reload' }`. A reload arriving while a restart is in flight is
dropped (`isReloading` guard).

**Both the relaunch step and its ordering are load-bearing** (this fixed a
real bug: without them, Restart rebooted the previously-launched bundle and
only a process relaunch applied the update -- the same defect is present in a
separate production brownfield integration). `Updates.fetchUpdateAsync()`
only writes the update to the database; nothing boots it until a
`RelaunchProcedure` swaps the launcher.
And the brownfield runtime pins `delegate.bundleURL()` into every new RCTHost
(`recreateRootView` -> `bundleURLBlock`), whose release fallback is the
framework's **embedded** bundle -- hence the release `bundleURLOverride`
(installed by `initializeUpdates`) resolving `AppController.launchAssetUrl()`.
Stopping RN BEFORE `requestRelaunch` matters too: the procedure fires an RCT
reload trigger that is a no-op with no live host but would reload a live
brownfield root out from under the shell (the documented `reloadAsync` crash).

> Historical footnote: when the host was built UNSIGNED
> (`CODE_SIGNING_ALLOWED=NO`), broken SecureStore persistence made the OTA
> gate treat every launch as stale, which amplified the pre-fix staleness bug
> into an infinite reload loop (~12Hz runtime churn, blank surface, process
> death). Ad-hoc signing fixed the persistence (see the iOS host section);
> the relaunch seam above fixed the staleness.

### Host Settings

The Developer tab shows a native Settings action.
`HostSettingsViewController.swift` contains the environment segmented control
(persisted to `UserDefaults`, labeled "restart required"), OTA URL for the
selected environment, and manual RN reload. Routes are selected only by the
native tab bar; the old "Open RN" buttons no longer exist.

### More tab -- pushed native/RN screens

The fourth tab, **More**, is NATIVE (`MoreMenuViewController`, a table of
Test 1 / Test 2 / Test 3). It mounts no RN surface in the shell's content
slot; its rows PUSH dedicated screens onto the shell's `UINavigationController`
-- the standard nav-bar title + back chevron + push transition, mirroring how
the product hosts present a pushed RN screen:

- **Test 1 / Test 2** push RN screens (`/test-one`, `/test-two`), built through
  `BrownfieldReloader.makeViewController` so an OTA reload accounts for them.
  Test 1 contains an RN-internal link to Test 2 -- navigation WITHIN the pushed
  surface; the RN-side back button pops it without touching the native stack.
- **Test 3** pushes a fully native screen with the same presentation, and its
  button pushes RN Test 1 on top: native menu -> native screen -> RN screen on
  one back stack is the mix-and-match point of the demo.

While More is selected, a pushed Test screen is the ONLY live RN surface (the
shell mounts none), so the one-ExpoRoot rule holds. On an OTA reload the shell
pops to root first (`rebuildActiveSurface`): a pushed RN screen predates the
runtime restart and cannot be rebuilt in place on the stack. The
`.maestro/verify-more-tab-ios.yaml` flow covers the whole matrix.

### ATS

`Info.plist` sets **`NSAllowsLocalNetworking: true`** so App Transport Security
permits `http://localhost` (the simulator reaches the demo servers directly).

### Metro mode on iOS

No runtime Metro toggle exists on iOS (a Release framework's enabled expo-updates
owns the bundle URL and always beats a host override). Instead install a
Debug-built framework and rebuild the host against it. Normally that is a
download, not a build: `pnpm install:ios --debug` for the release's Debug asset,
or `pnpm install:ios --local --debug` for the `build-debug/` mirror a previous
`package-ios.sh` run left behind; `./scripts/package-ios.sh --configuration Debug`
builds one from source. What makes Metro mode work is the `#if DEBUG`
`bundleURLOverride` -> `:8081` the plugin injects (a Debug build also leaves
expo-updates in its disabled state, so nothing competes for the bundle URL). See
[development-workflow.md](./development-workflow.md).

---

## Host app icon and splash screen

Both hosts brand themselves from the Expo app's assets in
`apps/mobile/assets/images/`, so the host and the RN app it embeds look like one
product. The assets are **copied and pre-scaled into each host**, not referenced
across the repo -- an iOS asset catalog can only contain files inside itself, and
Android needs density buckets. Regenerate them (with ImageMagick) if the Expo
assets change.

> The current Expo assets are placeholders: `icon.png` and
> `android-icon-background.png` are a flat `#208AEF`, and `splash-icon.png` and
> `android-icon-foreground.png` are flat white. There is no artwork in any of
> them. See the Android caveat below.

### iOS

Missing icons are what fails App Store upload validation: *"Missing Info.plist
value. A value for the Info.plist key 'CFBundleIconName' is missing."* That key
is emitted by `actool`, not written by hand, so it appears only when the target
has an asset catalog with an app icon set and `ASSETCATALOG_COMPILER_APPICON_NAME`
pointing at it (set explicitly in `project.yml`).

| Path | Source |
| --- | --- |
| `OtaHost/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` | `icon.png`, alpha stripped |
| `OtaHost/Assets.xcassets/SplashBackground.colorset` | `#208AEF` |

**The app icon must not have an alpha channel at all.** Apple rejects it even
when the channel is fully opaque, which the Expo `icon.png` is -- hence the
`-alpha remove -alpha off` flatten:

```
magick apps/mobile/assets/images/icon.png -background '#208AEF' \
  -alpha remove -alpha off -colorspace sRGB -strip \
  PNG24:hosts/ios/OtaHost/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
```

A single 1024x1024 `universal`/`ios` entry is enough; Xcode derives every other
size. The launch screen is `UILaunchScreen` -> `UIColorName: SplashBackground`,
matching Expo's iOS splash, which is a plain background colour -- `app.json`
configures an `expo-splash-screen` image only under `android`.

Verify a build with:

```
plutil -p <built>.app/Info.plist | grep -i "icon\|launch"
```

`CFBundleIconName` appears nested under `CFBundleIcons.CFBundlePrimaryIcon`, not
at the top level. That is what Apple checks.

### Android

| Path | Source |
| --- | --- |
| `res/mipmap-*/ic_launcher.png`, `ic_launcher_round.png` (48dp) | `icon.png` |
| `res/mipmap-*/ic_launcher_foreground.png`, `ic_launcher_monochrome.png` (108dp) | the matching `android-icon-*.png` |
| `res/drawable-*/splashscreen_logo_image.png` (76dp) | `splash-icon.png` |
| `res/values/colors.xml` | `#208AEF`, from `app.json` |

`mipmap-anydpi-v26/ic_launcher.xml` uses a **colour** for the adaptive icon's
background rather than density-scaled copies of `android-icon-background.png`,
because that source is a single uniform colour and renders identically.

The splash is the platform one (`android:windowSplashScreenBackground` /
`windowSplashScreenAnimatedIcon` in `values-v31/themes.xml`), which Android shows
automatically on cold start from the launch activity's theme -- no manifest or
Activity change, and no *new* dependency (`androidx.core:core-splashscreen` 1.2.0
already arrives transitively with the AAR, so a pre-31 splash is possible if
wanted; the host simply does not use it).
`drawable/splashscreen_logo.xml` wraps the bitmap in a transparent 288dp layer so
the logo lands at the 76dp `imageWidth` from `app.json`; the platform scales the
whole drawable to its icon slot, so a bare bitmap would ignore that size.
**There is no splash below API 31** (those attributes are API 31+, and the
pre-31 equivalent needs a `windowBackground` swap in `onCreate`).

The colour is `@color/host_splashscreen_background`, deliberately host-prefixed:
the AAR already declares a `splashscreen_background` (`#FFFFFF`, from
expo-splash-screen), and app resources beat library resources in the merge, so
reusing that name would silently redefine it for the RN side too.

> **Caveat -- the placeholder assets render as white:**
> `android-icon-foreground.png` is an opaque, full-bleed white square, so the
> adaptive icon renders as a **featureless white circle** -- the foreground
> completely hides the blue background. The same applies to the `<monochrome>`
> layer (byte-identical to the foreground, because the two Expo sources are
> identical) and to the splash logo, which is a white square on the blue
> background. All of this is a faithful rendering of the `expo.android`
> config, not a packaging bug. To get the blue icon that iOS shows, point
> `<foreground>` at a real logo, or drop `mipmap-anydpi-v26/` so launchers fall
> back to the legacy `ic_launcher.png` (which is correctly blue).

---

## Host integration recipe -- Android

The host is `hosts/android`, a standalone Gradle project mirroring the generated
project (Gradle 8.14.4, compileSdk 36, minSdk 24, JDK 17).

### `app/build.gradle.kts`

- `namespace` (`dev.otagateway.host`) is intentionally **not** the same as
  `applicationId` (`com.regalcinemas.reactnativetest`). `namespace` only decides
  which package `R` and `BuildConfig` are generated into, and the host's Kotlin
  sources live in `dev.otagateway.host` -- keeping the two aligned is what lets
  those sources use unqualified `R.` and the manifest use relative names
  (`.RNHostActivity`). `applicationId` is the device/store identity and the id
  Maestro flows and `adb` target. Renaming `namespace` means moving every Kotlin
  file; renaming `applicationId` means updating every consumer pinned by the
  drift guard (see the iOS recipe's note on the host app id).
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
    ReactNativeDevHostManager.initialize(this)                       // Metro mode
} else {
    ReactNativeHostManager.initialize(this, envFromPrefs(this), null) // Shipping mode
}
// then install the reload handler (below)
```

Only the Shipping-mode path (`ReactNativeHostManager.initialize`) publishes the
selected environment to the `host-environment` native module
(`HostEnvironment.configure`). Metro mode leaves `HostEnvironment.current` unset,
so under Metro the JS falls back toward the production API gateway regardless of
the environment radio -- the radio is effectively an **OTA / Shipping-mode
control**. (Metro owns the bundle in Metro mode; wiring the radio in would mean
calling `HostEnvironment.configure` from `ReactNativeDevHostManager` too.)

### `ReactNativeDevHostManager.kt` (Metro mode)

Mirrors the generated `ReactNativeHostManager` but points RN at Metro:
`ExpoReactHostFactory.getDefaultReactHost(useDevSupport = true)` plus
`ReactNativeBrownfield.initialize(...)`. This is what the "Use Metro dev server"
toggle selects; the runtime toggle works on Android because bundle resolution
honors `useDevSupport` at runtime (no iOS-style constraint).

### `BrownfieldMessageDispatcher.kt` (the single bridge listener)

ONE `onMessage` listener parses every RN -> native message into a sealed
`BrownfieldMessage` and dispatches: `reload` ->
`BrownfieldReloadHandler.onReload()` (which calls
`UpdatesController.instance.relaunchReactApplicationForModule()`; Android
needs no `BrownfieldReloader` equivalent -- relaunching the RN root is
enough), `saveState` -> `HostStateStore.write`, `navigate` ->
`HostNavigationHandler.open`. Handlers hold no listeners and never re-parse.
This mirrors iOS's `BrownfieldBootstrap.parseMessage` + switch and is the
prerequisite for request/response correlation on the bridge (a future
navigate-with-result envelope needs exactly one correlation point). Unknown
and malformed messages are ignored on both platforms -- the skew guarantee
(see [version-skew.md](./version-skew.md)).

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

### More tab -- pushed native/RN screens

The fourth tab, **More**, is NATIVE (`HostRoute.MORE`, `path == null`): the
shell mounts the Test menu instead of an RN fragment, and the rows PUSH
dedicated activities -- the per-activity hosting pattern the product hosts
landed on for pushed RN screens:

- **Test 1 / Test 2** push `RNScreenActivity` (`/test-one`, `/test-two`): a
  toolbar with title + back arrow above a `ReactNativeFragment`
  (`PushedScreenShell`), `singleTop` to absorb double taps, native slide
  transitions (`Theme.OtaHost.Pushed`). The toolbar arrow routes through the
  OnBackPressedDispatcher -- the same path as hardware Back -- so the
  brownfield callback offers the press to RN JS first and an RN-internal push
  (Test 1 -> Test 2) pops before the activity finishes.
- **Test 3** pushes the fully native `NativeTestActivity` with the same chrome;
  its button pushes RN Test 1 on top (native -> RN mixing on one back stack).

**Per-activity hosting is load-bearing, not just presentation.** Callstack's
`ReactNativeFragment.createView` registers an Activity-scoped
`OnBackPressedCallback` with no fragment lifecycle owner. Hosting RN screens as
fragments swapped inside a SHARED activity therefore leaks callbacks across
visits -- the second visit's Back goes dead (the product repos shipped a
package patch for exactly this before rehosting per-activity). A dedicated
activity per RN surface gives every visit a fresh dispatcher and the leak
cannot manifest; the double-visit case is pinned by
`.maestro/verify-more-tab-android.yaml`. If an RN screen is ever
fragment-hosted in a shared activity again, that upstream bug returns --
re-apply a package patch or fix it upstream first.

While More is selected the shell mounts NO RN fragment, so a pushed Test
screen is the only live RN surface, matching iOS.

Unlike iOS (which pops to root on an OTA rebuild), Android needs no special
handling for a pushed `RNScreenActivity` during an OTA reload:
`BrownfieldReloadHandler` relaunches the shared `ReactHost` in place, so a
pushed RN fragment re-renders on the live runtime where it stands.

## Persisted component state (the host-state seam)

Brownfield hosts tear an RN surface down whenever it is dismissed, so in-JS
component state dies with it. The host-state seam round-trips state through
the HOST's native store using the brownfield library's two native channels:

- **RN -> native:** a component checkpoints its slice with
  `checkpointHostState(key, state)` (`src/brownfield/host-state.ts`), which
  posts `{ "type": "saveState", "key": ..., "state": {...} }` over the message
  bridge. The hosts persist each slice -- `HostStateStore.kt`
  (SharedPreferences, registered in `OtaHostApplication`) and
  `HostStateStore.swift` (UserDefaults, routed via `BrownfieldBootstrap`).
- **Native -> RN:** every mounted RN surface (shell tabs AND pushed screens)
  receives the whole store as the `savedStateJson` initial property; the
  brownfield entry hands it to `hydrateHostSavedState` before the first screen
  renders, and components read their slice back with `readHostSavedState`.

Checkpoints are GUARDED at the JS enforcement point (`checkpointHostState`):
slices carrying secret-shaped key/field names (token, password, card, ...)
are refused with a warning -- the store and the `savedStateJson` channel are
not secret-grade storage -- and slices over 16KB are refused (persist an id
and refetch instead). The native writers mirror the size cap.

The fidget spinner is the reference user: it checkpoints `{angle, velocity}`
on a 400ms interval while in motion (continuous, NOT an unmount hook -- a
teardown or force-stop can outrun a final post) and a fresh mount resumes the
decay from the saved values. Time is frozen while dismissed: switching tabs --
or killing the process -- and returning finds the spinner coasting exactly
where it was. `.maestro/verify-spinner-persistence-{ios,android}.yaml` pin
both the tab-roundtrip and process-death resumes. The pushed Test 1 screen's
counter uses the same seam from a pushed surface (reset row included so the
flows stay idempotent).

**Per-tab navigation restoration** rides the same seam: tab mounts pass
`restoreNavState: true` (pushed screens deliberately do not), the root
layout's `NavStateGuard` checkpoints the surface's current path (slice
`nav:<initialUrl>`, 30-minute TTL), and the brownfield entry mounts at the
saved path instead of `initialUrl` (`src/brownfield/nav-restore.ts`). This
softens freshRouteContext's reset-to-initialUrl trade-off for tabs holding
deep in-surface navigation; only the PATH is restored (expo-router rebuilds
the stack from the URL). `.maestro/verify-nav-restore-{ios,android}.yaml`
pin the roundtrip.

## RN -> native navigation (the navigate seam)

The reverse of the More tab pushing RN screens: an RN screen can ask the HOST
to open a native screen by posting
`{ "type": "navigate", "destination": <name> }` over the message bridge
(Test 2's "Open native Settings" button). `HostNavigationHandler.kt` starts
the matching activity (application context + `FLAG_ACTIVITY_NEW_TASK`);
`BrownfieldBootstrap.swift` presents the matching view controller modally over
whatever is frontmost, pushed RN surfaces included. Only known destinations
launch; anything else is ignored (the bridge is untrusted input), and a
double-tapped button is deduped on both platforms (the settings activity is
`singleTop`; iOS skips the present while anything is already presented). The
More-tab Maestro flows cover the roundtrip: RN button -> native Settings ->
dismiss -> the same still-mounted RN screen.

### Cleartext networking

`res/xml/network_security_config.xml` must permit **cleartext for `localhost`,
`127.0.0.1`, and `10.0.2.2`** (API 28+ blocks `http` by default; without it OTA
against the local servers silently fails). `DebugPrefs.kt` holds the pref
accessors.

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
  on-device-proven combination as the source repo.) What those pins currently are,
  and which of our workarounds a bump could retire, is in
  [Relationship to upstream](#relationship-to-upstream).
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
  hosts, the runtime modes and the artifact-source axis.
- [version-skew.md](./version-skew.md) -- how the bridge/state contracts must
  tolerate a JS bundle and host binary at different versions.
