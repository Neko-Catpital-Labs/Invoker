import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MessageBus } from '@invoker/transport';
import { parse as parseYaml } from 'yaml';
import {
  createDefaultMessageBus,
  createTraceId,
  discoverLiveOwner,
  withTimeout,
  type LiveOwnerInfo,
} from './live-owner-bus.js';

export const UPSTREAM_WORKFLOW_PLACEHOLDER = 'wf-1786078152814-14';

export type SubmitChainGatePolicy = 'completed' | 'review_ready';

export type SubmitChainDeps = {
  createMessageBus?: () => Promise<MessageBus> | MessageBus;
  sleep?: (ms: number) => Promise<void>;
};

type LiveSubmissionResult = {
  workflowId: string;
  tasks: unknown[];
  ownerId?: string;
};

type WorkflowRow = {
  id: string;
  name?: string;
  createdAt?: string;
  baseBranch?: string;
  featureBranch?: string;
};

type TaskRow = {
  id: string;
};

type PreparedPlan = {
  path: string;
  text: string;
  name: string;
};

type ChainStep = {
  workflowId: string;
  baseBranch: string;
  featureBranch: string;
};

type SubmitChainOptions = {
  gatePolicy: SubmitChainGatePolicy;
  planPaths: string[];
};

const SUBMIT_CHAIN_USAGE = 'Usage: invoker-cli submit-chain [--gate-policy completed|review_ready] <plan1.yaml> <plan2.template.yaml> ...';
const REQUIRED_OWNER_MESSAGE = 'No running Invoker owner is reachable; start the Invoker app or run `invoker-cli owner serve`.';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function quoteMatcher(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeScalar(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function validateLiveSubmissionResponse(raw: unknown): LiveSubmissionResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Live owner returned invalid headless.run response: expected object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const response = raw as Record<string, unknown>;
  if (typeof response.workflowId !== 'string' || response.workflowId.length === 0) {
    throw new Error('Live owner returned invalid headless.run response: missing workflowId');
  }
  if (!Array.isArray(response.tasks)) {
    throw new Error('Live owner returned invalid headless.run response: missing tasks array');
  }
  return {
    workflowId: response.workflowId,
    tasks: response.tasks,
    ownerId: typeof response.ownerId === 'string' ? response.ownerId : undefined,
  };
}

function validateLiveQueryResponse(raw: unknown): string {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Live owner returned invalid headless.query response: expected object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const output = (raw as Record<string, unknown>).output;
  if (typeof output !== 'string') {
    throw new Error('Live owner returned invalid headless.query response: missing output string');
  }
  return output;
}

function parseJsonArray(output: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    throw new Error(`Could not parse ${label} query JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} query returned invalid JSON: expected an array`);
  }
  return parsed;
}

function parseWorkflowRows(output: string): WorkflowRow[] {
  return parseJsonArray(output, 'workflow')
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => typeof item.id === 'string' && item.id.length > 0)
    .map((item) => ({
      id: String(item.id),
      name: normalizeScalar(item.name),
      createdAt: normalizeScalar(item.createdAt),
      baseBranch: normalizeScalar(item.baseBranch),
      featureBranch: normalizeScalar(item.featureBranch),
    }));
}

function parseTaskRows(output: string): TaskRow[] {
  return parseJsonArray(output, 'task')
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item): item is { id: string } => typeof item.id === 'string' && item.id.length > 0);
}

function parsePlanName(planText: string, planPath: string): string {
  let parsed: unknown;
  try {
    parsed = parseYaml(planText);
  } catch (err) {
    throw new Error(`Could not parse plan name from ${planPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Could not parse plan name from ${planPath} (expected top-level 'name:')`);
  }
  const name = (parsed as Record<string, unknown>).name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Could not parse plan name from ${planPath} (expected top-level 'name:')`);
  }
  return name;
}

function validateTemplatePlan(plan: PreparedPlan): void {
  if (!plan.text.includes(UPSTREAM_WORKFLOW_PLACEHOLDER)) {
    throw new Error(`Template plan is missing ${UPSTREAM_WORKFLOW_PLACEHOLDER}: ${plan.path}`);
  }
  if (!/^baseBranch:[^\n\r]*$/m.test(plan.text)) {
    throw new Error(`Template plan is missing top-level baseBranch: ${plan.path}`);
  }
}

function loadPreparedPlans(planPaths: string[]): PreparedPlan[] {
  if (planPaths.length < 2) {
    throw new Error(SUBMIT_CHAIN_USAGE);
  }
  return planPaths.map((rawPath, index) => {
    const path = resolve(rawPath);
    if (!existsSync(path)) {
      throw new Error(`Missing plan file: ${rawPath}`);
    }
    const text = readFileSync(path, 'utf8');
    const plan = { path, text, name: parsePlanName(text, path) };
    if (index > 0) validateTemplatePlan(plan);
    return plan;
  });
}

export function parseSubmitChainArgs(argv: string[]): SubmitChainOptions {
  let gatePolicy: SubmitChainGatePolicy = 'completed';
  const planPaths: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--gate-policy') {
      const value = argv[++i];
      if (value !== 'completed' && value !== 'review_ready') {
        throw new Error(`Invalid --gate-policy value: ${value ?? '<missing>'}. ${SUBMIT_CHAIN_USAGE}`);
      }
      gatePolicy = value;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(SUBMIT_CHAIN_USAGE);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown submit-chain option: ${arg}. ${SUBMIT_CHAIN_USAGE}`);
    } else {
      planPaths.push(arg);
    }
  }

  if (planPaths.length < 2) {
    throw new Error(SUBMIT_CHAIN_USAGE);
  }
  return { gatePolicy, planPaths };
}

export function renderUpstreamWorkflowPlaceholder(planText: string, upstreamWorkflowId: string): string {
  return planText.split(UPSTREAM_WORKFLOW_PLACEHOLDER).join(upstreamWorkflowId);
}

function workflowIdFromDependencyLine(line: string): string | undefined {
  const match = line.match(/^[ \t]*-[ \t]*workflowId:[ \t]*(?:"([^"]+)"|'([^']+)'|([^#\s]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function enforceStrictUpstreamDependencyFields(
  planText: string,
  upstreamWorkflowId: string,
  gatePolicy: SubmitChainGatePolicy,
): string {
  const lines = planText.split(/\r?\n/);
  const output: string[] = [];
  let inExternalDependencies = false;
  let dependencyIndent = '';
  let dependencyIsUpstream = false;
  let sawTaskId = false;
  let sawRequiredStatus = false;
  let sawGatePolicy = false;

  const resetDependency = (): void => {
    dependencyIndent = '';
    dependencyIsUpstream = false;
    sawTaskId = false;
    sawRequiredStatus = false;
    sawGatePolicy = false;
  };

  const flushDependency = (): void => {
    if (!inExternalDependencies || !dependencyIsUpstream) return;
    const fieldIndent = `${dependencyIndent}  `;
    if (!sawTaskId) output.push(`${fieldIndent}taskId: "__merge__"`);
    if (!sawRequiredStatus) output.push(`${fieldIndent}requiredStatus: completed`);
    if (!sawGatePolicy) output.push(`${fieldIndent}gatePolicy: ${gatePolicy}`);
  };

  for (const line of lines) {
    if (/^[^ \t]/.test(line) && !/^externalDependencies:[ \t]*$/.test(line)) {
      flushDependency();
      inExternalDependencies = false;
      resetDependency();
      output.push(line);
      continue;
    }

    if (/^externalDependencies:[ \t]*$/.test(line)) {
      flushDependency();
      inExternalDependencies = true;
      resetDependency();
      output.push(line);
      continue;
    }

    const workflowId = inExternalDependencies ? workflowIdFromDependencyLine(line) : undefined;
    if (workflowId !== undefined) {
      flushDependency();
      dependencyIndent = line.slice(0, line.indexOf('-'));
      dependencyIsUpstream = workflowId === upstreamWorkflowId;
      sawTaskId = false;
      sawRequiredStatus = false;
      sawGatePolicy = false;
      output.push(line);
      continue;
    }

    if (inExternalDependencies && dependencyIsUpstream && /^[ \t]*taskId:[ \t]*/.test(line)) {
      output.push(`${dependencyIndent}  taskId: "__merge__"`);
      sawTaskId = true;
      continue;
    }
    if (inExternalDependencies && dependencyIsUpstream && /^[ \t]*requiredStatus:[ \t]*/.test(line)) {
      output.push(`${dependencyIndent}  requiredStatus: completed`);
      sawRequiredStatus = true;
      continue;
    }
    if (inExternalDependencies && dependencyIsUpstream && /^[ \t]*gatePolicy:[ \t]*/.test(line)) {
      output.push(`${dependencyIndent}  gatePolicy: ${gatePolicy}`);
      sawGatePolicy = true;
      continue;
    }

    output.push(line);
  }
  flushDependency();
  return output.join('\n');
}

export function validateStrictUpstreamDependencyFields(
  planText: string,
  upstreamWorkflowId: string,
  gatePolicy: SubmitChainGatePolicy,
): boolean {
  let parsed: unknown;
  try {
    parsed = parseYaml(planText);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const externalDependencies = (parsed as Record<string, unknown>).externalDependencies;
  if (!Array.isArray(externalDependencies)) return false;
  return externalDependencies.some((dependency) => (
    Boolean(dependency)
    && typeof dependency === 'object'
    && (dependency as Record<string, unknown>).workflowId === upstreamWorkflowId
    && (dependency as Record<string, unknown>).taskId === '__merge__'
    && (dependency as Record<string, unknown>).requiredStatus === 'completed'
    && (dependency as Record<string, unknown>).gatePolicy === gatePolicy
  ));
}

export function rewriteTopLevelBaseBranch(planText: string, featureBranch: string): string {
  if (!/^baseBranch:[^\n\r]*$/m.test(planText)) {
    throw new Error('Rendered plan is missing top-level baseBranch');
  }
  return planText.replace(/^baseBranch:[^\n\r]*$/m, `baseBranch: ${featureBranch}`);
}

export function hasTopLevelBaseBranch(planText: string, featureBranch: string): boolean {
  return new RegExp(`^baseBranch:[ \\t]*${quoteMatcher(featureBranch)}$`, 'm').test(planText);
}

async function queryLiveOwnerJson(bus: MessageBus, resource: 'workflows' | 'tasks', forwardedFlags: string[]): Promise<string> {
  const raw = await withTimeout(
    bus.request('headless.query', {
      kind: 'cli-query',
      args: ['query', resource, ...forwardedFlags],
    }),
    15_000,
  );
  return validateLiveQueryResponse(raw);
}

async function queryWorkflows(bus: MessageBus): Promise<WorkflowRow[]> {
  return parseWorkflowRows(await queryLiveOwnerJson(bus, 'workflows', ['--output', 'json']));
}

async function queryTasks(bus: MessageBus): Promise<TaskRow[]> {
  return parseTaskRows(await queryLiveOwnerJson(bus, 'tasks', ['--output', 'json']));
}

async function submitPlanToLiveOwnerNoTrack(
  planPath: string,
  bus: MessageBus,
  owner: LiveOwnerInfo,
): Promise<LiveSubmissionResult> {
  const raw = await withTimeout(
    bus.request('headless.run', {
      planPath: resolve(planPath),
      traceId: createTraceId('invoker-cli.headless.run'),
      noTrack: true,
    }),
    15_000,
  );
  return {
    ...validateLiveSubmissionResponse(raw),
    ownerId: owner.ownerId,
  };
}

async function resolvePersistedWorkflowId(
  planName: string,
  bus: MessageBus,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const matches = (await queryWorkflows(bus))
      .filter((workflow) => workflow.name === planName)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    const workflow = matches[matches.length - 1];
    if (workflow) return workflow.id;
    await sleep(200);
  }
  throw new Error(`Failed to resolve persisted workflow id for name: ${planName}`);
}

async function resolveWorkflowRow(
  workflowId: string,
  bus: MessageBus,
  sleep: (ms: number) => Promise<void>,
): Promise<WorkflowRow> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const workflow = (await queryWorkflows(bus)).find((candidate) => candidate.id === workflowId);
    if (workflow?.featureBranch) return workflow;
    await sleep(200);
  }
  throw new Error(`Failed to resolve featureBranch for workflow: ${workflowId}`);
}

async function waitForExternalMergeGate(
  workflowId: string,
  bus: MessageBus,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const mergeTaskId = `__merge__${workflowId}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await queryTasks(bus)).some((task) => task.id === mergeTaskId)) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`Upstream merge gate not found yet: ${mergeTaskId}`);
}

function writeRenderedPlan(stepNumber: number, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), `invoker-chain-step${stepNumber}-`));
  const path = join(dir, 'plan.yaml');
  writeFileSync(path, text, 'utf8');
  return path;
}

function printSummary(gatePolicy: SubmitChainGatePolicy, steps: ChainStep[], renderedPlans: string[]): void {
  process.stdout.write('\n');
  process.stdout.write('Workflow chain submitted.\n');
  process.stdout.write(`GATE_POLICY=${gatePolicy}\n`);
  for (const [index, step] of steps.entries()) {
    process.stdout.write(`WF${index + 1}=${step.workflowId} base=${step.baseBranch} feature=${step.featureBranch}\n`);
  }
  for (const path of renderedPlans) {
    process.stdout.write(`RENDERED_PLAN=${path}\n`);
  }
}

export async function runSubmitChain(argv: string[], deps: SubmitChainDeps = {}): Promise<number> {
  const options = parseSubmitChainArgs(argv);
  const plans = loadPreparedPlans(options.planPaths);
  const sleep = deps.sleep ?? defaultSleep;
  let bus: MessageBus | undefined;

  try {
    bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
    const owner = await discoverLiveOwner(bus);
    if (!owner) {
      throw new Error(REQUIRED_OWNER_MESSAGE);
    }

    const steps: ChainStep[] = [];
    const renderedPlans: string[] = [];
    let previousWorkflowId = '';
    let previousFeatureBranch = '';

    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      if (!plan) continue;
      let submitPlanPath = plan.path;

      if (index > 0) {
        if (!previousWorkflowId || !previousFeatureBranch) {
          throw new Error(`Internal error: missing previous workflow before rendering chain step ${index + 1}.`);
        }
        await waitForExternalMergeGate(previousWorkflowId, bus, sleep);

        let rendered = renderUpstreamWorkflowPlaceholder(plan.text, previousWorkflowId);
        if (!rendered.includes(previousWorkflowId)) {
          throw new Error(`Rendered plan did not include upstream id '${previousWorkflowId}'`);
        }
        rendered = enforceStrictUpstreamDependencyFields(rendered, previousWorkflowId, options.gatePolicy);
        if (!validateStrictUpstreamDependencyFields(rendered, previousWorkflowId, options.gatePolicy)) {
          throw new Error(
            `Rendered plan did not enforce strict upstream merge dependency fields for '${previousWorkflowId}' `
            + `(taskId=__merge__, requiredStatus=completed, gatePolicy=${options.gatePolicy})`,
          );
        }
        rendered = rewriteTopLevelBaseBranch(rendered, previousFeatureBranch);
        if (!hasTopLevelBaseBranch(rendered, previousFeatureBranch)) {
          throw new Error(`Rendered plan baseBranch did not update to upstream feature branch '${previousFeatureBranch}'`);
        }
        submitPlanPath = writeRenderedPlan(index + 1, rendered);
        renderedPlans.push(submitPlanPath);
      }

      process.stdout.write(`Submitting workflow ${index + 1} (no track): ${submitPlanPath}\n`);
      await submitPlanToLiveOwnerNoTrack(submitPlanPath, bus, owner);
      const persistedWorkflowId = await resolvePersistedWorkflowId(plan.name, bus, sleep);
      const workflow = await resolveWorkflowRow(persistedWorkflowId, bus, sleep);
      const step = {
        workflowId: persistedWorkflowId,
        baseBranch: workflow.baseBranch ?? '<unset>',
        featureBranch: workflow.featureBranch ?? '',
      };
      steps.push(step);
      previousWorkflowId = step.workflowId;
      previousFeatureBranch = step.featureBranch;
    }

    printSummary(options.gatePolicy, steps, renderedPlans);
    return 0;
  } finally {
    const disconnect = (bus as { disconnect?: () => void } | undefined)?.disconnect;
    if (disconnect) {
      disconnect.call(bus);
    }
  }
}
