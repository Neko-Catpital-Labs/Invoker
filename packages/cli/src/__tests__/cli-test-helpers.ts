import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { vi } from 'vitest';

export const repoRoot = resolve(__dirname, '../../../..');
export const cliPath = resolve(repoRoot, 'packages/cli/dist/index.js');
export const fixturePlan = resolve(repoRoot, 'plans/fixtures/hello-world.yaml');

export function writeStandalonePlan(dir: string, body: string): string {
  const planPath = join(dir, 'plan.yaml');
  writeFileSync(planPath, body.replace('__REPO_ROOT__', JSON.stringify(repoRoot)), 'utf8');
  return planPath;
}

export function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

export function mkCliTempDir(prefix: string): string {
  return join(tmpdir(), prefix);
}

export function captureProcessOutput() {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += chunk.toString();
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += chunk.toString();
    return true;
  });
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}
