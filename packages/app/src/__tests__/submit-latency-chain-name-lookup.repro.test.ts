import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'submit-workflow-chain.sh');
const STEP_ONE_NAME = 'repeated-chain-name';
const STEP_TWO_NAME = 'downstream-chain-name';
const EXPECTED_UPSTREAM_WORKFLOW_ID = 'wf-A';
const WORKFLOW_DUMP_BUDGET = 2;

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

type FakeCall = {
  event?: string;
  args?: string[];
  injectedWorkflowId?: string | null;
};

function readJsonLines(path: string): FakeCall[] {
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map((line) => JSON.parse(line) as FakeCall);
}

function makePlanFiles(root: string): { first: string; second: string } {
  const planDir = join(root, 'plans');
  mkdirSync(planDir, { recursive: true });

  const first = join(planDir, 'one.yaml');
  const second = join(planDir, 'two.template.yaml');

  writeFileSync(
    first,
    [
      `name: ${STEP_ONE_NAME}`,
      'baseBranch: main',
      'tasks:',
      '  - id: one',
      '    prompt: first step',
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    second,
    [
      `name: ${STEP_TWO_NAME}`,
      'baseBranch: main',
      'externalDependencies:',
      '  - workflowId: "__UPSTREAM_WORKFLOW_ID__"',
      'tasks:',
      '  - id: two',
      '    prompt: second step',
      '',
    ].join('\n'),
    'utf8',
  );

  return { first, second };
}

function makeFakeInvokerCli(binDir: string): string {
  const fakeCli = join(binDir, 'invoker-cli');
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);
const callLog = process.env.INVOKER_FAKE_CALL_LOG;
const stepOneName = process.env.INVOKER_FAKE_STEP_ONE_NAME;
const stepTwoName = process.env.INVOKER_FAKE_STEP_TWO_NAME;

function record(entry) {
  fs.appendFileSync(callLog, JSON.stringify({ args, ...entry }) + '\\n');
}

function workflowDump() {
  return [
    {
      id: 'wf-ROOT',
      name: 'root-workflow',
      status: 'running',
      baseBranch: 'main',
      featureBranch: 'feature/root',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z'
    },
    {
      id: 'wf-A',
      name: stepOneName,
      status: 'running',
      baseBranch: 'feature/root',
      featureBranch: 'feature/wf-a',
      createdAt: '2026-09-14T00:00:01.000Z',
      updatedAt: '2026-09-14T00:00:01.000Z'
    },
    {
      id: 'wf-B',
      name: stepOneName,
      status: 'running',
      baseBranch: 'feature/root',
      featureBranch: 'feature/wf-b',
      createdAt: '2026-09-14T00:00:02.000Z',
      updatedAt: '2026-09-14T00:00:02.000Z'
    },
    {
      id: 'wf-C',
      name: stepTwoName,
      status: 'running',
      baseBranch: 'feature/wf-b',
      featureBranch: 'feature/wf-c',
      createdAt: '2026-09-14T00:00:03.000Z',
      updatedAt: '2026-09-14T00:00:03.000Z'
    }
  ];
}

if (args[0] === 'query' && args[1] === 'workflows') {
  record({ event: 'query-workflows' });
  process.stdout.write(JSON.stringify(workflowDump()) + '\\n');
  process.exit(0);
}

if (args[0] === 'query' && args[1] === 'tasks') {
  record({ event: 'query-tasks' });
  process.stdout.write(JSON.stringify([
    { id: '__merge__wf-A', workflowId: 'wf-A', status: 'completed' },
    { id: '__merge__wf-B', workflowId: 'wf-B', status: 'completed' }
  ]) + '\\n');
  process.exit(0);
}

if (args[0] === 'run') {
  const planPath = args[1];
  const plan = fs.readFileSync(planPath, 'utf8');
  const injectedWorkflowId = /workflowId:\\s*"?((?:wf-)[^"\\s]+)"?/.exec(plan)?.[1] ?? null;
  record({ event: 'run', planPath, injectedWorkflowId });
  process.stdout.write(JSON.stringify({ workflow: { id: 'wf-A' } }) + '\\n');
  process.exit(0);
}

record({ event: 'unknown' });
process.stderr.write('unexpected invoker-cli args: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    'utf8',
  );
  chmodSync(fakeCli, 0o755);
  return fakeCli;
}

describe('submit-workflow-chain workflow id resolution repro', () => {
  it('uses the workflow id printed by the submitted upstream run within the workflow dump budget', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'invoker-chain-name-lookup-'));
    const home = join(tempDir, 'home');
    const binDir = join(tempDir, 'bin');
    const tmp = join(tempDir, 'tmp');
    const configDir = join(home, '.invoker');
    const callLog = join(tempDir, 'fake-invoker-cli.calls.jsonl');
    const dbPath = join(tempDir, 'invoker.db');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), '{}\n', 'utf8');
    writeFileSync(callLog, '', 'utf8');
    makeFakeInvokerCli(binDir);
    const plans = makePlanFiles(tempDir);

    const result = spawnSync(
      'bash',
      [SCRIPT_PATH, '--onto-workflow', 'wf-ROOT', plans.first, plans.second],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          INVOKER_DB_PATH: dbPath,
          INVOKER_REPO_CONFIG_PATH: join(configDir, 'config.json'),
          INVOKER_FAKE_CALL_LOG: callLog,
          INVOKER_FAKE_STEP_ONE_NAME: STEP_ONE_NAME,
          INVOKER_FAKE_STEP_TWO_NAME: STEP_TWO_NAME,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          TMPDIR: tmp,
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );

    const calls = readJsonLines(callLog);
    const workflowDumpCount = calls.filter((call) => call.event === 'query-workflows').length;
    const injectedWorkflowId =
      calls.filter((call) => call.event === 'run').find((call) => call.injectedWorkflowId)
        ?.injectedWorkflowId ?? null;
    const measured = `measured injectedWorkflowId=${injectedWorkflowId ?? '<none>'}; fullWorkflowDumps=${workflowDumpCount}; budget<=${WORKFLOW_DUMP_BUDGET}; stdout=${JSON.stringify(result.stdout)}; stderr=${JSON.stringify(result.stderr)}`;

    expect(result.status, `chain script should complete so the repro can measure it; ${measured}`).toBe(0);

    expect(
      injectedWorkflowId,
      `chain script should inject the workflow id printed by the upstream run; ${measured}`,
    ).toBe(EXPECTED_UPSTREAM_WORKFLOW_ID);
    expect(
      workflowDumpCount,
      `chain script should stay within one full workflows dump per chain step; ${measured}`,
    ).toBeLessThanOrEqual(WORKFLOW_DUMP_BUDGET);
  });
});
