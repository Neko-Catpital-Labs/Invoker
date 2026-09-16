import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { runRepoLocalPrBodyChecker } from '../pr-authoring.js';

const target = process.env.CATSTACK_PR_REPAIR_REPO;
const rejectedSummary = 'Put the build-the-lever hook onto shared code. Read docs/hook-architecture.md and run `python3 -m unittest discover -s engine/hooks/build-the-lever/tests`.';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(paths = ['engine/hooks/build-the-lever/run.py'], provisioned = true) {
  if (!target) throw new Error('Set CATSTACK_PR_REPAIR_REPO to a provisioned Catstack checkout.');
  const cwd = mkdtempSync(join(tmpdir(), 'pr-authoring-catstack-'));
  directories.push(cwd);
  for (const path of [
    'drafter.config.json',
    'scripts/validate-pr-body-local.mjs',
    'engine/skills/make-pr/scripts/preflight.py',
    'engine/skills/draft-pr/scripts/validate-pr-body.mjs',
    'engine/skills/draft-pr/scripts/summary-reading-grade.mjs',
  ]) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    copyFileSync(join(target, path), join(cwd, path));
    expect(readFileSync(join(cwd, path))).toEqual(readFileSync(join(target, path)));
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'PR regression');
  git('config', 'user.email', 'pr-regression@example.test');
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n');
  git('add', '.');
  git('commit', '-m', 'unchanged repository checks');
  git('switch', '-c', 'repair');
  for (const path of paths) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), 'recorded change\n');
  }
  git('add', '.');
  git('commit', '-m', 'proposed work');
  if (provisioned) symlinkSync(join(target, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  return cwd;
}

async function author(cwd: string, withAgents: boolean) {
  const skillRoot = mkdtempSync(join(tmpdir(), 'pr-authoring-skills-'));
  directories.push(skillRoot);
  mkdirSync(join(skillRoot, 'invoker-make-pr'), { recursive: true });
  writeFileSync(join(skillRoot, 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');
  const agents = ['expired-oauth', 'usage-limit'].map((name) => ({
    name,
    stdinMode: 'ignore' as const,
    bundledSkillRoot: skillRoot,
    bundledSkills: ['make-pr'],
    buildCommand: vi.fn(() => ({ cmd: process.execPath, args: ['-e', `console.error(${JSON.stringify(name)}); process.exit(1)`] })),
    buildResumeArgs: () => ({ cmd: process.execPath, args: [] }),
  }));
  const runner = new TaskRunner({
    orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
    persistence: {} as any,
    executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
    ...(withAgents ? { executionAgentRegistry: {
      get: (name: string) => agents.find((agent) => agent.name === name),
      getSessionDriver: () => undefined,
      listWithCapability: () => agents,
    } as any } : {}),
    cwd,
  });
  const result = await runner.authorPrBodyWithSkill({
    title: 'Hook migration', baseBranch: 'main', featureBranch: 'repair', cwd,
    repoUrl: 'https://github.com/EdbertChan/catstack',
    workflowSummary: rejectedSummary,
    structuredContext: { workflowDescription: rejectedSummary, tasks: [
      { taskId: 'check', description: 'Recorded check', status: 'completed', command: 'python3 -m unittest discover -s engine/hooks/build-the-lever/tests' },
    ] },
  });
  if (withAgents) for (const agent of agents) expect(agent.buildCommand).toHaveBeenCalledOnce();
  return result;
}

describe.skipIf(!target)('Catstack fallback contract (CATSTACK_PR_REPAIR_REPO required)', () => {
  it.each([true, false])('validates real fallback with failing agents=%s', async (withAgents) => {
    const cwd = fixture();
    const result = await author(cwd, withAgents);
    expect(result.agentName).toBe('canonical');
    expect(await runRepoLocalPrBodyChecker({ body: result.body, cwd, baseBranch: 'main' })).toEqual([]);
    expect(result.body).toContain('## Review Unit\n\nengine-runtime');
    expect(result.body).toContain(rejectedSummary);
    expect(result.body).toContain('- [x] `python3 -m unittest discover -s engine/hooks/build-the-lever/tests`');
  });

  it('derives a different unit from the changed paths', async () => {
    const cwd = fixture(['product/skills/example/SKILL.md']);
    const result = await author(cwd, false);
    expect(result.body).toContain('## Review Unit\n\nproduct-skill');
    expect(await runRepoLocalPrBodyChecker({ body: result.body, cwd, baseBranch: 'main' })).toEqual([]);
  });

  it('fails explicitly for ambiguous units', async () => {
    const cwd = fixture(['engine/hooks/example/run.py', 'product/skills/example/SKILL.md']);
    await expect(author(cwd, false)).rejects.toThrow(/ambiguous.*review unit/i);
  });

  it.each([true, false])('blocks missing drafter-core with failing agents=%s', async (withAgents) => {
    const cwd = fixture(undefined, false);
    await expect(author(cwd, withAgents)).rejects.toThrow(/drafter-core/);
  });
});
