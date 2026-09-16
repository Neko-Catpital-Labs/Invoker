import { cancelOwnedStartupChild, type ExecutorStartup } from './executor.js';
import { spawn, type ChildProcess } from 'node:child_process';

import { traceExecution } from './exec-trace.js';
import { cleanElectronEnv, killProcessGroup, SIGKILL_TIMEOUT_MS } from './process-utils.js';

const PROVISION_OUTPUT_TAIL_LINE_LIMIT = 50;
const PROVISION_OUTPUT_TAIL_CHAR_LIMIT = 32_000;

export function appendProvisionOutputTail(tail: string, text: string): string {
  const segments = `${tail}${text}`.split('\n');
  const segmentLimit = segments.at(-1) === ''
    ? PROVISION_OUTPUT_TAIL_LINE_LIMIT + 1
    : PROVISION_OUTPUT_TAIL_LINE_LIMIT;
  const nextTail = segments.slice(-segmentLimit).join('\n');
  return nextTail.length <= PROVISION_OUTPUT_TAIL_CHAR_LIMIT
    ? nextTail
    : nextTail.slice(nextTail.length - PROVISION_OUTPUT_TAIL_CHAR_LIMIT);
}

export function spawnLocalProvisioning(options: {
  command: string;
  cwd: string;
  traceLabel: string;
  failurePrefix: string;
  timeoutMs: number;
  onOutput?: (text: string) => void;
  startup?: ExecutorStartup;
}): { child: ChildProcess | null; completion: Promise<void> } {
  options.startup?.check();
  const command = options.command.trim();
  if (!command) {
    traceExecution(`[${options.traceLabel}] skipped dir=${options.cwd}`);
    return { child: null, completion: Promise.resolve() };
  }
  traceExecution(`[${options.traceLabel}] begin dir=${options.cwd}`);
  const child = spawn('/bin/bash', ['-lc', command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: options.cwd,
    detached: true,
    env: cleanElectronEnv(),
  });
  cancelOwnedStartupChild(child, options.startup);
  let combinedOutputTail = '';
  const appendOutput = (chunk: Buffer | string): void => {
    const text = String(chunk);
    combinedOutputTail = appendProvisionOutputTail(combinedOutputTail, text);
    options.onOutput?.(text);
  };
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let timedOutMessage: string | undefined;
  const finish = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(forceKillTimeout);
    fn();
  };
  const completion = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      finish(() => reject(new Error(`${options.failurePrefix} ${error.message}`)));
    });
    child.on('close', (code, signal) => {
      finish(() => {
        try { options.startup?.check(); } catch (error) { reject(error); return; }
        if (code === 0) {
          traceExecution(`[${options.traceLabel}] done dir=${options.cwd}`);
          resolve();
          return;
        }
        const tail = combinedOutputTail.trim();
        const fallback = timedOutMessage
          ?? `provision command exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`;
        const detail = tail ? `${fallback}\n${tail}` : fallback;
        reject(new Error(`${options.failurePrefix} ${detail}`));
      });
    });
    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (settled) return;
        timedOutMessage = `provision command timed out after ${options.timeoutMs}ms`;
        killProcessGroup(child, 'SIGTERM');
        forceKillTimeout = setTimeout(() => {
          if (!settled) killProcessGroup(child, 'SIGKILL');
          finish(() => {
            const tail = combinedOutputTail.trim();
            const detail = tail ? `${timedOutMessage!}\n${tail}` : timedOutMessage!;
            reject(new Error(`${options.failurePrefix} ${detail}`));
          });
        }, SIGKILL_TIMEOUT_MS);
        forceKillTimeout.unref?.();
      }, options.timeoutMs);
      timeout.unref?.();
    }
  });
  return { child, completion };
}
