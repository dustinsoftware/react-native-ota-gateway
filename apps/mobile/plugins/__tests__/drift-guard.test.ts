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
 * host sources, the Android host's AAR coordinate, the gateway image's pinned
 * server dependencies, and the commands the docs and skills tell people to run.
 * A rename in one place that misses another builds green but breaks at runtime
 * (wrong framework path, missing plist key, unresolved AAR) or at the keyboard
 * (a documented command that no longer exists). This suite pins them together so
 * such a drift fails in `pnpm test`.
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
  // Pushed from the More tab's Test 1 / Test 2 rows (not shell tabs).
  { path: '/test-one', file: 'src/app/test-one.tsx' },
  { path: '/test-two', file: 'src/app/test-two.tsx' },
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

function sourcesUnder(dir: string, extensions: string[]): string {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => extensions.some((ext) => f.endsWith(ext)))
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

describe('brownfield message contract literals match across the three layers', () => {
  // The message bridge couples JS, iOS, and Android by bare string literals
  // (message `type`s, the navigate destination, and the savedStateJson
  // initial-property key). A rename on one side builds green everywhere and
  // the other layers simply stop matching at runtime -- the spinner silently
  // stops persisting, or navigate goes dead. Pin each literal to all three.
  const CONTRACT_LITERALS = ['saveState', 'navigate', 'settings', 'savedStateJson', 'restoreNavState', 'reload'] as const;

  function layerSources(): Array<[string, string]> {
    return [
      ['JS', sourcesUnder(path.join(APP_ROOT, 'src'), ['.ts', '.tsx'])],
      ['iOS', sourcesUnder(path.join(REPO_ROOT, 'hosts', 'ios', 'OtaHost'), ['.swift'])],
      [
        'Android',
        sourcesUnder(
          path.join(REPO_ROOT, 'hosts', 'android', 'app', 'src', 'main', 'java'),
          ['.kt'],
        ),
      ],
    ];
  }

  it.each(CONTRACT_LITERALS)('"%s" appears in JS, iOS, and Android sources', (literal) => {
    // Native layers must carry the QUOTED literal (a comment mention cannot
    // satisfy the pin). The JS side also accepts a property access/declaration
    // (`props.savedStateJson`, `savedStateJson?:`) -- initial-property keys are
    // identifiers there, never string literals.
    const quoted = new RegExp(`['"]${literal}['"]`);
    const jsUsage = new RegExp(`['".]${literal}\\b|${literal}\\?:`);
    for (const [layer, sources] of layerSources()) {
      const pattern = layer === 'JS' ? jsUsage : quoted;
      expect(
        pattern.test(sources),
        `"${literal}" missing from the ${layer} layer`,
      ).toBe(true);
    }
  });
});

describe('Maestro flows reference selectors that exist in the sources', () => {
  // The .maestro flows are the only automated coverage for the host shells'
  // More tab, and their id selectors couple to RN testIDs and native
  // accessibility identifiers by string literal -- exactly the cross-layer
  // drift this suite exists to catch. A renamed testID builds green and only
  // fails on-device; this pins each id to some source literal at PR time.
  const MAESTRO_DIR = path.join(REPO_ROOT, '.maestro');

  const flows = readdirSync(MAESTRO_DIR).filter((f) => f.endsWith('.yaml'));

  it.each(flows)('every id selector in %s exists in a source file', (flow) => {
    const yaml = readFileSync(path.join(MAESTRO_DIR, flow), 'utf8');
    const ids = [...yaml.matchAll(/^\s*id: "([^"]+)"\s*$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);

    const haystack = [
      sourcesUnder(path.join(APP_ROOT, 'src'), ['.tsx', '.ts']),
      sourcesUnder(path.join(REPO_ROOT, 'hosts', 'ios', 'OtaHost'), ['.swift']),
      sourcesUnder(
        path.join(REPO_ROOT, 'hosts', 'android', 'app', 'src', 'main'),
        ['.kt', '.xml'],
      ),
    ].join('\n');

    for (const id of ids) {
      if (id.startsWith('tab-')) {
        // The iOS shell computes tab ids as "tab-" + HostTab title lowercased
        // (HostShellViewController), so the id is not a source literal; pin
        // the title it derives from instead.
        const title = id.slice('tab-'.length);
        const capitalized = title.charAt(0).toUpperCase() + title.slice(1);
        expect(haystack, `HostTab title for maestro id "${id}"`).toContain(
          `return "${capitalized}"`,
        );
        continue;
      }
      expect(haystack, `maestro id "${id}" must exist in a source file`).toContain(`"${id}"`);
    }
  });
});

describe('Host app id is identical everywhere it is launched by id', () => {
  // The host app id couples the two host build files to every Maestro flow and
  // to the verify-ios skill's simctl commands. A partial rename builds green on
  // both platforms and fails only when someone runs a flow by hand -- and
  // verify-rotation-android-part2.yaml has no launchApp, so its appId is never
  // validated at runtime at all. Pin them all to project.yml.
  const projectYml = readFileSync(
    path.join(REPO_ROOT, 'hosts', 'ios', 'project.yml'),
    'utf8',
  );
  const iosAppId = /^\s*PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)\s*$/m.exec(projectYml)?.[1];

  it('project.yml declares a PRODUCT_BUNDLE_IDENTIFIER', () => {
    expect(iosAppId, 'PRODUCT_BUNDLE_IDENTIFIER not found in hosts/ios/project.yml').toBeTruthy();
  });

  it("Android applicationId matches the iOS bundle id", () => {
    const gradle = readFileSync(
      path.join(REPO_ROOT, 'hosts', 'android', 'app', 'build.gradle.kts'),
      'utf8',
    );
    const androidAppId = /^\s*applicationId\s*=\s*"([^"]+)"\s*$/m.exec(gradle)?.[1];
    expect(androidAppId).toBe(iosAppId);
  });

  const flows = readdirSync(path.join(REPO_ROOT, '.maestro')).filter((f) =>
    f.endsWith('.yaml'),
  );

  it.each(flows)('%s targets the host app id', (flow) => {
    const yaml = readFileSync(path.join(REPO_ROOT, '.maestro', flow), 'utf8');
    const appIds = [...yaml.matchAll(/^appId:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    expect(appIds, `no appId in ${flow}`).not.toHaveLength(0);
    for (const appId of appIds) {
      expect(appId).toBe(iosAppId);
    }
  });

  it('verify-ios skill launches the host app id', () => {
    const skill = readFileSync(
      path.join(REPO_ROOT, '.claude', 'skills', 'verify-ios', 'SKILL.md'),
      'utf8',
    );
    const launches = [...skill.matchAll(/simctl launch\s+\S+\s+(\S+)/g)].map((m) => m[1]);
    expect(launches, 'no simctl launch in verify-ios SKILL.md').not.toHaveLength(0);
    for (const launched of launches) {
      expect(launched).toBe(iosAppId);
    }
  });
});

describe('docs quote the pinned upstream versions', () => {
  /**
   * docs/brownfield.md's "Relationship to upstream" table tells a future reader
   * which of our workarounds a version bump can delete -- and that table is only
   * useful if its pins are the real ones. Nothing else links the prose to
   * package.json, so a bump would silently leave the advice describing a version
   * we no longer use. Same coupling class as the Dockerfile pins below, and the
   * failure message points at the doc line to edit.
   *
   * Only the "Pinned here" column is checkable offline; the "Latest" column is a
   * point-in-time observation of npm, which the section marks with a date and a
   * refresh command instead.
   */
  const DOC = path.join(REPO_ROOT, 'docs', 'brownfield.md');
  const PINNED_PACKAGES = [
    '@callstack/react-native-brownfield',
    '@callstack/brownfield-cli',
    'expo',
    'expo-updates',
  ];

  function upstreamSection(): string {
    const text = readFileSync(DOC, 'utf8');
    const heading = '## Relationship to upstream';
    expect(text, `${heading} not found -- the guard has gone vacuous`).toContain(heading);
    return text.split(heading)[1].split('\n## ')[0];
  }

  it.each(PINNED_PACKAGES)('%s is quoted at its package.json version', (name) => {
    const manifest = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    const pinned = { ...manifest.dependencies, ...manifest.devDependencies }[name];
    expect(pinned, `${name} is not a dependency of apps/mobile`).toBeTruthy();

    const row = upstreamSection()
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes(`\`${name}\``));
    expect(row, `no table row in "Relationship to upstream" names ${name}`).toBeTruthy();
    // Cell 2 is "Pinned here"; cell 3 is the (unguardable) upstream latest.
    expect(
      row?.split('|')[2],
      `docs/brownfield.md quotes a stale pin for ${name} (package.json says ${pinned})`,
    ).toContain(`\`${pinned}\``);
  });
});

describe('documented pnpm commands resolve to real scripts', () => {
  /**
   * Renaming a package.json script (or the file it runs) is a cross-layer edit:
   * every doc, skill and runbook that spells the old name keeps looking correct
   * and fails only when someone types it. `download:ios` -> `install:ios` touched
   * ~15 call sites; this pins the next such rename.
   */
  const packageJsonPaths = [
    path.join(REPO_ROOT, 'package.json'),
    path.join(APP_ROOT, 'package.json'),
  ];

  function scriptsOf(packageJsonPath: string): Record<string, string> {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')).scripts ?? {};
  }

  /** Everything that tells a human which command to run. */
  function documentationSources(): string[] {
    return [
      ...readdirSync(path.join(REPO_ROOT, 'docs'))
        .filter((file) => file.endsWith('.md'))
        .map((file) => path.join(REPO_ROOT, 'docs', file)),
      path.join(REPO_ROOT, 'README.md'),
      path.join(REPO_ROOT, '.claude', 'skills', 'verify-ios', 'SKILL.md'),
      path.join(REPO_ROOT, '.claude', 'skills', 'verify-android', 'SKILL.md'),
    ];
  }

  const declared = new Set(
    packageJsonPaths.flatMap((packageJsonPath) => Object.keys(scriptsOf(packageJsonPath))),
  );

  it('every script that runs a repo file points at a file that exists', () => {
    let checked = 0;
    for (const packageJsonPath of packageJsonPaths) {
      const scripts = scriptsOf(packageJsonPath);
      const packageDir = path.dirname(packageJsonPath);
      for (const [name, command] of Object.entries(scripts)) {
        for (const [, target] of command.matchAll(/(?:^|\s)(\.?\/?scripts\/[\w.-]+)/g)) {
          expect(
            existsSync(path.join(packageDir, target)),
            `${packageJsonPath} script "${name}" runs missing file ${target}`,
          ).toBe(true);
          checked += 1;
        }
      }
    }
    // Lower bound: without it, a regex that stops matching turns this guard into
    // a vacuous pass -- the exact silence it exists to prevent.
    expect(checked, 'no script targets matched -- the guard has gone vacuous').
      toBeGreaterThanOrEqual(5);
  });

  it('every scripts/... file named in the docs and skills exists', () => {
    // The other half of a rename: docs name scripts by filename as well as by
    // pnpm script name, and `node scripts/download-ios-frameworks.mjs` would have
    // sailed past the command check below.
    let checked = 0;
    for (const source of documentationSources()) {
      const text = readFileSync(source, 'utf8');
      for (const [, target] of text.matchAll(/(?:^|[\s`(])\.?\/?(scripts\/[\w.-]+\.(?:mjs|sh|cjs))/g)) {
        expect(
          existsSync(path.join(APP_ROOT, target)),
          `${path.basename(source)} references missing ${target}`,
        ).toBe(true);
        checked += 1;
      }
    }
    expect(checked, 'no scripts/... references matched -- the guard has gone vacuous').
      toBeGreaterThanOrEqual(5);
  });

  it('every namespaced `pnpm <name>` in the docs and skills is a declared script', () => {
    // Namespaced (colon) names only: those are always repo scripts, whereas bare
    // `pnpm install` / `pnpm exec` / `pnpm --filter` are pnpm's own subcommands.
    const seen = new Set<string>();
    for (const source of documentationSources()) {
      const text = readFileSync(source, 'utf8');
      const referenced = new Set(
        [...text.matchAll(/pnpm (?:--filter \S+ )?([a-z][\w-]*:[\w:-]+)/g)].map((m) => m[1]),
      );
      for (const name of referenced) {
        expect(
          declared.has(name),
          `${path.basename(source)} documents "pnpm ${name}", which no package.json declares`,
        ).toBe(true);
        seen.add(name);
      }
    }
    expect(seen.size, 'no documented pnpm commands matched -- the guard has gone vacuous').
      toBeGreaterThanOrEqual(4);
  });

  // The root `install:ios` script must invoke the installer directly rather than
  // chaining to another pnpm: a second hop overwrites INIT_CWD with the repo
  // root, and a relative `--local <path>` would then silently resolve against the
  // wrong directory (docs/brownfield.md documents the invocation directory).
  it('the root install:ios script does not add a second pnpm hop', () => {
    const rootScripts = scriptsOf(path.join(REPO_ROOT, 'package.json'));
    expect(rootScripts['install:ios']).toBeDefined();
    expect(rootScripts['install:ios']).not.toMatch(/\bpnpm\b/);
  });
});

describe('Dockerfile server runtime matches package.json', () => {
  // The Shipping-mode gateway image (apps/mobile/Dockerfile) installs the server's
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
