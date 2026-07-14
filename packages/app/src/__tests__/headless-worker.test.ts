import { describe, expect, it, vi } from 'vitest';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

describe('headless worker registry', () => {
  it('lists the PR summary refresh worker kind', async () => {
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });

    try {
      await runHeadless(['worker', 'list'], { invokerConfig: {} } as never);
    } finally {
      write.mockRestore();
    }

    expect(stdout).toContain('Worker kinds');
    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
  });
});
