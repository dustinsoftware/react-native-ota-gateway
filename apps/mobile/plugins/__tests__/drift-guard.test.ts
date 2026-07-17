import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ANDROID_MODULE_NAME,
  ANDROID_PACKAGE_PATH,
  IOS_FRAMEWORK_NAME,
  PLIST_KEY_DEV,
  PLIST_KEY_PROD,
} from '../withBrownfieldUpdates.js';
import { MODULE_NAME as PUBLISHING_MODULE_NAME } from '../withBrownfieldAndroidPublishing.js';

/**
 * Cross-layer drift guard. Several couplings in this repo are enforced only by
 * matching string literals across files the compiler never links together: the
 * config plugins' constants, app.json's brownfield plugin config, the native
 * host sources, and the Android host's AAR coordinate. A rename in one place
 * that misses another builds green but breaks at runtime (wrong framework path,
 * missing plist key, unresolved AAR). This suite pins them together so such a
 * drift fails in `pnpm test`.
 */
const APP_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

interface BrownfieldConfig {
  ios?: { frameworkName?: string };
  android?: { moduleName?: string; packageName?: string };
}

const HOST_ROUTES = [
  { path: '/developer', file: 'src/app/(tabs)/developer/index.tsx' },
  { path: '/sky', file: 'src/app/(tabs)/sky.tsx' },
  { path: '/spinner', file: 'src/app/(tabs)/spinner.tsx' },
] as const;

function readAppJson(): {
  version: string;
  brownfield: BrownfieldConfig;
} {
  const appJson = JSON.parse(readFileSync(path.join(APP_ROOT, 'app.json'), 'utf8'));
  const plugins: unknown[] = appJson.expo.plugins;
  const entry = plugins.find(
    (p): p is [string, BrownfieldConfig] =>
      Array.isArray(p) && p[0] === '@callstack/react-native-brownfield',
  );
  if (!entry) {
    throw new Error('app.json is missing the @callstack/react-native-brownfield plugin entry');
  }
  return { version: appJson.expo.version, brownfield: entry[1] };
}

describe('plugin constants match app.json brownfield config', () => {
  const { brownfield } = readAppJson();

  it('iOS framework name matches app.json', () => {
    expect(IOS_FRAMEWORK_NAME).toBe(brownfield.ios?.frameworkName);
  });

  it('Android module name matches app.json (both plugins agree)', () => {
    expect(ANDROID_MODULE_NAME).toBe(brownfield.android?.moduleName);
    expect(PUBLISHING_MODULE_NAME).toBe(brownfield.android?.moduleName);
  });

  it('Android package path is app.json package name with dots as slashes', () => {
    const packageName = brownfield.android?.packageName;
    expect(packageName).toBeTruthy();
    expect(ANDROID_PACKAGE_PATH).toBe((packageName as string).replaceAll('.', '/'));
  });
});

describe('native host sources match the plugin coupling constants', () => {
  function iosHostSources(): string {
    const dir = path.join(REPO_ROOT, 'hosts', 'ios', 'OtaHost');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.swift'))
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
  }

  function androidHostSources(): string {
    const dir = path.join(
      REPO_ROOT,
      'hosts',
      'android',
      'app',
      'src',
      'main',
      'java',
      'dev',
      'otagateway',
      'host',
    );
    return readdirSync(dir)
      .filter((f) => f.endsWith('.kt'))
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
  }

  it('iOS host reads the same Expo.plist keys the plugin writes', () => {
    const sources = iosHostSources();
    // The host's dev-tools reads these keys back; a rename in the plugin that
    // missed the host would leave the host reading a key that no longer exists.
    expect(sources).toContain(PLIST_KEY_DEV);
    expect(sources).toContain(PLIST_KEY_PROD);
  });

  it('Android host declares the AAR coordinate carrying app.json expo.version', () => {
    const { version, brownfield } = readAppJson();
    const groupId = brownfield.android?.packageName;
    const artifactId = brownfield.android?.moduleName;
    // The publishing plugin stamps the AAR as
    // <packageName>:<moduleName>:<expo.version>-SNAPSHOT; the host must consume
    // that exact coordinate or Gradle cannot resolve the brownfield artifact.
    const coordinate = `${groupId}:${artifactId}:${version}-SNAPSHOT`;
    const gradle = readFileSync(
      path.join(REPO_ROOT, 'hosts', 'android', 'app', 'build.gradle.kts'),
      'utf8',
    );
    expect(gradle).toContain(coordinate);
  });

  it.each(HOST_ROUTES)(
    'both native hosts map $path to an existing RN route',
    ({ path: routePath, file }) => {
      expect(iosHostSources()).toContain(`"${routePath}"`);
      expect(androidHostSources()).toContain(`"${routePath}"`);
      expect(existsSync(path.join(APP_ROOT, file))).toBe(true);
    },
  );
});

describe('Dockerfile server runtime matches package.json', () => {
  // The Mode B gateway image (apps/mobile/Dockerfile) installs the server's
  // runtime deps by explicit version instead of reusing the pnpm workspace
  // (the image deliberately excludes the RN/Expo dev tree). Those versions
  // must track package.json, or the container serves a runtime the test suite
  // never exercised. This pins each `name@version` in the Dockerfile's
  // `npm install` block to the exact range declared in package.json.
  const DOCKER_RUNTIME_DEPS = ['express', 'expo-server', 'tsx'] as const;

  it('every npm-installed dependency version matches package.json', () => {
    const dockerfile = readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8');
    const packageJson = JSON.parse(
      readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'),
    );
    const declared: Record<string, string> = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    for (const name of DOCKER_RUNTIME_DEPS) {
      const match = dockerfile.match(new RegExp(`${name}@(\\S+)`));
      expect(match, `Dockerfile must npm-install ${name}@<version>`).toBeTruthy();
      expect(match?.[1], `Dockerfile pin for ${name}`).toBe(declared[name]);
    }
  });
});
