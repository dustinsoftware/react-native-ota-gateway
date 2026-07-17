import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Argument handling in scripts/package-ios.sh, which is otherwise only exercised
 * by a 30-60 minute build. Every case here exits during argument parsing --
 * before the script touches the package directory or invokes the brownfield CLI
 * -- so these run anywhere, including the Linux CI merge gate.
 *
 * What they protect: the default is `Both` (Debug then Release) and a release cut
 * depends on it, while CI pins `--configuration Release`. A typo that narrowed
 * the accepted set, or silently accepted an unknown configuration, would either
 * break the cut or publish the wrong tree.
 */
const SCRIPT = path.resolve(__dirname, '..', 'package-ios.sh');

function run(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      // Backstop: every case here must exit in the argument loop. execFileSync is
      // synchronous, so it blocks the worker and vitest's testTimeout cannot bound
      // it -- without this, a script edit that let parsing fall through would hang
      // the suite (or start a 30-60 minute build) instead of failing.
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('package-ios.sh argument validation', () => {
  /**
   * Nothing in this suite may reach the build. The trailing `--unexpected-extra`
   * is what makes the valid-configuration cases exit; if a future edit let
   * parsing fall through, these assertions fail instead of the suite deleting a
   * developer's stamp or starting an hour-long build.
   */
  function expectNoBuildStarted(output: string): void {
    expect(output).not.toContain("Running 'brownfield package:ios'");
    expect(output).not.toContain('Packaging BOTH configurations');
    expect(output).not.toContain('ccache enabled');
  }

  it.each(['Release', 'Debug', 'Both'])(
    'accepts --configuration %s (the parser passes it; the trailing arg is what exits)',
    (configuration) => {
      // A valid configuration must NOT be rejected by the parser. Reaching the
      // unknown-arg branch proves the inner Release|Debug|Both case accepted it,
      // since bash processes the loop left to right.
      const { output } = run(['--configuration', configuration, '--unexpected-extra']);
      expect(output).toContain('Unknown arg: --unexpected-extra');
      expect(output).not.toContain('--configuration must be');
      expectNoBuildStarted(output);
    },
  );

  it('rejects an unknown configuration and names the accepted set', () => {
    const { status, output } = run(['--configuration', 'Bogus']);
    expect(status).toBe(1);
    expect(output).toContain("must be Release, Debug or Both (got 'Bogus')");
    expectNoBuildStarted(output);
  });

  it('rejects a missing --configuration value', () => {
    const { status, output } = run(['--configuration']);
    expect(status).toBe(1);
    expect(output).toContain("(got '')");
  });

  it('rejects a lowercase configuration rather than guessing', () => {
    const { status, output } = run(['--configuration', 'release']);
    expect(status).toBe(1);
    expect(output).toContain("(got 'release')");
  });

  it('rejects an unknown flag', () => {
    const { status, output } = run(['--nope']);
    expect(status).toBe(1);
    expect(output).toContain('Unknown arg: --nope');
    expectNoBuildStarted(output);
  });
});
