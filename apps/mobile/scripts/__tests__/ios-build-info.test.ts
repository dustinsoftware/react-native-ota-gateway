import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  verifyBuildInfo,
  verifyMetroMarker,
  verifyNotInstalled,
} from '../ios-build-info.mjs';

/**
 * Unit tests for the release-gate checks run against each iOS package tree.
 * These pin failures for wrong configurations, stale trees, and stamps that do
 * not match the framework binary beside them.
 */

let dir: string;

const EXPECTED = {
  expectedConfiguration: 'Release',
  expectedVersion: '1.2.3',
  expectedHeadSha: 'abc123',
};

function writeStamp(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    path.join(dir, '.build-info.json'),
    JSON.stringify({
      configuration: 'Release',
      version: '1.2.3',
      headSha: 'abc123',
      builtAt: '2026-07-27T00:00:00.000Z',
      ...overrides,
    }),
  );
}

/** Write one slice's binary. Defaults to the device slice. */
function writeSlice(contents: string, slice = 'ios-arm64'): void {
  const frameworkDir = path.join(
    dir,
    'OtaGatewayLib.xcframework',
    slice,
    'OtaGatewayLib.framework',
  );
  mkdirSync(frameworkDir, { recursive: true });
  writeFileSync(path.join(frameworkDir, 'OtaGatewayLib'), contents);
}

/** Write BOTH slices with the same contents -- the shape a real build has. */
function writeBinary(contents: string): void {
  writeSlice(contents, 'ios-arm64');
  writeSlice(contents, 'ios-arm64_x86_64-simulator');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ios-build-info-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('verifyBuildInfo', () => {
  it('passes a matching stamp', () => {
    writeStamp();
    expect(verifyBuildInfo({ dir, ...EXPECTED })).toBeNull();
  });

  it('fails when the stamp is missing', () => {
    expect(verifyBuildInfo({ dir, ...EXPECTED })).toMatch(/not found/);
  });

  it('fails on invalid JSON', () => {
    writeFileSync(path.join(dir, '.build-info.json'), '{nope');
    expect(verifyBuildInfo({ dir, ...EXPECTED })).toMatch(/not valid JSON/);
  });

  it('fails on the wrong configuration (Debug tree offered as Release)', () => {
    writeStamp({ configuration: 'Debug' });
    expect(verifyBuildInfo({ dir, ...EXPECTED })).toMatch(
      /contains a Debug build but this release step needs Release/,
    );
  });

  it('fails on a version mismatch (stale tree from a previous cut)', () => {
    writeStamp({ version: '1.2.2' });
    expect(verifyBuildInfo({ dir, ...EXPECTED })).toMatch(/built as version '1.2.2'/);
  });

  it('fails on a HEAD-sha mismatch (same version, older commit)', () => {
    writeStamp({ headSha: 'def456' });
    expect(verifyBuildInfo({ dir, ...EXPECTED })).toMatch(/built at commit def456/);
  });

  it('fails on a stamp with no headSha (pre-stamp-format tree)', () => {
    writeStamp({ headSha: undefined });
    expect(verifyBuildInfo({ dir, ...EXPECTED })).toMatch(/built at commit \(unknown\)/);
  });
});

describe('verifyNotInstalled', () => {
  it('passes a tree with no install marker (a local build)', () => {
    expect(verifyNotInstalled(dir)).toBeNull();
  });

  it('rejects a downloaded tree and names the release it came from', () => {
    writeFileSync(
      path.join(dir, '.install-info.json'),
      JSON.stringify({ source: 'release', variant: 'debug', tag: 'v0.1.0' }),
    );
    const error = verifyNotInstalled(dir);
    expect(error).toMatch(/not built from this checkout/);
    expect(error).toMatch(/source: release v0.1.0, variant: debug/);
  });

  it('rejects a locally installed tree, which carries a path instead of a tag', () => {
    writeFileSync(
      path.join(dir, '.install-info.json'),
      JSON.stringify({ source: 'local', variant: 'debug', sourcePath: '/tmp/build-debug' }),
    );
    const error = verifyNotInstalled(dir);
    expect(error).toMatch(/source: local, variant: debug/);
    expect(error).not.toMatch(/undefined/);
  });

  it('rejects an installed tree even when the marker is unreadable', () => {
    writeFileSync(path.join(dir, '.install-info.json'), '{nope');
    expect(verifyNotInstalled(dir)).toMatch(/not built from this checkout/);
  });
});

describe('verifyMetroMarker', () => {
  it('passes a Release binary without the Metro URL', () => {
    writeBinary('compiled things, no dev server here');
    expect(verifyMetroMarker(dir, 'Release')).toBeNull();
  });

  it('passes a Debug binary containing the Metro URL', () => {
    writeBinary('...RCTBundleURLProvider...localhost:8081...');
    expect(verifyMetroMarker(dir, 'Debug')).toBeNull();
  });

  it('fails a Release check when the binary contains the Metro URL', () => {
    writeBinary('...localhost:8081...');
    expect(verifyMetroMarker(dir, 'Release')).toMatch(
      /Debug binary regardless of what the stamp says/,
    );
  });

  it('fails a Debug check when the binary lacks the Metro URL', () => {
    writeBinary('release-only contents');
    expect(verifyMetroMarker(dir, 'Debug')).toMatch(/not a Debug binary/);
  });

  it('fails when the binary is missing entirely', () => {
    expect(verifyMetroMarker(dir, 'Release')).toMatch(/cannot verify/);
  });

  // Every slice is checked, not just the device one. The Debug asset exists for
  // SIMULATOR hot reload, so a Debug build whose simulator slice lacked the
  // marker would otherwise pass the gate and publish an asset that silently
  // does nothing.
  it('fails a Debug check when only the simulator slice lacks the Metro URL', () => {
    writeSlice('...localhost:8081...', 'ios-arm64');
    writeSlice('no dev server here', 'ios-arm64_x86_64-simulator');
    expect(verifyMetroMarker(dir, 'Debug')).toMatch(
      /ios-arm64_x86_64-simulator[\s\S]*not a Debug binary/,
    );
  });

  it('fails a Release check when only the simulator slice carries the Metro URL', () => {
    writeSlice('clean release binary', 'ios-arm64');
    writeSlice('...localhost:8081...', 'ios-arm64_x86_64-simulator');
    expect(verifyMetroMarker(dir, 'Release')).toMatch(
      /ios-arm64_x86_64-simulator[\s\S]*Debug binary regardless/,
    );
  });

  it('ignores the xcframework Info.plist, which is not a slice', () => {
    writeBinary('clean release binary');
    writeFileSync(
      path.join(dir, 'OtaGatewayLib.xcframework', 'Info.plist'),
      '<plist/>',
    );
    expect(verifyMetroMarker(dir, 'Release')).toBeNull();
  });

  // A slice directory with no binary must FAIL rather than be skipped: skipping
  // it would let a half-merged xcframework pass on whichever slice is intact.
  it('fails when a slice directory has no binary', () => {
    writeSlice('clean release binary', 'ios-arm64');
    mkdirSync(
      path.join(dir, 'OtaGatewayLib.xcframework', 'ios-arm64_x86_64-simulator'),
      { recursive: true },
    );
    expect(verifyMetroMarker(dir, 'Release')).toMatch(
      /ios-arm64_x86_64-simulator[\s\S]*slice with no binary/,
    );
  });
});
