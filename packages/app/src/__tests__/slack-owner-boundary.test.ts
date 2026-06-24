import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function slackCommandHandlerSource(): string {
  const source = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('await slack.start(async (command: any) => {');
  const end = source.indexOf('\n  });\n\n  return slack;', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Slack owner mutation boundary', () => {
  it('routes task-control mutations through CommandService instead of direct orchestrator calls', () => {
    const handler = slackCommandHandlerSource();

    expect(handler).toContain('commandService.selectExperiment');
    expect(handler).toContain('commandService.provideInput');
    expect(handler).toContain('dispatchStartedTasksWithGlobalTopup');

    expect(handler).not.toMatch(/\borchestrator\.selectExperiment\s*\(/);
    expect(handler).not.toMatch(/\borchestrator\.provideInput\s*\(/);
  });
});
