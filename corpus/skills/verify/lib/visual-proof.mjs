import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ALLOWED = new Set(['capture-before', 'capture-after', 'compare', 'embed', 'validate']);

export function runVisualProof(opts) {
  const sub = opts.subcommand;
  if (!ALLOWED.has(sub)) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: `unknown visual-proof subcommand: ${sub} (expected ${[...ALLOWED].join('|')})`,
    };
  }
  const script = join(opts.repoRoot, 'scripts/ui-visual-proof.sh');
  const args = [sub, ...(opts.extraArgs ?? [])];
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      exitCode: 0,
      stdout: `bash ${script} ${args.join(' ')}`,
      stderr: '',
    };
  }
  const result = spawnSync('bash', [script, ...args], {
    cwd: opts.repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  return {
    ok: result.status === 0,
    dryRun: false,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
