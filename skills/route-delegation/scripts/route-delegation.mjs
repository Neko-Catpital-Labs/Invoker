#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORK_KINDS = new Set(['readonly', 'small_local', 'approved_plan', 'durable_parallel']);
export const DURABLE_ALIASES = new Set(['post_land_babysit', 'named_execution_backlog']);
export const ALWAYS_PUBLISHING_WORK_KINDS = new Set([...DURABLE_ALIASES, 'approved_plan']);

export const PUBLISHING_OUTPUTS = new Set(['commit', 'pull_request', 'tag', 'merge', 'deploy', 'durable_artifact']);
export const NON_PUBLISHING_OUTPUTS = new Set(['none', 'report', 'research', 'review', 'verification']);

export const INVOKER_REQUIRED_TOOLS = ['invoker_prepare_plan_review', 'invoker_submit_plan'];

export const DELEGATE_HANDOFF_STEPS = [
  'plan_to_invoker_yaml',
  'planning_completeness_gate',
  'invoker_prepare_plan_review',
  'one_approval_or_auto_submit',
  'invoker_submit_plan',
  'invoker_cli_wait_then_end_turn',
];

export const SUBAGENT_FANOUT_STEPS = [
  'spawn_worktree_isolated_subagents',
  'collect_reports_async',
  'grep_transcripts_for_writes',
];

export const LOCAL_STEPS = ['stay_local'];

export function invokerMcpAvailable(tools) {
  const names = new Set(tools);
  return INVOKER_REQUIRED_TOOLS.every((tool) => names.has(tool));
}

export function normalizeWorkKind(workKind) {
  if (DURABLE_ALIASES.has(workKind)) return 'durable_parallel';
  if (WORK_KINDS.has(workKind)) return workKind;
  throw new Error(`unknown work_kind: ${JSON.stringify(workKind)}`);
}

export function routeExecution({ tools, workKind }) {
  const kind = normalizeWorkKind(workKind);
  if (!invokerMcpAvailable(tools)) return 'local';
  if (kind === 'readonly' || kind === 'small_local') return 'local';
  return 'delegate_invoker';
}

export function publishes({ workKind, produces }) {
  if (!Array.isArray(produces)) {
    throw new Error('produces must be an array of output names');
  }
  if (produces.length === 0) {
    throw new Error("produces must name at least one output; use 'none' for work that publishes nothing");
  }
  const unknown = [...new Set(produces)]
    .filter((output) => !PUBLISHING_OUTPUTS.has(output) && !NON_PUBLISHING_OUTPUTS.has(output))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`unknown produces value(s): ${JSON.stringify(unknown)}`);
  }
  if (ALWAYS_PUBLISHING_WORK_KINDS.has(workKind)) return true;
  return produces.some((output) => PUBLISHING_OUTPUTS.has(output));
}

export function routeDelegation({ tools, workKind, produces }) {
  normalizeWorkKind(workKind);
  if (publishes({ workKind, produces })) return routeExecution({ tools, workKind });
  return 'subagent_fanout';
}

export function handoffStepsFor(route) {
  if (route === 'local') return LOCAL_STEPS;
  if (route === 'subagent_fanout') return SUBAGENT_FANOUT_STEPS;
  if (route === 'delegate_invoker') return DELEGATE_HANDOFF_STEPS;
  throw new Error(`unknown route: ${JSON.stringify(route)}`);
}

function main(argv) {
  const payload = argv[0] ? JSON.parse(argv[0]) : {};
  const tools = payload.tools ?? [];
  const workKind = payload.work_kind ?? 'small_local';
  const route = payload.produces === undefined
    ? routeExecution({ tools, workKind })
    : routeDelegation({ tools, workKind, produces: payload.produces });
  process.stdout.write(`${JSON.stringify({ route, steps: handoffStepsFor(route) })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`route-delegation: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
