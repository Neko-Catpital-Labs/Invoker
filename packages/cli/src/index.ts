const VERSION = '0.1.4';

export const CLI_SET_FIELDS: readonly string[] = [
  'command',
  'prompt',
  'pool',
  'executor',
  'agent',
  'model',
  'task-pool',
  'fix-prompt',
  'fix-context',
  'gate-policy',
  'task',
];

type CliDeps = {
  createMessageBus?: () => Promise<unknown> | unknown;
  runMcpServer?: () => Promise<void>;
  resolveOwnerLaunchSpec?: (repoRoot: string) => unknown;
  spawnProcess?: unknown;
};

type WaitOptions = {
  workflowId: string;
  maxWaitMs: number;
  pollIntervalMs: number;
};

const DEFAULT_WAIT_MAX_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WAIT_POLL_MS = 5_000;

function parsePositiveIntFlag(flag: string, value: string | undefined): number {
  if (!value) throw new Error(`Missing value for ${flag}`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`Invalid ${flag} value. Expected a positive integer.`);
  }
  return parsed;
}

export function parseWaitArgs(argv: string[]): WaitOptions {
  let workflowId: string | undefined;
  let maxWaitMs = DEFAULT_WAIT_MAX_MS;
  let pollIntervalMs = DEFAULT_WAIT_POLL_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-wait-ms') {
      maxWaitMs = parsePositiveIntFlag('--max-wait-ms', argv[++i]);
    } else if (arg === '--poll-interval-ms') {
      pollIntervalMs = parsePositiveIntFlag('--poll-interval-ms', argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('Usage: invoker-cli wait <workflowId> [--max-wait-ms <ms>] [--poll-interval-ms <ms>]');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown wait option: ${arg}`);
    } else if (!workflowId) {
      workflowId = arg;
    } else {
      throw new Error(`Unexpected wait argument: ${arg}`);
    }
  }

  if (!workflowId) {
    throw new Error('Missing workflowId. Usage: invoker-cli wait <workflowId> [--max-wait-ms <ms>] [--poll-interval-ms <ms>]');
  }

  return { workflowId, maxWaitMs, pollIntervalMs };
}

async function runRuntimeMain(argv: string[], deps: CliDeps): Promise<number> {
  const runtime = await import('./cli-runtime.js');
  return runtime.main(argv, deps as Parameters<typeof runtime.main>[1]);
}

export async function main(argv: string[] = process.argv.slice(2), deps: CliDeps = {}): Promise<number> {
  try {
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    return await runRuntimeMain(argv, deps);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const entryUrl = process.argv[1] ? `file://${process.argv[1]}` : '';

if (import.meta.url === entryUrl) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
