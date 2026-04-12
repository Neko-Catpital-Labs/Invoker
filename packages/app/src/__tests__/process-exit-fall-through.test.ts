import { describe, expect, it } from 'vitest';

describe('process.exit fall-through semantics in async control flow', () => {
  it('continues execution without an explicit return when process.exit is intercepted', async () => {
    const originalExit = process.exit;
    let continued = false;

    (process as NodeJS.Process).exit = ((_: number) => {
      // Intentionally no-op to simulate Electron/embedded interception in tests.
    }) as typeof process.exit;

    try {
      const withoutReturn = async (): Promise<void> => {
        process.exit(0);
        continued = true;
      };

      await withoutReturn();
      expect(continued).toBe(true);
    } finally {
      (process as NodeJS.Process).exit = originalExit;
    }
  });

  it('stops local control flow when return is placed after process.exit', async () => {
    const originalExit = process.exit;
    let continued = false;

    (process as NodeJS.Process).exit = ((_: number) => {
      // Intentionally no-op to simulate Electron/embedded interception in tests.
    }) as typeof process.exit;

    try {
      const withReturn = async (): Promise<void> => {
        process.exit(0);
        return;
        continued = true;
      };

      await withReturn();
      expect(continued).toBe(false);
    } finally {
      (process as NodeJS.Process).exit = originalExit;
    }
  });
});
