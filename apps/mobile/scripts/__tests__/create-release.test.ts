import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeIosBuildProblem } from '../create-release.mjs';

/**
 * The release gate's composition order. Each individual check is covered in
 * ios-build-info.test.ts; what matters here is which one speaks first, because a
 * tree can fail several at once and only one message gets read. An installed tree
 * ALSO fails the stamp checks -- with a message about versions and commits that
 * sends the operator off to rebuild something that is already fresh.
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
      ...overrides,
    }),
  );
}

function writeBinary(contents: string): void {
  for (const slice of ['ios-arm64', 'ios-arm64_x86_64-simulator']) {
    const frameworkDir = path.join(
      dir,
      'OtaGatewayLib.xcframework',
      slice,
      'OtaGatewayLib.framework',
    );
    mkdirSync(frameworkDir, { recursive: true });
    writeFileSync(path.join(frameworkDir, 'OtaGatewayLib'), contents);
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'create-release-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('describeIosBuildProblem', () => {
  it('accepts a tree that was built here, matches the cut, and agrees with its binary', () => {
    writeStamp();
    writeBinary('no dev server here');
    expect(describeIosBuildProblem({ dir, ...EXPECTED })).toBeNull();
  });

  // The ordering that matters: an installed tree carries a copied stamp from
  // ANOTHER build, so the version/sha checks fire too. "Not built from this
  // checkout" is the message that actually explains what to do.
  it('reports the install marker first, not the stamp mismatch it also causes', () => {
    writeFileSync(
      path.join(dir, '.install-info.json'),
      JSON.stringify({ source: 'release', variant: 'debug', tag: 'v0.1.0' }),
    );
    writeStamp({ version: '0.9.9', headSha: 'deadbeef' });
    writeBinary('no dev server here');

    const problem = describeIosBuildProblem({ dir, ...EXPECTED });
    expect(problem).toMatch(/not built from this checkout/);
    expect(problem).not.toMatch(/stale tree/);
  });

  it('reports a stamp problem before inspecting the binary', () => {
    writeStamp({ configuration: 'Debug' });
    writeBinary('...localhost:8081...');

    const problem = describeIosBuildProblem({ dir, ...EXPECTED });
    expect(problem).toMatch(/contains a Debug build but this release step needs Release/);
    expect(problem).not.toMatch(/Metro dev-server URL/);
  });

  it('falls through to the binary check when the stamp looks right', () => {
    writeStamp();
    writeBinary('...localhost:8081...');
    expect(describeIosBuildProblem({ dir, ...EXPECTED })).toMatch(
      /this is a Debug binary regardless of what the stamp says/,
    );
  });
});
