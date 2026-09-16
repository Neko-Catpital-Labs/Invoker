import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { loadPlanSubmissionBundle } from '../plan-submission-loader.js';

const BUDGET_MS = 200;
const SAMPLES = 3;
const TASK_COUNTS = [10, 100, 500] as const;
const testHome = mkdtempSync(join(tmpdir(), 'invoker-huge-plan-home-'));
const tempDirs: string[] = [];

vi.stubEnv('HOME', testHome);

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(testHome, { recursive: true, force: true });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makePlan(taskCount: number, repoUrl: string): string {
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const dependency = index === 0 ? '' : `\n    dependencies: [task-${index - 1}]`;
    return `  - id: task-${index}\n    description: Task ${index}\n    command: echo task-${index}${dependency}`;
  }).join('\n');
  return `name: huge-plan-${taskCount}\nrepoUrl: ${repoUrl}\nbaseBranch: master\nfeatureBranch: repro/huge-plan-${taskCount}\nonFinish: none\ntasks:\n${tasks}\n`;
}

async function sample(taskCount: number, repoUrl: string): Promise<{ elapsedMs: number; writeCount: number }> {
  const dir = mkdtempSync(join(tmpdir(), `invoker-huge-plan-${taskCount}-`));
  tempDirs.push(dir);
  const persistence = await SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true });
  const orchestrator = new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    maxConcurrency: 1,
    resolveRepoDefaultBranch: () => 'master',
  });
  const saveWorkflow = vi.spyOn(persistence, 'saveWorkflow');
  const saveTask = vi.spyOn(persistence, 'saveTask');
  const logEvent = vi.spyOn(persistence, 'logEvent');
  const ownerSubmit = (planText: string) => loadPlanSubmissionBundle(planText, {
    persistence,
    orchestrator,
    allowGraphMutation: true,
  });

  const started = performance.now();
  await ownerSubmit(makePlan(taskCount, repoUrl));
  const elapsedMs = performance.now() - started;
  const writeCount = saveWorkflow.mock.calls.length + saveTask.mock.calls.length + logEvent.mock.calls.length;
  persistence.close();
  return { elapsedMs, writeCount };
}

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe('huge plan submission latency repro', () => {
  it('measures owner intake acknowledgement and persistence write scale', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'invoker-huge-plan-bare-repo-'));
    tempDirs.push(repoDir);
    execFileSync('git', ['init', '--bare', repoDir], { stdio: 'ignore' });

    const results = new Map<number, { p50Ms: number; writeCount: number; samples: number[] }>();
    for (const taskCount of TASK_COUNTS) {
      const samples = [];
      let writeCount = 0;
      for (let index = 0; index < SAMPLES; index++) {
        const result = await sample(taskCount, repoDir);
        samples.push(result.elapsedMs);
        writeCount = result.writeCount;
      }
      const measuredP50 = p50(samples);
      results.set(taskCount, { p50Ms: measuredP50, writeCount, samples });
      console.log(`huge-plan repro tasks=${taskCount} samples=${samples.map((ms) => ms.toFixed(2)).join(',')} p50Ms=${measuredP50.toFixed(2)} writes=${writeCount}`);
    }

    const huge = results.get(500)!;
    console.log(`huge-plan repro 500-task persistence writes=${huge.writeCount}`);
    const expectation = process.env.INVOKER_REPRO_EXPECT === 'bug' ? 'over' : 'under';
    const message = `500-task intake p50=${huge.p50Ms.toFixed(2)}ms, tasks=500, writes=${huge.writeCount}, budget=${BUDGET_MS}ms; expected ${expectation}`;
    if (expectation === 'over') {
      expect(huge.p50Ms, message).toBeGreaterThan(BUDGET_MS);
    } else {
      expect(huge.p50Ms, message).toBeLessThan(BUDGET_MS);
    }
  }, 120_000);
});
