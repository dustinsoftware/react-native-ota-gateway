import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEBUG_MIRROR,
  DESTINATION,
  describeContainment,
  describeIncompleteInstall,
  installFromRelease,
  installLocal,
  parseArgs,
  resolveLocalSource,
  sourceVariant,
} from '../install-ios-frameworks.mjs';
import { IOS_FRAMEWORKS } from '../ios-build-info.mjs';

/**
 * The install script decides three things that are invisible until they go
 * wrong: which flags were meant, which tree to read, and which variant the
 * result actually is. Each is guarded here because the consequences are silent
 * -- a mis-parsed `--local --debug` installs Release frameworks while the
 * developer believes they are in Metro mode, and Maestro cannot tell the two
 * apart (only the Metro log can).
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'install-ios-frameworks-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A framework binary for `slice`, with or without the Debug Metro marker. */
function writeSlice(root: string, slice: string, contents: string): void {
  const frameworkDir = path.join(
    root,
    'OtaGatewayLib.xcframework',
    slice,
    'OtaGatewayLib.framework',
  );
  mkdirSync(frameworkDir, { recursive: true });
  writeFileSync(path.join(frameworkDir, 'OtaGatewayLib'), contents);
}

function writeBinary(root: string, contents: string): void {
  writeSlice(root, 'ios-arm64', contents);
  writeSlice(root, 'ios-arm64_x86_64-simulator', contents);
}

describe('parseArgs', () => {
  it('defaults to a Release download at the app.json version', () => {
    const { version } = JSON.parse(
      readFileSync(path.join(__dirname, '..', '..', 'app.json'), 'utf8'),
    ).expo;
    const parsed = parseArgs([]);
    expect(parsed.debug).toBe(false);
    expect(parsed.local).toBe(false);
    expect(parsed.localPath).toBeNull();
    expect(parsed.tag).toBe(`v${version}`);
  });

  // The documented primary route into Metro mode. If the lookahead ate --debug
  // as a path, the install would silently be a Release install.
  it('does not swallow --debug as the --local path', () => {
    expect(parseArgs(['--local', '--debug'])).toMatchObject({
      local: true,
      debug: true,
      localPath: null,
    });
  });

  it('accepts a --local path in either flag order', () => {
    expect(parseArgs(['--local', 'build-debug', '--debug'])).toMatchObject({
      local: true,
      debug: true,
      localPath: 'build-debug',
    });
    expect(parseArgs(['--debug', '--local', 'build-debug'])).toMatchObject({
      local: true,
      debug: true,
      localPath: 'build-debug',
    });
  });

  it('consumes the --tag value rather than re-reading it as a flag', () => {
    expect(parseArgs(['--tag', 'v9.9.9'])).toMatchObject({ tag: 'v9.9.9' });
  });

  it('rejects --tag with no value, including at the end of argv', () => {
    expect(() => parseArgs(['--tag'])).toThrow(/--tag requires a value/);
    expect(() => parseArgs(['--tag', '--debug'])).toThrow(/--tag requires a value/);
  });

  it('rejects --tag combined with --local (a download-only flag)', () => {
    expect(() => parseArgs(['--local', '--tag', 'v1.0.0'])).toThrow(/cannot be combined/);
  });

  it('rejects an unknown argument instead of ignoring it', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument: --nope/);
  });
});

describe('resolveLocalSource', () => {
  it('reads the build-debug mirror for --debug and build/ otherwise', () => {
    expect(resolveLocalSource({ debug: true })).toBe(DEBUG_MIRROR);
    expect(resolveLocalSource({ debug: false })).toBe(DESTINATION);
  });

  // pnpm runs package scripts with cwd apps/mobile, so anchoring on cwd would
  // resolve a path typed at the repo root to the wrong place.
  it('anchors a relative path on the directory the command was run in', () => {
    expect(
      resolveLocalSource({
        localPath: './tree',
        env: { INIT_CWD: '/repo' },
        cwd: '/repo/apps/mobile',
      }),
    ).toBe(path.resolve('/repo/tree'));
  });

  it('falls back to cwd when INIT_CWD is unset (script run without pnpm)', () => {
    expect(resolveLocalSource({ localPath: 'tree', env: {}, cwd: '/elsewhere' })).toBe(
      path.resolve('/elsewhere/tree'),
    );
  });
});

describe('describeContainment', () => {
  it('allows an unrelated source tree', () => {
    const source = path.join(dir, 'source');
    const destination = path.join(dir, 'destination');
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    expect(describeContainment(source, destination)).toBeNull();
  });

  // Installing clears the destination first, so these three shapes would delete
  // the source along with it and leave no frameworks at all.
  it('rejects the destination itself, ignoring a trailing slash', () => {
    const destination = path.join(dir, 'destination');
    mkdirSync(destination, { recursive: true });
    expect(describeContainment(destination, destination)).toMatch(/destination itself/);
    expect(describeContainment(`${destination}/`, destination)).toMatch(/destination itself/);
  });

  it('rejects a source nested inside the destination (an unzipped asset)', () => {
    const destination = path.join(dir, 'destination');
    const nested = path.join(destination, 'extracted-asset');
    mkdirSync(nested, { recursive: true });
    expect(describeContainment(nested, destination)).toMatch(/inside the destination/);
  });

  it('rejects a source that contains the destination', () => {
    const destination = path.join(dir, 'parent', 'destination');
    mkdirSync(destination, { recursive: true });
    expect(describeContainment(path.join(dir, 'parent'), destination)).toMatch(
      /contains the destination/,
    );
  });

  it('resolves symlinks, which a string compare would miss', () => {
    const destination = path.join(dir, 'destination');
    const link = path.join(dir, 'link-to-destination');
    mkdirSync(destination, { recursive: true });
    symlinkSync(destination, link);
    expect(describeContainment(link, destination)).toMatch(/destination itself/);
  });
});

describe('sourceVariant', () => {
  it('reads the stamp when package-ios.sh wrote one', () => {
    writeFileSync(
      path.join(dir, '.build-info.json'),
      JSON.stringify({ configuration: 'Debug' }),
    );
    expect(sourceVariant(dir)).toBe('debug');
  });

  it('prefers the stamp over the binary', () => {
    writeFileSync(
      path.join(dir, '.build-info.json'),
      JSON.stringify({ configuration: 'Release' }),
    );
    writeBinary(dir, '...localhost:8081...');
    expect(sourceVariant(dir)).toBe('release');
  });

  // Published assets are staged without the stamp, so an extracted -debug asset
  // can only be identified by the Metro fallback URL in its binary. Without
  // this, the caller's flag would decide -- and record "release" for Debug
  // frameworks.
  it('falls back to the binary for an unstamped tree (an extracted asset)', () => {
    writeBinary(dir, '...RCTBundleURLProvider...localhost:8081...');
    expect(sourceVariant(dir)).toBe('debug');
  });

  it('identifies an unstamped Release tree from its binary', () => {
    writeBinary(dir, 'no dev server in here');
    expect(sourceVariant(dir)).toBe('release');
  });

  it('returns null when neither the stamp nor a binary can answer', () => {
    expect(sourceVariant(dir)).toBeNull();
  });

  it('returns null when the slices disagree, rather than guessing', () => {
    writeSlice(dir, 'ios-arm64', '...localhost:8081...');
    writeSlice(dir, 'ios-arm64_x86_64-simulator', 'no dev server in here');
    expect(sourceVariant(dir)).toBeNull();
  });

  it('ignores an unreadable stamp and falls through to the binary', () => {
    writeFileSync(path.join(dir, '.build-info.json'), '{nope');
    writeBinary(dir, '...localhost:8081...');
    expect(sourceVariant(dir)).toBe('debug');
  });
});

/**
 * Orchestration, not just predicates. The guards above only protect the host's
 * framework tree if they run BEFORE it is replaced -- the bug this ordering
 * fixes was "the destination was already deleted by the time we noticed". These
 * tests inject the destination and the copy step so the whole sequence runs
 * against fixtures, on any OS, with no xcframework and no macOS ditto.
 */
describe('installLocal orchestration', () => {
  let destination: string;
  let source: string;

  /** A tree complete enough to install: every framework plus Expo.plist. */
  function writeCompleteSource(root: string, contents = 'no dev server here'): void {
    mkdirSync(root, { recursive: true });
    for (const framework of IOS_FRAMEWORKS) {
      mkdirSync(path.join(root, framework), { recursive: true });
      writeFileSync(path.join(root, framework, 'placeholder'), contents);
    }
    writeFileSync(path.join(root, 'Expo.plist'), '<plist/>');
  }

  /** Marks the existing install so a test can prove it survived (or did not). */
  function writeExistingInstall(root: string): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'do-not-delete-me'), 'the previous install');
  }

  const copy = (from: string, to: string) => cpSync(from, to, { recursive: true });
  const silent = () => {};

  beforeEach(() => {
    destination = path.join(dir, 'package', 'build');
    source = path.join(dir, 'elsewhere', 'build-debug');
  });

  it('installs a complete source and records the install marker', () => {
    writeCompleteSource(source);
    writeFileSync(
      path.join(source, '.build-info.json'),
      JSON.stringify({ configuration: 'Debug' }),
    );
    mkdirSync(path.join(source, 'dSYMs', 'Debug-iphoneos'), { recursive: true });
    writeExistingInstall(destination);

    installLocal({ debug: true, localPath: source, destination, copy, log: silent });

    for (const framework of IOS_FRAMEWORKS) {
      expect(existsSync(path.join(destination, framework))).toBe(true);
    }
    expect(existsSync(path.join(destination, 'Expo.plist'))).toBe(true);
    expect(existsSync(path.join(destination, 'dSYMs', 'Debug-iphoneos'))).toBe(true);
    // The previous install is replaced, not merged into.
    expect(existsSync(path.join(destination, 'do-not-delete-me'))).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(destination, '.install-info.json'), 'utf8')),
    ).toMatchObject({ source: 'local', variant: 'debug', sourcePath: source });
    // No staging directory left behind next to the destination.
    expect(readdirSync(path.dirname(destination))).toEqual(['build']);
  });

  it('records the variant the source really holds, not the flag', () => {
    writeCompleteSource(source);
    writeFileSync(
      path.join(source, '.build-info.json'),
      JSON.stringify({ configuration: 'Debug' }),
    );

    // No --debug, but the source is a Debug tree: the stamp wins.
    installLocal({ localPath: source, destination, copy, log: silent });

    expect(
      JSON.parse(readFileSync(path.join(destination, '.install-info.json'), 'utf8')).variant,
    ).toBe('debug');
  });

  it('leaves the existing install untouched when the source lacks Expo.plist', () => {
    writeCompleteSource(source);
    rmSync(path.join(source, 'Expo.plist'));
    writeExistingInstall(destination);

    expect(() =>
      installLocal({ localPath: source, destination, copy, log: silent }),
    ).toThrow(/Expo\.plist/);
    expect(existsSync(path.join(destination, 'do-not-delete-me'))).toBe(true);
  });

  it('leaves the existing install untouched when a framework is missing', () => {
    writeCompleteSource(source);
    rmSync(path.join(source, IOS_FRAMEWORKS[2]), { recursive: true });
    writeExistingInstall(destination);

    expect(() =>
      installLocal({ localPath: source, destination, copy, log: silent }),
    ).toThrow(new RegExp(IOS_FRAMEWORKS[2]));
    expect(existsSync(path.join(destination, 'do-not-delete-me'))).toBe(true);
  });

  it('leaves the existing install untouched when the source sits inside it', () => {
    const nested = path.join(destination, 'extracted-asset');
    writeCompleteSource(nested);
    writeExistingInstall(destination);

    expect(() =>
      installLocal({ localPath: nested, destination, copy, log: silent }),
    ).toThrow(/lives inside the destination/);
    expect(existsSync(path.join(destination, 'do-not-delete-me'))).toBe(true);
    expect(existsSync(path.join(nested, 'Expo.plist'))).toBe(true);
  });

  // The copy step is the one thing that can fail halfway. Staging means a partial
  // copy is discarded instead of becoming the host's tree.
  it('leaves the existing install untouched when the copy drops a framework', () => {
    writeCompleteSource(source);
    writeExistingInstall(destination);
    const lossyCopy = (from: string, to: string) => {
      if (from.endsWith(IOS_FRAMEWORKS[1])) return;
      cpSync(from, to, { recursive: true });
    };

    expect(() =>
      installLocal({ localPath: source, destination, copy: lossyCopy, log: silent }),
    ).toThrow(/staged .* install is incomplete/);
    expect(existsSync(path.join(destination, 'do-not-delete-me'))).toBe(true);
    expect(readdirSync(path.dirname(destination))).toEqual(['build']);
  });

  it('reports a no-op instead of deleting the destination it was pointed at', () => {
    writeCompleteSource(destination);
    const lines: string[] = [];

    installLocal({
      localPath: destination,
      destination,
      copy,
      log: (line: string) => lines.push(line),
    });

    expect(lines.join('\n')).toMatch(/IS the tree the host consumes/);
    expect(existsSync(path.join(destination, 'Expo.plist'))).toBe(true);
  });
});

describe('installFromRelease orchestration', () => {
  let destination: string;
  const silent = () => {};

  beforeEach(() => {
    destination = path.join(dir, 'package', 'build');
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, 'do-not-delete-me'), 'the previous install');
  });

  /** Stands in for `gh release download`: drops the archive where it is expected. */
  const download = ({ assetName, workDir }: { assetName: string; workDir: string }) => {
    writeFileSync(path.join(workDir, assetName), 'pretend zip');
  };

  function extractComplete({ into }: { into: string }): void {
    for (const framework of IOS_FRAMEWORKS) {
      mkdirSync(path.join(into, framework), { recursive: true });
    }
    writeFileSync(path.join(into, 'Expo.plist'), '<plist/>');
  }

  it('installs a complete asset and records the tag it came from', () => {
    installFromRelease({
      debug: true,
      tag: 'v9.9.9',
      destination,
      download,
      extract: extractComplete,
      log: silent,
    });

    expect(
      JSON.parse(readFileSync(path.join(destination, '.install-info.json'), 'utf8')),
    ).toMatchObject({ source: 'release', variant: 'debug', tag: 'v9.9.9' });
    expect(existsSync(path.join(destination, 'do-not-delete-me'))).toBe(false);
    expect(readdirSync(path.dirname(destination))).toEqual(['build']);
  });

  // An older release whose asset predates one of the frameworks, or a truncated
  // download: extracting into the destination first would cost a 30-60 minute
  // rebuild.
  it('leaves the existing install untouched when the asset is incomplete', () => {
    const extractPartial = ({ into }: { into: string }) => {
      mkdirSync(path.join(into, IOS_FRAMEWORKS[0]), { recursive: true });
    };

    expect(() =>
      installFromRelease({
        tag: 'v9.9.9',
        destination,
        download,
        extract: extractPartial,
        log: silent,
      }),
    ).toThrow(/is incomplete, so .* was left as it was/);
    expect(existsSync(path.join(destination, 'do-not-delete-me'))).toBe(true);
  });

  it('leaves the existing install untouched when the download fails', () => {
    const failing = () => {
      throw new Error('gh: not found');
    };

    expect(() =>
      installFromRelease({
        debug: true,
        tag: 'v0.0.1',
        destination,
        download: failing,
        extract: extractComplete,
        log: silent,
      }),
    ).toThrow(/Could not download .* predates the Debug asset|Could not download/s);
    expect(existsSync(path.join(destination, 'do-not-delete-me'))).toBe(true);
  });
});

describe('describeIncompleteInstall', () => {
  it('accepts a tree with every framework and Expo.plist', () => {
    for (const framework of IOS_FRAMEWORKS) {
      mkdirSync(path.join(dir, framework), { recursive: true });
    }
    writeFileSync(path.join(dir, 'Expo.plist'), '<plist/>');
    expect(describeIncompleteInstall(dir)).toBeNull();
  });

  it('names every missing entry, including Expo.plist with its hint', () => {
    const message = describeIncompleteInstall(dir) ?? '';
    for (const framework of IOS_FRAMEWORKS) {
      expect(message).toContain(framework);
    }
    expect(message).toMatch(/expo-updates config/);
  });
});
