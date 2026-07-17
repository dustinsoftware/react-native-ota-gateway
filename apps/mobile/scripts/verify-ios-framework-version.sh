#!/bin/bash
# verify-ios-framework-version.sh
#
# App Store versioning gate for the packaged brownfield framework. App Store
# uploads reject a host IPA whose embedded framework Info.plist lacks
# CFBundleShortVersionString (ITMS-90057). The value comes from
# MARKETING_VERSION, stamped on the OtaGatewayLib target by app.config.ts from
# app.json's expo.version (the same source as the Android AAR coordinate).
#
# Fails (exit 1) if any OtaGatewayLib.framework slice under <package-dir> is
# missing CFBundleShortVersionString / CFBundleVersion, if no slices are found
# at all, or -- when <expected-version> is given -- if a slice's short version
# does not match it. The value-match matters because the brownfield plugin only
# writes build settings when it CREATES the target, so a stale generated ios/
# dir left over from before a version bump would otherwise ship the OLD
# version and pass a presence-only check.
#
# Standalone (macOS only -- uses PlistBuddy) so scripts/__tests__ can exercise
# the gate against fixture plists without a 1-2h framework build; the
# production caller is scripts/package-ios.sh.
#
# Usage:
#   ./scripts/verify-ios-framework-version.sh <package-dir> [expected-version]

set -euo pipefail

PACKAGE_DIR="${1:?usage: verify-ios-framework-version.sh <package-dir> [expected-version]}"
EXPECTED_VERSION="${2:-}"

echo "==> Verifying OtaGatewayLib Info.plist versioning (expected: ${EXPECTED_VERSION:-unknown}) ..."
slice_found=false
for plist in "$PACKAGE_DIR/OtaGatewayLib.xcframework"/*/OtaGatewayLib.framework/Info.plist; do
  [ -e "$plist" ] || continue
  slice_found=true
  slice="$(basename "$(dirname "$(dirname "$plist")")")"
  for key in CFBundleShortVersionString CFBundleVersion; do
    value="$(/usr/libexec/PlistBuddy -c "Print :$key" "$plist" 2>/dev/null || true)"
    if [ -z "$value" ]; then
      echo "ERROR: $slice Info.plist is missing $key -- App Store uploads of a"
      echo "host app embedding this framework will fail (ITMS-90057). Two known causes:"
      echo "  1. app.json is missing expo.version (app.config.ts stamps"
      echo "     MARKETING_VERSION from it)."
      echo "  2. A stale generated ios/ dir: the brownfield plugin only writes"
      echo "     build settings when it creates the target. Run"
      echo "     'pnpm --filter @ota-gateway/mobile prebuild --ios' (or delete"
      echo "     apps/mobile/ios/) and rerun."
      exit 1
    fi
    echo "  [$slice] $key=$value"
  done
  if [ -n "$EXPECTED_VERSION" ]; then
    short_version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist" 2>/dev/null || true)"
    if [ "$short_version" != "$EXPECTED_VERSION" ]; then
      echo "ERROR: $slice CFBundleShortVersionString is '$short_version' but app.json"
      echo "expo.version is '$EXPECTED_VERSION'. The generated ios/ dir is stale (the"
      echo "brownfield plugin only stamps MARKETING_VERSION when it creates the"
      echo "target). Run 'pnpm --filter @ota-gateway/mobile prebuild --ios' (or"
      echo "delete apps/mobile/ios/) and rerun."
      exit 1
    fi
  fi
done
if [ "$slice_found" = false ]; then
  echo "ERROR: no framework slices found under $PACKAGE_DIR/OtaGatewayLib.xcframework"
  exit 1
fi
