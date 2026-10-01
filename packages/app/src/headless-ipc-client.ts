import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { IpcBus, TransportError, TransportErrorCode } from '@invoker/transport';

function usage(): never {
  process.stderr.write('Usage: headless-ipc-client --no-track run <plan.yaml>\n');
  process.exit(2);
}

function parseArgs(argv: string[]): { planPath: string; originalArgs: string[] } {
  const originalArgs = [...argv];
  const args = [...argv];
  const noTrackIndex = args.findIndex((arg) => arg === '--no-track' || arg === '--do-not-track');
  if (noTrackIndex === -1) usage();
  args.splice(noTrackIndex, 1);
  if (args[0] !== 'run' || !args[1] || args.length !== 2) usage();
  return { planPath: resolve(args[1]), originalArgs };
}

function createTraceId(): string {
  return `headless.run:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

function isNoOwnerError(error: unknown): boolean {
  return error instanceof TransportError && error.code === TransportErrorCode.NO_HANDLER;
}

function runFullHeadlessClient(args: string[]): number {
  const result = spawnSync(process.execPath, [resolve(__dirname, 'headless-client.js'), ...args], {
    cwd: resolve(__dirname, '..', '..', '..'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }
  if (result.signal) {
    process.stderr.write(`headless-client exited with signal ${result.signal}\n`);
    return 1;
  }
  return result.status ?? 0;
}

async function main(): Promise<number> {
  const { planPath, originalArgs } = parseArgs(process.argv.slice(2));
  const bus = new IpcBus(undefined, { allowServe: false });
  try {
    await bus.ready();
    const response = await bus.request<{ planPath: string; traceId: string; noTrack: true; ackOnly: true }, { workflowId?: unknown; ok?: unknown }>(
      'headless.run',
      { planPath, traceId: createTraceId(), noTrack: true, ackOnly: true },
    );
    const workflowId = typeof response?.workflowId === 'string' ? response.workflowId : undefined;
    if (!workflowId && response?.ok !== true) {
      throw new Error(`headless.run returned no workflowId: ${JSON.stringify(response)}`);
    }
    process.stdout.write(workflowId ? `Delegated to owner — workflow: ${workflowId}\n` : 'Delegated to owner\n');
    process.stdout.write('--no-track enabled: delegated submission accepted; exiting without tracking.\n');
    return 0;
  } catch (error) {
    if (isNoOwnerError(error)) {
      return runFullHeadlessClient(originalArgs);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    bus.disconnect();
  }
}

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
