import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const FILES = [
  path.resolve(__dirname, '..', 'main.ts'),
  path.resolve(__dirname, '..', 'headless.ts'),
];

const AUTO_START_CALLS = [
  'restartTask',
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
});
