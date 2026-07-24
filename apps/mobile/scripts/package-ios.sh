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
#
# Usage:
#   ./scripts/package-ios.sh [--configuration Release|Debug]

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

CONFIGURATION="Release"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --configuration) CONFIGURATION="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

PACKAGE_DIR="$REPO_ROOT/ios/.brownfield/package/build"
EXPO_PLIST="$REPO_ROOT/ios/otagatewayapp/Supporting/Expo.plist"

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
BUILD_PRODUCTS="$REPO_ROOT/ios/.brownfield/build/Build/Products"
DSYM_OUT="$PACKAGE_DIR/dSYMs"
rm -rf "$DSYM_OUT"
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

echo ""
echo "==> Package complete. Artifacts at:"
ls -1 "$PACKAGE_DIR"
