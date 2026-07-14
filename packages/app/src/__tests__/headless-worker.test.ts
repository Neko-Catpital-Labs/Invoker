import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

describe('headless worker registry', () => {
  let stdout = '';
  const writes: MockInstance[] = [];

  afterEach(() => {
    while (writes.length > 0) {
      writes.pop()?.mockRestore();
    }
    stdout = '';
  });

  it('lists the PR summary refresh worker for manual one-shot runs', async () => {
    writes.push(vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }));

    await runHeadless(['worker', 'list'], { invokerConfig: {} } as never);

    expect(stdout).toContain('Worker kinds');
    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
  });
});
