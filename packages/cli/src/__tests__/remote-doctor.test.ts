import { describe, expect, it } from 'vitest';

import { runRemoteDoctorChecks, type ExecRemoteCaptureImpl } from '../remote-doctor.js';

const TARGET = { host: '203.0.113.5', user: 'invoker', sshKeyPath: '/tmp/key' };
const REPO_URL = 'https://github.com/example/repo.git';

function stubCapture(stdout: string) {
  return async () => stdout;
}

function failingCapture(message: string) {
  return async () => {
    throw new Error(message);
  };
}

describe('runRemoteDoctorChecks', () => {
  it('builds a non-interactive bounded push-auth probe', async () => {
    const scripts: string[] = [];
    const capture: ExecRemoteCaptureImpl = async (opts) => {
      scripts.push(opts.script);
      return 'check:git:ok\ncheck:node:ok\ncheck:pnpm:ok\ndisk_kb:5242880\ncheck:push-auth:ok';
    };

    await runRemoteDoctorChecks({
      target: TARGET,
      repoUrl: REPO_URL,
      execRemoteCaptureImpl: capture,
    });

    const script = scripts[0];
    expect(script).toContain('export GIT_TERMINAL_PROMPT=0');
    expect(script).toContain('export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"');
    expect(script).toContain(`if timeout 30 git ls-remote '${REPO_URL}' >/dev/null 2>&1; then echo "check:push-auth:ok"; else echo "check:push-auth:missing"; fi`);
    expect(script.indexOf('export GIT_TERMINAL_PROMPT=0')).toBeLessThan(script.indexOf('timeout 30 git ls-remote'));
  });

  it('reports ok for every check when the remote box is fully ready', async () => {
    const stdout = [
      'check:git:ok',
      'check:node:ok',
      'check:pnpm:ok',
      'disk_kb:5242880',
      'check:push-auth:ok',
    ].join('\n');

    const checks = await runRemoteDoctorChecks({
      target: TARGET,
      repoUrl: REPO_URL,
      execRemoteCaptureImpl: stubCapture(stdout),
    });

    expect(checks.every((check) => check.status === 'ok')).toBe(true);
    expect(checks.map((check) => check.id)).toEqual(['git', 'node', 'pnpm', 'disk-space', 'push-auth']);
  });

  it('marks a missing tool as an error, not a warning', async () => {
    const stdout = [
      'check:git:missing',
      'check:node:ok',
      'check:pnpm:ok',
      'disk_kb:5242880',
      'check:push-auth:ok',
    ].join('\n');

    const checks = await runRemoteDoctorChecks({
      target: TARGET,
      repoUrl: REPO_URL,
      execRemoteCaptureImpl: stubCapture(stdout),
    });

    const git = checks.find((check) => check.id === 'git');
    expect(git?.status).toBe('error');
  });

  it('warns, but does not error, on low disk space', async () => {
    const stdout = [
      'check:git:ok',
      'check:node:ok',
      'check:pnpm:ok',
      'disk_kb:1024', // 1 MiB, well under the 1 GiB threshold
      'check:push-auth:ok',
    ].join('\n');

    const checks = await runRemoteDoctorChecks({
      target: TARGET,
      repoUrl: REPO_URL,
      execRemoteCaptureImpl: stubCapture(stdout),
    });

    const disk = checks.find((check) => check.id === 'disk-space');
    expect(disk?.status).toBe('warn');
  });

  it('errors when the remote box cannot reach the repo with its own git credentials', async () => {
    const stdout = [
      'check:git:ok',
      'check:node:ok',
      'check:pnpm:ok',
      'disk_kb:5242880',
      'check:push-auth:missing',
    ].join('\n');

    const checks = await runRemoteDoctorChecks({
      target: TARGET,
      repoUrl: REPO_URL,
      execRemoteCaptureImpl: stubCapture(stdout),
    });

    const pushAuth = checks.find((check) => check.id === 'push-auth');
    expect(pushAuth?.status).toBe('error');
    expect(pushAuth?.detail).toContain(REPO_URL);
  });

  it('redacts embedded HTTPS credentials from push-auth details', async () => {
    const stdoutOk = [
      'check:git:ok',
      'check:node:ok',
      'check:pnpm:ok',
      'disk_kb:5242880',
      'check:push-auth:ok',
    ].join('\n');
    const stdoutMissing = [
      'check:git:ok',
      'check:node:ok',
      'check:pnpm:ok',
      'disk_kb:5242880',
      'check:push-auth:missing',
    ].join('\n');
    const secretRepoUrl = 'https://robot:ghp_secret-token@github.com/example/private-repo.git';
    const redactedRepoUrl = 'https://github.com/example/private-repo.git';

    const okChecks = await runRemoteDoctorChecks({
      target: TARGET,
      repoUrl: secretRepoUrl,
      execRemoteCaptureImpl: stubCapture(stdoutOk),
    });
    const missingChecks = await runRemoteDoctorChecks({
      target: TARGET,
      repoUrl: secretRepoUrl,
      execRemoteCaptureImpl: stubCapture(stdoutMissing),
    });

    const details = [okChecks, missingChecks].map((checks) => checks.find((check) => check.id === 'push-auth')?.detail ?? '');
    expect(details).toEqual([
      `Remote box can reach ${redactedRepoUrl}`,
      `Remote box could not reach ${redactedRepoUrl} with its own git credentials`,
    ]);
    expect(details.join('\n')).not.toContain('robot');
    expect(details.join('\n')).not.toContain('ghp_secret-token');
  });

  it('reports every check as an error when the SSH round trip itself fails', async () => {
    const checks = await runRemoteDoctorChecks({
      target: TARGET,
      repoUrl: REPO_URL,
      execRemoteCaptureImpl: failingCapture('ssh: connection refused'),
    });

    expect(checks.every((check) => check.status === 'error' || check.status === 'warn')).toBe(true);
    expect(checks.find((check) => check.id === 'git')?.status).toBe('error');
    expect(checks.some((check) => check.detail.includes('connection refused'))).toBe(true);
  });

  it('embeds the repo URL safely even if it contains shell metacharacters', async () => {
    const maliciousUrl = "https://example.com/'; rm -rf /;'.git";
    const stdout = 'check:git:ok\ncheck:node:ok\ncheck:pnpm:ok\ndisk_kb:5242880\ncheck:push-auth:ok';

    // The assertion here is just that this resolves without throwing while
    // constructing the script — real quoting correctness is exercised by
    // shellPosixSingleQuote's own tests in execution-engine.
    const checks = await runRemoteDoctorChecks({
      target: TARGET,
      repoUrl: maliciousUrl,
      execRemoteCaptureImpl: stubCapture(stdout),
    });

    expect(checks.find((check) => check.id === 'push-auth')?.status).toBe('ok');
  });
});
