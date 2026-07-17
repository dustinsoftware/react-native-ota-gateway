import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  injectKotlinUpdates,
  injectSwiftUpdates,
} from '../withBrownfieldUpdates.js';
import {
  readExpoUpdatesRuntimeVersions,
  rewriteGradle,
} from '../withBrownfieldAndroidPublishing.js';

/**
 * Unit tests for the config plugins' pure source transforms, run against the
 * REAL @callstack/react-native-brownfield templates in node_modules -- so a
 * brownfield upgrade that drifts a template fails here in `pnpm test`, not
 * only at the next `expo prebuild`. Each transform is checked for: single
 * injection, idempotency (second run returns the input unchanged), and loud
 * failure on a mangled template.
 *
 * The template dir is resolved via createRequire rather than a hardcoded
 * node_modules path: in this pnpm workspace (nodeLinker: hoisted) the package
 * lives in the workspace-root node_modules, not apps/mobile's.
 */
const require = createRequire(path.join(__dirname, 'noop.cjs'));
const TEMPLATE_DIR = path.join(
  path.dirname(require.resolve('@callstack/react-native-brownfield/package.json')),
  'lib',
  'commonjs',
  'expo-config-plugin',
  'template',
);

function template(...segments: string[]): string {
  return readFileSync(path.join(TEMPLATE_DIR, ...segments), 'utf8');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Mirrors the fields buildKotlinInjection reads from the resolved Expo config.
const KOTLIN_CONFIG = {
  runtimeVersion: '1',
  updates: { checkAutomatically: 'ALWAYS', launchWaitMs: 0, useEmbeddedUpdate: false },
  extra: {
    updatesUrls: {
      development: 'https://dev.test.example/api/v2/updates/manifest',
      production: 'https://www.test.example/api/v2/updates/manifest',
    },
  },
};

describe('injectSwiftUpdates (withBrownfieldUpdates)', () => {
  const swiftTemplate = template('ios', 'FrameworkInterface.swift');

  it('injects the entry point and imports exactly once into the real template', () => {
    const out = injectSwiftUpdates(swiftTemplate);
    expect(count(out, 'func initializeUpdates')).toBe(1);
    expect(count(out, 'internal import EXUpdates')).toBe(1);
    // React is needed for RCTBundleURLProvider (the DEBUG Metro bundle override).
    expect(count(out, 'internal import React')).toBe(1);
    expect(count(out, 'internal import ExpoHostEnvironment')).toBe(1);
    // The template already imports Foundation; no duplicate may be added.
    expect(count(out, 'import Foundation')).toBe(1);
    expect(out).toContain('public enum OtaUpdatesEnvironment');
    // Both bundle URL overrides, one per build configuration. The gating is
    // the correctness premise -- Debug must point at Metro (Metro mode), Release
    // must resolve expo-updates' launch asset (in-place OTA Restart boots the
    // downloaded update instead of the embedded bundle) -- so assert each
    // override lives strictly inside its branch of a single #if DEBUG/#else
    // block, not just that they exist somewhere in the output.
    expect(count(out, '#if DEBUG')).toBe(1);
    expect(count(out, 'self.bundleURLOverride =')).toBe(2);
    const debugBlock = out.slice(out.indexOf('#if DEBUG'), out.indexOf('#else'));
    const releaseBlock = out.slice(out.indexOf('#else'), out.indexOf('#endif'));
    expect(debugBlock).toContain('self.bundleURLOverride =');
    expect(debugBlock).toContain('RCTBundleURLProvider.jsBundleURL(');
    expect(releaseBlock).toContain('self.bundleURLOverride =');
    expect(releaseBlock).toContain('AppController.sharedInstance.launchAssetUrl()');
    expect(releaseBlock).not.toContain('RCTBundleURLProvider');
    // The bridge-reload companion that advances the launcher to the newest
    // downloaded update (the host calls it between stop and start). Pin the
    // requestRelaunch call inside the method body, not just anywhere in the
    // output (a doc-comment mention alone must not satisfy this).
    expect(count(out, 'func relaunchUpdates')).toBe(1);
    const relaunchBody = out.slice(out.indexOf('func relaunchUpdates'));
    expect(relaunchBody).toContain('controller.requestRelaunch');
  });

  it('publishes the host environment to the JS layer before starting updates', () => {
    const out = injectSwiftUpdates(swiftTemplate);
    expect(count(out, 'HostEnvironmentRegistry.shared.configure(')).toBe(1);
    // The publication must happen inside initializeUpdates, before the
    // updates controller is touched.
    const entryPoint = out.slice(out.indexOf('func initializeUpdates'));
    expect(entryPoint.indexOf('HostEnvironmentRegistry.shared.configure(')).toBeLessThan(
      entryPoint.indexOf('AppController'),
    );
    // And it must NOT be Debug-gated: Release frameworks (the shipped
    // artifact this seam exists for) must publish the env too.
    expect(out.indexOf('HostEnvironmentRegistry.shared.configure(')).toBeLessThan(
      out.indexOf('#if DEBUG'),
    );
  });

  it('is idempotent', () => {
    const once = injectSwiftUpdates(swiftTemplate);
    expect(injectSwiftUpdates(once)).toBe(once);
  });

  it('fails loudly when the import anchor is missing', () => {
    const mangled = swiftTemplate.replace('import ReactBrownfield\n', '');
    expect(() => injectSwiftUpdates(mangled)).toThrow(/unexpected template shape/);
  });
});

describe.each(['ReactNativeHostManager.post55.kt', 'ReactNativeHostManager.pre55.kt'])(
  'injectKotlinUpdates (withBrownfieldUpdates) against %s',
  (templateFile) => {
    // Render the package placeholder the way the brownfield engine does.
    const kotlinTemplate = template('android', templateFile).replace(
      '{{PACKAGE_NAME}}',
      'dev.otagateway',
    );

    it('injects the enum + entry point and demotes the template initialize', () => {
      const out = injectKotlinUpdates(kotlinTemplate, KOTLIN_CONFIG);
      expect(count(out, 'enum class OtaUpdatesEnvironment')).toBe(1);
      expect(count(out, 'private fun bootReactNative')).toBe(1);
      // Exactly one public initialize remains: the environment-required one.
      expect(count(out, 'fun initialize(')).toBe(1);
      expect(out).toContain('environment: OtaUpdatesEnvironment');
      expect(out).toContain(`DEVELOPMENT("${KOTLIN_CONFIG.extra.updatesUrls.development}")`);
      expect(out).toContain(`PRODUCTION("${KOTLIN_CONFIG.extra.updatesUrls.production}")`);
      expect(count(out, 'import android.net.Uri')).toBe(1);
      expect(count(out, 'import expo.modules.updates.UpdatesController')).toBe(1);
      expect(count(out, 'import expo.modules.hostenvironment.HostEnvironment')).toBe(1);
    });

    it('publishes the host environment to the JS layer before the updates override', () => {
      const out = injectKotlinUpdates(kotlinTemplate, KOTLIN_CONFIG);
      expect(count(out, 'HostEnvironment.configure(')).toBe(1);
      const entryPoint = out.slice(out.indexOf('fun initialize('));
      expect(entryPoint.indexOf('HostEnvironment.configure(')).toBeLessThan(
        entryPoint.indexOf('UpdatesController.overrideConfiguration('),
      );
    });

    it('is idempotent', () => {
      const once = injectKotlinUpdates(kotlinTemplate, KOTLIN_CONFIG);
      expect(injectKotlinUpdates(once, KOTLIN_CONFIG)).toBe(once);
    });

    it('fails loudly when the object declaration is missing', () => {
      const mangled = kotlinTemplate.replace('object ReactNativeHostManager {', 'object Renamed {');
      expect(() => injectKotlinUpdates(mangled, KOTLIN_CONFIG)).toThrow(
        /unexpected template shape/,
      );
    });
  },
);

describe('rewriteGradle (withBrownfieldAndroidPublishing)', () => {
  // Render the template placeholders the way the brownfield engine does; the
  // values only matter for {{ARTIFACT_VERSION}} (the version-stamp anchor).
  const gradleTemplate = Object.entries({
    '{{GROUP_ID}}': 'dev.otagateway',
    '{{ARTIFACT_ID}}': 'otagatewaylib',
    '{{ARTIFACT_VERSION}}': '0.0.1-SNAPSHOT',
    '{{PACKAGE_NAME}}': 'dev.otagateway',
    '{{COMPILE_SDK_VERSION}}': '36',
    '{{MIN_SDK_VERSION}}': '24',
    '{{RN_VERSION}}': '0.83.6',
    '{{HERMES_ARTIFACT}}': 'com.facebook.hermes:hermes-android:0.14.1',
  }).reduce(
    (src, [placeholder, value]) => src.replaceAll(placeholder, value),
    template('android', 'build.gradle.kts'),
  );
  const OPTIONS = {
    aarVersion: '9.9.9-SNAPSHOT',
    brotliVersion: '4.9.2',
    roomVersion: '2.6.1',
    bouncycastleVersion: '1.81',
  };
  const BROTLI_LINE = 'api("com.squareup.okhttp3:okhttp-brotli:4.9.2")';
  const ROOM_RUNTIME_LINE = 'api("androidx.room:room-runtime:2.6.1")';
  const ROOM_KTX_LINE = 'api("androidx.room:room-ktx:2.6.1")';
  const BOUNCYCASTLE_LINE = 'api("org.bouncycastle:bcutil-jdk15to18:1.81")';

  it('applies every rewrite to the real template', () => {
    const out = rewriteGradle(gradleTemplate, OPTIONS);
    expect(count(out, 'singleVariant("release")')).toBe(1);
    expect(out).toContain('from(components.getByName("release"))');
    expect(out).not.toContain('components.getByName("default")');
    expect(out).toContain('excludes += "**/libc++_shared.so"');
    // Native debug symbols are gated behind an opt-in gradle property so the
    // published release AAR stays lean by default. Assert the FULL gate line (not
    // just the property name) so an inverted, dropped, or unconditional gate --
    // the exact regression this feature exists to prevent -- fails the test.
    expect(out).toContain('if (project.findProperty("ota.keepNativeSymbols") == "true") {');
    expect(out).toContain('keepDebugSymbols += "**/*.so"');
    expect(out).toContain('version = "9.9.9-SNAPSHOT"');
    // The expo-updates runtime dependencies re-declared `api` (dropped from the
    // POM otherwise), injected exactly once each into the module dependencies block.
    expect(count(out, BROTLI_LINE)).toBe(1);
    expect(count(out, ROOM_RUNTIME_LINE)).toBe(1);
    expect(count(out, ROOM_KTX_LINE)).toBe(1);
    expect(count(out, BOUNCYCASTLE_LINE)).toBe(1);
    // Brotli is the first injected line, prepended to the dependencies block.
    expect(out).toContain(`dependencies {\n    ${BROTLI_LINE}`);
  });

  it('is idempotent', () => {
    const once = rewriteGradle(gradleTemplate, OPTIONS);
    expect(rewriteGradle(once, OPTIONS)).toBe(once);
  });

  it('fails loudly when a transform anchor is missing', () => {
    const mangled = gradleTemplate.replace('version = "0.0.1-SNAPSHOT"', 'version = "reworked"');
    expect(() => rewriteGradle(mangled, OPTIONS)).toThrow(/Failed to rewrite build.gradle.kts/);
  });
});

describe('readExpoUpdatesRuntimeVersions', () => {
  it('reads semver-shaped versions from the real expo-updates gradle', () => {
    const versions = readExpoUpdatesRuntimeVersions(path.resolve(__dirname, '..', '..'));
    expect(versions.brotli).toMatch(/^\d+(\.\d+)+$/);
    expect(versions.room).toMatch(/^\d+(\.\d+)+$/);
    expect(versions.bouncycastle).toMatch(/^\d+(\.\d+)+$/);
  });

  it('fails loudly when a declaration is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'expo-updates-versions-'));
    try {
      const pkgDir = path.join(dir, 'node_modules', 'expo-updates');
      mkdirSync(path.join(pkgDir, 'android'), { recursive: true });
      // A package.json so require.resolve("expo-updates/package.json") finds it,
      // and a gradle with none of the runtime dependency declarations.
      writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'expo-updates', version: '0.0.0' }),
      );
      writeFileSync(path.join(pkgDir, 'android', 'build.gradle'), 'dependencies {\n}\n');
      expect(() => readExpoUpdatesRuntimeVersions(dir)).toThrow(/okhttp-brotli version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
