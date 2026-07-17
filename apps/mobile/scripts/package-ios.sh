#!/bin/bash
# package-ios.sh
#
# Builds the iOS brownfield artifacts by delegating to the official
# @callstack/brownfield-cli `package:ios` command, then copies Expo.plist.
#
# The CLI handles everything that matters: running expo prebuild (which applies
# our declarative config -- expo-build-properties for static frameworks +
# build-RN-from-source, and ./plugins/withBrownfieldUpdates.js for the
# initializeUpdates() entry point), pod install, building device + simulator,
# merging into XCFrameworks, stripping ReactBrownfield to interface-only, and
# copying hermesvm.xcframework.
#
# On top of the CLI this script adds: an App Store versioning gate (the
# packaged framework must carry CFBundleShortVersionString matching app.json's
# expo.version -- ITMS-90057), the Expo.plist copy (expo-updates config the
# host app needs), and dSYM harvesting.
#
# Output directory: ios/.brownfield/package/build/
#   - OtaGatewayLib.xcframework
#   - ReactBrownfield.xcframework  (interface-only -- binary stripped)
#   - hermesvm.xcframework
#   - Expo.plist
#   - dSYMs/<config>-iphoneos|iphonesimulator/*.framework.dSYM  (debug symbols)
#   - .build-info.json  (configuration + version + HEAD sha)
#
# A Debug build is additionally mirrored (frameworks + Expo.plist + Debug dSYMs) to
# ios/.brownfield/package/build-debug/. This preserves the Metro-enabled
# OtaGatewayLib.xcframework before a subsequent Release build overwrites the
# CLI's hardcoded build/ output directory.
#
# Usage:
#   ./scripts/package-ios.sh                          # Both: Debug, then Release
#   ./scripts/package-ios.sh --configuration Both     # same as no argument
#   ./scripts/package-ios.sh --configuration Debug    # Debug only  -> build/ + build-debug/
#   ./scripts/package-ios.sh --configuration Release  # Release only -> build/
#
# The default builds BOTH variants back to back so cutting a release is one
# command. Debug runs FIRST on purpose: the brownfield CLI hardcodes build/ as
# its output, so the Debug tree is mirrored to build-debug/ before the Release
# build overwrites build/. Reversing the order would leave build/ holding Debug
# frameworks, and create-release.mjs would publish them as the Release asset.
#
# Expect roughly double a single build's wall clock. Pin --configuration Release
# for anything that only needs the shippable artifact (see
# .github/workflows/ios-framework-verify.yml).
#
# If the Release pass of a Both run fails, build/ is left holding the DEBUG
# frameworks with no stamp (each pass invalidates the stamp before building).
# Release cuts stay blocked by the missing stamp, but a host rebuilt from that
# tree comes up in Metro mode -- rerun the script before drawing conclusions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Framework releases ALWAYS bake the production gateway (app.config.ts reads
# this during the CLI's internal `expo prebuild`). The baked value is only the
# fallback for launches where no host environment reaches JS -- the host's
# live selection (modules/host-environment) wins at runtime -- and that
# fallback must never point real users at dev. Overrides from the caller's
# shell are deliberately clobbered.
export OTA_ENVIRONMENT=production
unset OTA_GATEWAY_URL

CONFIGURATION="Both"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --configuration)
      CONFIGURATION="${2:-}"
      case "$CONFIGURATION" in
        Release|Debug|Both) ;;
        *) echo "ERROR: --configuration must be Release, Debug or Both (got '${CONFIGURATION}')"; exit 1 ;;
      esac
      shift 2
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Build both variants by re-running this script once per configuration. Re-exec
# rather than looping in-process so each pass gets the same fresh state a
# standalone run would (stamp invalidation, the CLI's own prebuild, and the
# versioning gate all run per configuration), and so `set -e` aborts the whole
# cut when the first pass fails instead of leaving half of it publishable.
# Debug MUST run first -- see the ordering note in the header.
if [ "$CONFIGURATION" = "Both" ]; then
  echo "==> Packaging BOTH configurations (Debug, then Release)"
  echo ""
  echo "########## 1/2: Debug (Metro mode asset) ##########"
  "$0" --configuration Debug
  echo ""
  echo "########## 2/2: Release (Shipping mode / OTA asset) ##########"
  "$0" --configuration Release
  echo ""
  echo "==> Both configurations packaged."
  echo "    Debug   -> ios/.brownfield/package/build-debug/"
  echo "    Release -> ios/.brownfield/package/build/"
  exit 0
fi

PACKAGE_DIR="$REPO_ROOT/ios/.brownfield/package/build"
DEBUG_MIRROR_DIR="$REPO_ROOT/ios/.brownfield/package/build-debug"
EXPO_PLIST="$REPO_ROOT/ios/otagatewayapp/Supporting/Expo.plist"

# Invalidate the previous build's markers before building. The brownfield CLI
# merges into build/ without cleaning it, so an interrupted build must not leave
# fresh frameworks under a previous successful build's stamp. A Debug build
# also removes its mirror up front so a failed build cannot leave stale
# publishable artifacts.
#
# .install-info.json must go too: scripts/install-ios-frameworks.mjs writes it
# into this same directory, and create-release.mjs refuses to publish any tree
# carrying it (verifyNotInstalled). Left behind, it would survive this rebuild
# and fail the next release cut with "rebuild before cutting" -- pointing at the
# rebuild that just ran. These frameworks are built here, so the marker is
# stale by definition.
rm -f "$PACKAGE_DIR/.build-info.json" "$PACKAGE_DIR/.install-info.json"
if [ "$CONFIGURATION" = "Debug" ]; then
  rm -rf "$DEBUG_MIRROR_DIR"
fi

# Route React Native's build-from-source C/C++/ObjC compiles through ccache to
# make repeat builds dramatically faster. app.json (expo-build-properties
# ios.ccacheEnabled) makes the Podfile set CC/CXX to RN's ccache-clang.sh
# wrappers, but those wrappers run `exec $CCACHE_BINARY clang ...` and Xcode does
# NOT propagate the CCACHE_BINARY *build setting* into the compiler subprocess --
# it must be a real environment variable. So export it here when ccache exists.
if command -v ccache >/dev/null 2>&1; then
  export CCACHE_BINARY="$(command -v ccache)"
  echo "==> ccache enabled: $CCACHE_BINARY"
else
  echo "==> ccache not found (brew install ccache) -- building without compile cache"
fi

# -- Build + package via the official CLI --
# --extra-params xcodebuild settings:
# - DEBUG_INFORMATION_FORMAT=dwarf-with-dsym forces the per-slice builds to emit
#   a standalone OtaGatewayLib.framework.dSYM (Release already defaults to this;
#   the brownfield template builds Debug as plain `dwarf`, whose DWARF is embedded
#   in the binary and references build-machine .o paths -- useless once the
#   framework is consumed on another machine/checkout). A relocatable dSYM is what
#   lets LLDB step into expo-module source in the host app.
# - DYLIB_INSTALL_NAME_BASE=@rpath makes the OtaGatewayLib framework's install
#   name @rpath/OtaGatewayLib.framework/OtaGatewayLib. Without it the framework
#   target inherits Xcode's default INSTALL_PATH=/Library/Frameworks and bakes an
#   ABSOLUTE install name, so a host that Embed & Signs the framework (reached via
#   its @executable_path/Frameworks rpath) crashes at launch with a dyld "Library
#   not loaded: /Library/Frameworks/OtaGatewayLib.framework/..." error. Setting it
#   at build time keeps the code signature valid -- a post-build install_name_tool
#   fixup would invalidate the signature (CODESIGNING "Invalid Page" crash).
#   Harmless for the CLI's prebuilt hermesvm/ReactBrownfield (not rebuilt here).
#
# Deliberately NOT passed: CODE_SIGNING_ALLOWED=NO. See docs/brownfield.md
# ("Framework packaging keeps code signing enabled") -- packaging unsigned would
# let a machine without an "Apple Development" certificate build the device slice,
# but this repo has not verified that against the SecureStore/OTA-persistence
# footgun an unsigned build causes on the host side, so the flag stays off.
#
# Resolve the brownfield CLI via pnpm so it works in the hoisted pnpm workspace
# (the binary is symlinked into the workspace-ROOT node_modules/.bin, not
# apps/mobile/node_modules/.bin). Mirrors the Android publish flow, which also
# uses `pnpm exec brownfield`.
echo "==> Running 'brownfield package:ios' ($CONFIGURATION) ..."
pnpm exec brownfield package:ios \
  --scheme OtaGatewayLib \
  --configuration "$CONFIGURATION" \
  --extra-params "DEBUG_INFORMATION_FORMAT=dwarf-with-dsym DYLIB_INSTALL_NAME_BASE=@rpath"

# -- Verify framework versioning (App Store gate) --
# The packaged framework must carry CFBundleShortVersionString matching
# app.json's expo.version, or App Store uploads of a host IPA embedding it
# fail (ITMS-90057). The gate lives in its own script so the unit suite can
# exercise its failure branches against fixture plists (see
# scripts/__tests__/verify-ios-framework-version.test.ts). When the node read
# fails, EXPECTED_VERSION is empty and the gate degrades to presence-only --
# near-unreachable in practice since the CLI package step above requires node.
EXPECTED_VERSION="$(node -p "require('$REPO_ROOT/app.json').expo.version" 2>/dev/null || true)"
echo ""
"$SCRIPT_DIR/verify-ios-framework-version.sh" "$PACKAGE_DIR" "$EXPECTED_VERSION"

# -- Copy Expo.plist (expo-updates config for the host app) --
# Generated by the expo-updates plugin during prebuild; the CLI does not copy it.
if [ ! -f "$EXPO_PLIST" ]; then
  echo ""
  echo "WARNING: Expo.plist not found at $EXPO_PLIST"
  echo "OTA updates will not work in the host app without this file."
else
  echo ""
  echo "==> Copying Expo.plist (expo-updates config) ..."
  cp "$EXPO_PLIST" "$PACKAGE_DIR/Expo.plist"
  echo "  Copied Expo.plist"
fi

# -- Harvest debug symbols (dSYMs) for host-app native debugging --
# The CLI's `-create-xcframework` step does NOT embed dSYMs, but each per-slice
# build still emits *.framework.dSYM next to its .framework in the derived-data
# Products dir. Copy them into the package output so the host can pick them up and
# LLDB can symbolicate + step into expo-module Swift/C++ source. Kept per-slice
# because device and simulator dSYMs share the same bundle name but have different
# UUIDs. The non-recursive glob harvests only the slice-root
# OtaGatewayLib.framework.dSYM (which statically links all Expo modules);
# ReactBrownfield/hermes dSYMs are nested and intentionally skipped
# (interface-only / prebuilt).
#
# Only THIS configuration's slice directories are cleared, not the whole dSYMs/
# tree: the slice names carry the configuration ("Debug-iphoneos" vs
# "Release-iphoneos"), and a bare package-ios.sh runs both passes into the same
# build/. Clearing dSYMs/ wholesale made the Release pass delete the Debug
# symbols moments after harvesting them, leaving Metro mode -- the mode you are
# in because you are iterating -- with no symbols at all.
BUILD_PRODUCTS="$REPO_ROOT/ios/.brownfield/build/Build/Products"
DSYM_OUT="$PACKAGE_DIR/dSYMs"
rm -rf "$DSYM_OUT/$CONFIGURATION-iphoneos" "$DSYM_OUT/$CONFIGURATION-iphonesimulator"
dsym_found=false
for slice in "$CONFIGURATION-iphoneos" "$CONFIGURATION-iphonesimulator"; do
  for dsym in "$BUILD_PRODUCTS/$slice"/*.framework.dSYM; do
    # No match leaves the glob literal; skip it.
    [ -e "$dsym" ] || continue
    mkdir -p "$DSYM_OUT/$slice"
    cp -R "$dsym" "$DSYM_OUT/$slice/"
    dsym_found=true
  done
done
echo ""
if [ "$dsym_found" = true ]; then
  echo "==> Copied debug symbols to $DSYM_OUT"
else
  echo "WARNING: no *.framework.dSYM found under $BUILD_PRODUCTS"
  echo "Host-app native debugging of expo-modules code will be limited."
fi

# -- Stamp build info (configuration + version + HEAD sha) --
# The stamp lets release tooling reject a wrong-configuration or stale package.
# It is written only after the package, version gate, Expo.plist copy, and dSYM
# harvest have completed successfully.
FULL_VERSION="$(node -p "require('$REPO_ROOT/app.json').expo.version")"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
node -e "
  const { writeFileSync } = require('node:fs');
  writeFileSync(process.argv[1], JSON.stringify({
    configuration: process.argv[2],
    version: process.argv[3],
    headSha: process.argv[4],
    builtAt: new Date().toISOString(),
  }, null, 2) + '\n');
" "$PACKAGE_DIR/.build-info.json" "$CONFIGURATION" "$FULL_VERSION" "$HEAD_SHA"

# -- Mirror a Debug build to build-debug/ --
# Frameworks + Expo.plist + the Debug dSYMs + the stamp. The dSYMs ride along so
# that installing this mirror (install-ios-frameworks.mjs --local --debug) leaves
# Metro mode able to step into native expo-module code; create-release.mjs stages
# them out of the published asset, so carrying them here costs disk only. Copy
# the stamp last so an interrupted mirror is rejected as incomplete.
if [ "$CONFIGURATION" = "Debug" ]; then
  echo ""
  echo "==> Mirroring Debug artifacts to $DEBUG_MIRROR_DIR ..."
  rm -rf "$DEBUG_MIRROR_DIR"
  mkdir -p "$DEBUG_MIRROR_DIR"
  # Keep in step with IOS_FRAMEWORKS in scripts/ios-build-info.mjs, which the
  # installer and the release gate both read (shell cannot import it).
  for fw in OtaGatewayLib.xcframework ReactBrownfield.xcframework hermesvm.xcframework; do
    ditto "$PACKAGE_DIR/$fw" "$DEBUG_MIRROR_DIR/$fw"
  done
  if [ -f "$PACKAGE_DIR/Expo.plist" ]; then
    cp "$PACKAGE_DIR/Expo.plist" "$DEBUG_MIRROR_DIR/Expo.plist"
  fi
  for dsym_slice in "Debug-iphoneos" "Debug-iphonesimulator"; do
    if [ -d "$DSYM_OUT/$dsym_slice" ]; then
      ditto "$DSYM_OUT/$dsym_slice" "$DEBUG_MIRROR_DIR/dSYMs/$dsym_slice"
    fi
  done
  cp "$PACKAGE_DIR/.build-info.json" "$DEBUG_MIRROR_DIR/.build-info.json"
fi

echo ""
echo "==> Package complete. Artifacts at:"
ls -1A "$PACKAGE_DIR"
