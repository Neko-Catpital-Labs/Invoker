import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const FILES = [
  path.resolve(__dirname, '..', 'main.ts'),
  path.resolve(__dirname, '..', 'ipc', 'gui-mutation-handlers.ts'),
  path.resolve(__dirname, '..', 'headless.ts'),
];

const HEADLESS_RUN_RESUME = path.resolve(__dirname, '..', 'headless-run-resume.ts');

const AUTO_START_CALLS = [
  'retryTask',
  'retryWorkflow',
  'recreateTask',
  'recreateWorkflow',
  'resumeWorkflow',
];

describe('manual executeTasks guardrail', () => {
  it('forbids direct executeTasks after orchestrator auto-start calls', () => {
    for (const filePath of FILES) {
      const source = readFileSync(filePath, 'utf8');
      for (const method of AUTO_START_CALLS) {
        const antiPattern = new RegExp(
          `orchestrator\\.${method}\\([^)]*\\)[\\s\\S]{0,220}executeTasks\\(`,
          'm',
        );
        expect(
          antiPattern.test(source),
          `${path.basename(filePath)} contains manual executeTasks after orchestrator.${method}(). Dispatcher handles this.`,
        ).toBe(false);
      }
    }
  });

  it('keeps tracked headless run/resume on the launch outbox path', () => {
    const source = readFileSync(HEADLESS_RUN_RESUME, 'utf8');

    expect(source).not.toContain('await taskExecutor.executeTasks(started);');
    expect(source).not.toContain('await taskExecutor.executeTasks(allStarted);');
  });
});
