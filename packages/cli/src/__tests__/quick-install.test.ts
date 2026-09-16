import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatQuickInstallDemoTranscript,
  QUICK_INSTALL_NPM_PACKAGES,
  QUICK_INSTALL_WORKER_IDS,
  REQUIRED_NODE_MAJOR,
  runInstall,
} from '../quick-install.js';

describe('runInstall', () => {
  const lines: string[] = [];
  const io = { print: (line: string) => { lines.push(line); } };
  let prevDbDir: string | undefined;
  let prevConfigPath: string | undefined;
  let tempRoot = '';

  beforeEach(() => {
    lines.length = 0;
    tempRoot = mkdtempSync(join(tmpdir(), 'invoker-quick-install-'));
    prevDbDir = process.env.INVOKER_DB_DIR;
    prevConfigPath = process.env.INVOKER_REPO_CONFIG_PATH;
    process.env.INVOKER_DB_DIR = tempRoot;
    process.env.INVOKER_REPO_CONFIG_PATH = join(tempRoot, 'config.json');
  });

  afterEach(() => {
    if (prevDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = prevDbDir;
    if (prevConfigPath === undefined) delete process.env.INVOKER_REPO_CONFIG_PATH;
    else process.env.INVOKER_REPO_CONFIG_PATH = prevConfigPath;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('prints demo transcript without side effects', async () => {
    const code = await runInstall(['--demo'], io, {
      npmInstallGlobal: () => {
        throw new Error('npm should not run in --demo');
      },
    });
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('Slack: skipped');
    expect(out).toContain('Remote machines: skipped');
    expect(out).toContain(`Workers on: ${QUICK_INSTALL_WORKER_IDS.join(', ')}`);
    expect(out).toBe(formatQuickInstallDemoTranscript().trimEnd());
  });

  it('fails when Node major is wrong', async () => {
    const code = await runInstall([], io, {
      nodeMajor: () => 22,
      npmInstallGlobal: () => {
        throw new Error('npm should not run');
      },
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(`Node.js ${REQUIRED_NODE_MAJOR}.x is required`);
  });

  it('fails when npm install -g fails', async () => {
    const code = await runInstall([], io, {
      nodeMajor: () => REQUIRED_NODE_MAJOR,
      npmInstallGlobal: () => ({ status: 1, stdout: '', stderr: 'npm ERR boom' }),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('npm install -g failed');
    expect(lines.join('\n')).toContain('npm ERR boom');
  });

  it('skips Slack/machines, enables quick-install workers, and soft-fails doctor/smoke', async () => {
    let npmPackages: readonly string[] | undefined;
    let doctorCalled = false;
    let skillsCalled = false;
    const code = await runInstall([], io, {
      nodeMajor: () => REQUIRED_NODE_MAJOR,
      npmInstallGlobal: (packages) => {
        npmPackages = packages;
        return { status: 0, stdout: 'ok', stderr: '' };
      },
      runDoctorFix: () => {
        doctorCalled = true;
        return 1;
      },
      bundledSkillsInstall: () => {
        skillsCalled = true;
        return {
          available: true,
          promptRecommended: false,
          managedPrefix: 'invoker-',
          bundledSkillNames: ['chat-submit'],
          targets: [{ name: 'cursor', installed: true, path: '/tmp' }],
          commandTargets: [],
          mcpTargets: [{ name: 'cursor', installed: true, path: '/tmp' }],
        };
      },
      resolveSkillsRepoRoot: () => '/fake-repo',
      resolveStandaloneSkillsRoot: () => null,
      enableQuickInstallWorkers: async () => [...QUICK_INSTALL_WORKER_IDS],
      collectGithubAndSmoke: async () => [
        {
          id: 'github-auth',
          name: 'GitHub auth',
          status: 'error',
          detail: 'not logged in',
        },
      ],
    });
    expect(code).toBe(0);
    expect(npmPackages).toEqual([...QUICK_INSTALL_NPM_PACKAGES]);
    expect(doctorCalled).toBe(true);
    expect(skillsCalled).toBe(true);
    const out = lines.join('\n');
    expect(out).toContain('Slack: skipped');
    expect(out).toContain('Remote machines: skipped');
    expect(out).toContain('Workers on: pr-status, autofix, auto-approve');
    expect(out).toContain('Doctor finished with gaps');
    expect(out).toContain('Report-only');
    expect(out).not.toContain('SLACK_BOT_TOKEN');
  });
});
