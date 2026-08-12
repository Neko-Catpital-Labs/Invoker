import { execFileSync, spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { flushStdoutAndStderr, writeStdoutFlushAndExit } from '../headless-stdout-flush.js';

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

// Mirrors writeOut()'s raw process.stdout.write() in headless-query-list.ts
// followed immediately by process.exit() in main.ts's standalone exit path.
// Model the OS pipe backpressure deterministically: the write callback is
// pending when process.exit() runs, so any real pipe payload may be dropped.
const buggyScript = `
let callbackRan = false;
process.stdout.write = (chunk, encoding, callback) => {
  const cb = typeof encoding === 'function' ? encoding : callback;
  setTimeout(() => {
    callbackRan = true;
    process.stderr.write('write callback ran\\n');
    if (cb) cb();
  }, 25);
  return false;
};
process.on('exit', () => {
  process.stderr.write(callbackRan ? 'callback-before-exit\\n' : 'exit-before-callback\\n');
});
process.stdout.write('payload', () => {
  callbackRan = true;
});
process.exit(0);
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

  it('reproduces the live incident: raw write + immediate exit does not wait for stdout', () => {
    const output = spawnSync(process.execPath, ['-e', buggyScript], { encoding: 'utf8' });

    expect(output.status).toBe(0);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('exit-before-callback');
    expect(output.stderr).not.toContain('write callback ran');
  });

  it('flushStdoutAndStderr resolves only after both streams drain', async () => {
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    let stdoutCallback: (() => void) | undefined;
    let stderrCallback: (() => void) | undefined;

    process.stdout.write = ((_: string, callback?: () => void) => {
      stdoutCallback = callback;
      return false;
    }) as typeof process.stdout.write;
    process.stderr.write = ((_: string, callback?: () => void) => {
      stderrCallback = callback;
      return false;
    }) as typeof process.stderr.write;

    try {
      let resolved = false;
      const pending = flushStdoutAndStderr().then(() => { resolved = true; });

      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(stdoutCallback).toBeDefined();
      expect(stderrCallback).toBeDefined();

      stdoutCallback?.();
      await Promise.resolve();
      expect(resolved).toBe(false); // stderr hasn't drained yet

      stderrCallback?.();
      await pending;
      expect(resolved).toBe(true);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
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
