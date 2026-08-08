import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { writeStdoutFlushAndExit } from '../headless-stdout-flush.js';

const buildPayload = (): string => JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({
  id: `wf-${i}`,
  description: `synthetic workflow row ${i} padded-padded-padded-padded-padded-padded-padded-padded`,
  status: 'completed',
})));

const script = `
const payload = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({
  id: 'wf-' + i,
  description: 'synthetic workflow row ' + i + ' padded-padded-padded-padded-padded-padded-padded-padded',
  status: 'completed',
})));
process.stdout.write(payload, () => { process.exitCode = 0; });
`;

describe('headless stdout flush', () => {
  it('preserves large JSON stdout when the child waits for the write callback', () => {
    const payload = buildPayload();
    expect(payload.length).toBeGreaterThanOrEqual(250 * 1024);

    for (let trial = 0; trial < 5; trial += 1) {
      const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
      expect(output.length).toBe(payload.length);
      expect(() => JSON.parse(output)).not.toThrow();
    }
  });

  it('invokes the injected exit fn only after the flush resolves', async () => {
    const originalWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    let capturedCallback: (() => void) | undefined;
    const exitCalls: number[] = [];

    process.exitCode = undefined;
    process.stdout.write = ((_: string, callback?: () => void) => {
      capturedCallback = callback;
      return false;
    }) as typeof process.stdout.write;

    try {
      const pending = writeStdoutFlushAndExit('payload', (code) => {
        exitCalls.push(code);
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(exitCalls).toEqual([]);
      expect(capturedCallback).toBeDefined();

      capturedCallback?.();
      await pending;

      expect(exitCalls).toEqual([0]);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
  });
});
