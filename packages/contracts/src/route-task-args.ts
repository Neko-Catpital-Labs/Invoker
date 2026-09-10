export const ROUTE_TASK_RUNNER_KINDS = ['worktree', 'ssh'] as const;

export type RouteTaskRunnerKind = (typeof ROUTE_TASK_RUNNER_KINDS)[number];

export const ROUTE_TASK_USAGE =
  'Usage: invoker-cli route-task <taskId> [--agent <name>] [--pool <id>] [--runner worktree|ssh] [--clear-member] [--force]';

export interface RouteTaskArgs {
  readonly taskId: string;
  readonly agent?: string;
  readonly poolId?: string;
  readonly runnerKind?: RouteTaskRunnerKind;
  readonly clearMember: boolean;
  readonly force: boolean;
}

const VALUE_FLAGS = new Set(['--agent', '--pool', '--runner']);

function isRouteTaskRunnerKind(value: string): value is RouteTaskRunnerKind {
  return (ROUTE_TASK_RUNNER_KINDS as readonly string[]).includes(value);
}

export function parseRouteTaskArgs(args: readonly string[]): RouteTaskArgs {
  let taskId: string | undefined;
  let agent: string | undefined;
  let poolId: string | undefined;
  let runnerKind: RouteTaskRunnerKind | undefined;
  let clearMember = false;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--clear-member') {
      clearMember = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}. ${ROUTE_TASK_USAGE}`);
      }
      index += 1;
      const trimmed = value.trim();
      if (!trimmed) {
        throw new Error(`Missing value for ${arg}. ${ROUTE_TASK_USAGE}`);
      }
      if (arg === '--agent') {
        agent = trimmed;
      } else if (arg === '--pool') {
        poolId = trimmed;
      } else if (isRouteTaskRunnerKind(trimmed)) {
        runnerKind = trimmed;
      } else {
        throw new Error(
          `Unsupported --runner value "${value}". Supported values: ${ROUTE_TASK_RUNNER_KINDS.join(', ')}.`,
        );
      }
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}. ${ROUTE_TASK_USAGE}`);
    }
    if (taskId !== undefined) {
      throw new Error(`Unexpected argument: ${arg}. ${ROUTE_TASK_USAGE}`);
    }
    taskId = arg;
  }

  if (!taskId) {
    throw new Error(`Missing taskId. ${ROUTE_TASK_USAGE}`);
  }
  if (agent === undefined && poolId === undefined && runnerKind === undefined && !clearMember) {
    throw new Error(`Nothing to change. ${ROUTE_TASK_USAGE}`);
  }

  return { taskId, agent, poolId, runnerKind, clearMember, force };
}

export function formatRouteTaskArgs(parsed: RouteTaskArgs): string[] {
  const args = [parsed.taskId];
  if (parsed.agent !== undefined) args.push('--agent', parsed.agent);
  if (parsed.poolId !== undefined) args.push('--pool', parsed.poolId);
  if (parsed.runnerKind !== undefined) args.push('--runner', parsed.runnerKind);
  if (parsed.clearMember) args.push('--clear-member');
  if (parsed.force) args.push('--force');
  return args;
}
