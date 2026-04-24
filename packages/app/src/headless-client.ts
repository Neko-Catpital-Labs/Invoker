import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { IpcBus } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';

import { resolveInvokerHomeRoot } from './delete-all-snapshot.js';
import { isHeadlessMutatingCommand } from './headless-command-classification.js';
import {
  tryDelegateExec,
  tryDelegateQuery,
  tryDelegateQueryUiPerf,
  tryDelegateResume,
  tryDelegateRun,
  tryPingHeadlessOwner,
} from './headless-delegation.js';
import {
  spawnDetachedStandaloneOwner,
  tryAcquireOwnerBootstrapLock,
} from './headless-owner-bootstrap.js';
import { loadConfig } from './config.js';

const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function electronCommandArgs(args: string[]): string[] {
  const mainJs = resolve(__dirname, 'main.js');
  return [
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    mainJs,
    '--headless',
    ...args,
  ];
}

async function runElectronHeadless(args: string[]): Promise<number> {
  const electronBin = resolve(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const child = spawn(electronBin, electronCommandArgs(args), {
    cwd: resolve(__dirname, '..', '..', '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      LIBGL_ALWAYS_SOFTWARE: process.platform === 'linux' ? '1' : process.env.LIBGL_ALWAYS_SOFTWARE,
    },
  });
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`headless electron exited with signal ${signal}`));
        return;
      }
      resolveExit(code ?? 0);
    });
  });
}

async function delegateMutation(args: string[], bus: MessageBus, waitForApproval?: boolean, noTrack?: boolean): Promise<boolean> {
  const command = args[0];
  if (command === 'run') {
    const planPath = args[1];
    if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');
    return tryDelegateRun(planPath, bus, waitForApproval, noTrack);
  }
  if (command === 'resume') {
    const workflowId = args[1];
    if (!workflowId) throw new Error('Missing workflowId. Usage: --headless resume <id>');
    return tryDelegateResume(workflowId, bus, waitForApproval, noTrack);
  }
  return tryDelegateExec(args, bus, waitForApproval, noTrack);
}

async function delegateReadOnlyQuery(args: string[], bus: MessageBus): Promise<boolean> {
  const isUiPerf = args[0] === 'query' && args[1] === 'ui-perf';
  const isQueue = (args[0] === 'query' && args[1] === 'queue') || args[0] === 'queue';
  if (!isUiPerf && !isQueue) {
    return false;
  }
  const deadline = Date.now() + 8_000;
  let owner: { ownerId?: string; mode?: string } | null = null;
  while (Date.now() < deadline) {
    owner = await tryPingHeadlessOwner(bus, 2_000);
    if (owner) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!owner) {
    throw new Error(isUiPerf
      ? 'query ui-perf requires a running shared owner process'
      : 'query queue requires a running shared owner process');
  }
  let response: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    if (isUiPerf) {
      const reset = args.includes('--reset');
      response = await tryDelegateQueryUiPerf(bus, reset, 5_000);
    } else {
      response = await tryDelegateQuery(bus, { kind: 'queue' }, 5_000);
    }
    if (response) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!response) {
    throw new Error(isUiPerf
      ? 'Live owner is present but did not serve ui-perf query'
      : 'Live owner is present but did not serve queue query');
  }
  if (isUiPerf) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return true;
  }
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const running = Array.isArray(response.running) ? response.running as Array<Record<string, unknown>> : [];
  const queued = Array.isArray(response.queued) ? response.queued as Array<Record<string, unknown>> : [];
  if (output === 'json') {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } else if (output === 'jsonl') {
    for (const task of running) {
      process.stdout.write(`${JSON.stringify({ ...task, state: 'running' })}\n`);
    }
    for (const task of queued) {
      process.stdout.write(`${JSON.stringify({ ...task, state: 'queued' })}\n`);
    }
  } else if (output === 'label') {
    const ids = [...running, ...queued].map((task) => String(task.taskId ?? '')).filter(Boolean);
    process.stdout.write(`${ids.join('\n')}\n`);
  } else {
    const runningCount = Number(response.runningCount ?? running.length);
    const maxConcurrency = Number(response.maxConcurrency ?? 0);
    process.stdout.write(`running=${runningCount}/${maxConcurrency} queued=${queued.length}\n`);
  }
  return true;
}

export interface HeadlessClientDeps {
  messageBus: MessageBus;
  ensureStandaloneOwner: () => Promise<void>;
  runElectronHeadless: (args: string[]) => Promise<number>;
}

async function ensureStandaloneOwnerViaBootstrap(bus: MessageBus): Promise<void> {
  const invokerHomeRoot = resolveInvokerHomeRoot();
  const bootstrapLock = tryAcquireOwnerBootstrapLock(invokerHomeRoot);
  try {
    if (bootstrapLock) {
      spawnDetachedStandaloneOwner(resolve(__dirname, '..', '..', '..'));
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const owner = await tryPingHeadlessOwner(bus, 500);
      if (owner) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    throw new Error('Timed out waiting for a shared mutation owner to become available');
  } finally {
    bootstrapLock?.release();
  }
}

function parseArgs(argv: string[]): { args: string[]; waitForApproval?: boolean; noTrack?: boolean } {
  const args: string[] = [];
  let waitForApproval = false;
  let noTrack = false;
  for (const arg of argv) {
    if (arg === '--wait-for-approval') {
      waitForApproval = true;
    } else if (arg === '--no-track' || arg === '--do-not-track') {
      noTrack = true;
    } else {
      args.push(arg);
    }
  }
  return { args, waitForApproval, noTrack };
}

export async function runHeadlessClientCommand(
  argv: string[],
  deps: HeadlessClientDeps,
): Promise<number> {
  // Validate config before any delegation path so malformed JSON fails fast
  // even for commands that do not boot the full Electron owner process.
  loadConfig();

  const { args, waitForApproval, noTrack } = parseArgs(argv);
  const standaloneMode = process.env.INVOKER_HEADLESS_STANDALONE === '1';
  const internalOwnerServe = args[0] === 'owner-serve';
  const resolvedExitCode = (): number => {
    const exitCode = process.exitCode;
    return typeof exitCode === 'number' ? exitCode : 0;
  };

  if (!standaloneMode && !internalOwnerServe && await delegateReadOnlyQuery(args, deps.messageBus)) {
    return resolvedExitCode();
  }

  if (!isHeadlessMutatingCommand(args) || standaloneMode || internalOwnerServe) {
    return deps.runElectronHeadless(argv);
  }

  const owner = await tryPingHeadlessOwner(deps.messageBus, 3_000);
  if (owner) {
    if (await delegateMutation(args, deps.messageBus, waitForApproval, noTrack)) {
      return resolvedExitCode();
    }
  }
  await deps.ensureStandaloneOwner();
  if (await delegateMutation(args, deps.messageBus, waitForApproval, noTrack)) {
    return resolvedExitCode();
  }
  process.stderr.write(
    `${RED}Error:${RESET} Mutation command "${args[0] ?? ''}" could not reach a shared owner after bootstrap.\n`,
  );
  return 1;
}

export async function runHeadlessClient(argv: string[]): Promise<number> {
  const bus = new IpcBus(undefined, { allowServe: false });
  try {
    await bus.ready();
    return await runHeadlessClientCommand(argv, {
      messageBus: bus,
      ensureStandaloneOwner: () => ensureStandaloneOwnerViaBootstrap(bus),
      runElectronHeadless,
    });
  } finally {
    bus.disconnect();
  }
}

if (require.main === module) {
  runHeadlessClient(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
