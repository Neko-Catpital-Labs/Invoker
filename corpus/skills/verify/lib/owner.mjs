import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DESTRUCTIVE_OWNER = new Set([
  'cancel',
  'delete-workflow',
  'approve',
  'reject',
  'recreate-workflow',
  'resolve-conflict',
  'retry-task',
  'input',
  'edit',
  'edit-type',
  'edit-agent',
  'set',
]);

export function runOwner(opts) {
  const args = opts.args;
  if (args.length === 0) {
    return { ok: false, exitCode: 1, stdout: '', stderr: 'owner requires a subcommand (e.g. health, status, query workflows)' };
  }

  const head = args[0];

  if (head === 'query' || head === 'wait') {
    if (opts.dryRun) {
      return { ok: true, dryRun: true, exitCode: 0, stdout: `invoker-cli ${args.join(' ')}`, stderr: '', ran: false };
    }
    const result = spawnSync('invoker-cli', args, {
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
      ran: true,
    };
  }

  const ctl = join(opts.repoRoot, 'invoker-ctl');
  if (!existsSync(ctl)) {
    return { ok: false, exitCode: 1, stdout: '', stderr: `missing invoker-ctl at ${ctl}` };
  }

  if (DESTRUCTIVE_OWNER.has(head) && opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      exitCode: 0,
      stdout: `./invoker-ctl ${args.join(' ')}`,
      stderr: '',
      ran: false,
      destructive: true,
    };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      exitCode: 0,
      stdout: `./invoker-ctl ${args.join(' ')}`,
      stderr: '',
      ran: false,
    };
  }

  const result = spawnSync(ctl, args, {
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
    ran: true,
    destructive: DESTRUCTIVE_OWNER.has(head),
  };
}

export { DESTRUCTIVE_OWNER };
