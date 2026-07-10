import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

describe('headless worker registry', () => {
  let write: MockInstance;
  let stdout: string;

  beforeEach(() => {
    stdout = '';
    write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    write.mockRestore();
  });

  it('lists the pr-summary-refresh worker from the manual worker entrypoint', async () => {
    await runHeadless(['worker', 'list'], { invokerConfig: {} } as never);

    expect(stdout).toContain('Worker kinds');
    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
  });
});
