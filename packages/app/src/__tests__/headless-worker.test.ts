import { describe, expect, it, vi } from 'vitest';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless, type HeadlessDeps } from '../headless.js';

function deps(): HeadlessDeps {
  return {
    invokerConfig: { externalWorkers: [] },
    persistence: {} as HeadlessDeps['persistence'],
    orchestrator: {} as HeadlessDeps['orchestrator'],
    executorRegistry: {} as HeadlessDeps['executorRegistry'],
    commandService: {} as HeadlessDeps['commandService'],
    repoRoot: '/repo',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as HeadlessDeps;
}

describe('headless worker command', () => {
  it('lists the PR summary refresh worker kind', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runHeadless(['worker', 'list'], deps());
      const output = write.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    } finally {
      write.mockRestore();
    }
  });
});
