import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Execution tests for scripts/verify-ios-framework-version.sh (the App Store
 * versioning gate run by package-ios.sh): stage fixture
 * OtaGatewayLib.xcframework slices with XML Info.plists in a temp dir and
 * assert on exit codes + messages. Pins the gate's fail-closed polarity:
 * missing keys, a stale (mismatched) version, and an empty/missing package
 * must all fail loudly, never pass vacuously (ITMS-90057 class).
 *
 * macOS-only: the gate reads plists with /usr/libexec/PlistBuddy, which does
 * not exist on the Linux CI runner -- there the suite is skipped and the gate
 * is exercised by the manual iOS Framework Verify workflow's real package run.
 */
const SCRIPT = path.resolve(__dirname, '..', 'verify-ios-framework-version.sh');

function plistXml(entries: Record<string, string>): string {
  const body = Object.entries(entries)
    .map(([k, v]) => `  <key>${k}</key>\n  <string>${v}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

let packageDir: string;

function stageSlice(slice: string, entries: Record<string, string>): void {
  const frameworkDir = path.join(
    packageDir,
    'OtaGatewayLib.xcframework',
    slice,
    'OtaGatewayLib.framework',
  );
  mkdirSync(frameworkDir, { recursive: true });
  writeFileSync(path.join(frameworkDir, 'Info.plist'), plistXml(entries));
}

function runGate(expectedVersion?: string): { status: number; output: string } {
  const args = expectedVersion === undefined ? [packageDir] : [packageDir, expectedVersion];
  try {
    const output = execFileSync(SCRIPT, args, { encoding: 'utf8' });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { status: e.status, output: e.stdout };
  }
}

const STAMPED = { CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1' };

describe.skipIf(process.platform !== 'darwin')('verify-ios-framework-version.sh', () => {
  afterEach(() => {
    rmSync(packageDir, { recursive: true, force: true });
  });

  it('passes when every slice carries matching version keys', () => {
    packageDir = mkdtempSync(path.join(tmpdir(), 'ios-gate-'));
    stageSlice('ios-arm64', STAMPED);
    stageSlice('ios-arm64_x86_64-simulator', STAMPED);
    const { status, output } = runGate('0.1.0');
    expect(status).toBe(0);
    expect(output).toContain('[ios-arm64] CFBundleShortVersionString=0.1.0');
    expect(output).toContain('[ios-arm64_x86_64-simulator] CFBundleVersion=1');
  });

  it('fails when CFBundleShortVersionString is missing (the ITMS-90057 case)', () => {
    packageDir = mkdtempSync(path.join(tmpdir(), 'ios-gate-'));
    stageSlice('ios-arm64', { CFBundleVersion: '1' });
    const { status, output } = runGate('0.1.0');
    expect(status).toBe(1);
    expect(output).toContain('missing CFBundleShortVersionString');
    expect(output).toContain('ITMS-90057');
  });

  it('fails when the stamped version does not match (stale generated ios/)', () => {
    packageDir = mkdtempSync(path.join(tmpdir(), 'ios-gate-'));
    stageSlice('ios-arm64', { CFBundleShortVersionString: '0.0.9', CFBundleVersion: '1' });
    const { status, output } = runGate('0.1.0');
    expect(status).toBe(1);
    expect(output).toContain("CFBundleShortVersionString is '0.0.9'");
    expect(output).toContain('stale');
  });

  it('degrades to presence-only when no expected version is given', () => {
    packageDir = mkdtempSync(path.join(tmpdir(), 'ios-gate-'));
    stageSlice('ios-arm64', { CFBundleShortVersionString: '0.0.9', CFBundleVersion: '1' });
    expect(runGate('').status).toBe(0);
    expect(runGate().status).toBe(0);
  });

  it('fails rather than passing vacuously when no slices exist', () => {
    packageDir = mkdtempSync(path.join(tmpdir(), 'ios-gate-'));
    const { status, output } = runGate('0.1.0');
    expect(status).toBe(1);
    expect(output).toContain('no framework slices found');
  });
});
