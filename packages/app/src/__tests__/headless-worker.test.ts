import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHeadless, type HeadlessDeps } from '../headless.js';

describe('headless worker command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the PR summary refresh worker', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    });

    await runHeadless(['worker', 'list'], {
      invokerConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as HeadlessDeps);

    expect(output).toContain('pr-summary-refresh');
    expect(output).toContain('Refreshes review PR bodies');
  });
});
