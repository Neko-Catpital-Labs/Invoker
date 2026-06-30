import type { WorkflowGatePolicy, WorkflowGatePolicyUpdate } from '../surface.js';

// ── Context ──────────────────────────────────────────────────

export interface WorkflowContext {
  workflowId: string;
  planning: { role: string; content: string }[];
  tasks: Array<{
    id: string;
    status: string;
    agentName: string;
    transcript: { role: string; content: string }[];
    output?: string;
  }>;
}

// ── Q&A prompt ───────────────────────────────────────────────

export function buildAssistantPrompt(question: string, ctx: WorkflowContext): string {
  const lines: string[] = [
    `You are answering questions about Invoker workflow \`${ctx.workflowId}\`.`,
    "Answer ONLY from this workflow's planning conversation and task transcripts below.",
    'If the answer is not present in this context, say you do not know — never guess or use outside knowledge.',
    '',
    '=== Planning conversation ===',
  ];
  if (ctx.planning.length === 0) lines.push('(none)');
  for (const m of ctx.planning) lines.push(`${m.role}: ${m.content}`);
  lines.push('');

  for (const task of ctx.tasks) {
    lines.push(`=== Task ${task.id} (status=${task.status}, agent=${task.agentName}) ===`);
    if (task.transcript.length === 0) lines.push('(no transcript)');
    for (const m of task.transcript) lines.push(`${m.role}: ${m.content}`);
    if (task.output) lines.push(`output: ${task.output}`);
    lines.push('');
  }

  lines.push('=== Question ===');
  lines.push(question);
  return lines.join('\n');
}

// ── Control verbs ────────────────────────────────────────────

// Gate-policy mirrors the headless shape:
// `set gate-policy <task-id> <upstream-workflow-id> [upstream-task-id] <completed|review_ready>`.
export type WorkflowControl =
  | { kind: 'status' }
  | { kind: 'approve' | 'reject' | 'retry'; task: string }
  | { kind: 'input'; task: string; text: string }
  | {
      kind: 'gate-policy';
      operation: 'gate-policy';
      ownerTaskId: string;
      updates: WorkflowGatePolicyUpdate[];
    };

const GATE_POLICY_PATTERN = /^(?:set\s+)?gate[-\s]policy\b([\s\S]*)$/i;
const TARGET_TOKEN = /^[\w./-]+$/;

function parseGatePolicy(value: string): WorkflowGatePolicy | null {
  const normalized = value.toLowerCase().replace(/-/g, '_');
  return normalized === 'completed' || normalized === 'review_ready' ? normalized : null;
}

function parseWorkflowGatePolicy(text: string): Extract<WorkflowControl, { kind: 'gate-policy' }> | null {
  const match = GATE_POLICY_PATTERN.exec(text);
  if (!match) return null;

  const parts = match[1].trim().replace(/[.!?]+$/, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;

  const [ownerTaskId, upstreamWorkflowId] = parts;
  const depTaskId = parts.length === 4 ? parts[2] : undefined;
  const policyToken = parts.length === 4 ? parts[3] : parts[2];
  const gatePolicy = parseGatePolicy(policyToken);
  if (!ownerTaskId || !upstreamWorkflowId || !gatePolicy) return null;
  if (!TARGET_TOKEN.test(ownerTaskId) || !TARGET_TOKEN.test(upstreamWorkflowId)) return null;
  if (depTaskId !== undefined && !TARGET_TOKEN.test(depTaskId)) return null;

  const update: WorkflowGatePolicyUpdate = {
    workflowId: upstreamWorkflowId,
    ...(depTaskId === undefined ? {} : { taskId: depTaskId }),
    gatePolicy,
  };

  return {
    kind: 'gate-policy',
    operation: 'gate-policy',
    ownerTaskId,
    updates: [update],
  };
}

export function parseWorkflowControl(text: string): WorkflowControl | null {
  const t = text.trim();
  if (/^status\b/i.test(t)) return { kind: 'status' };

  const gatePolicy = parseWorkflowGatePolicy(t);
  if (gatePolicy) return gatePolicy;

  const input = /^input\s+(\S+)\s*:\s*([\s\S]+)$/i.exec(t);
  if (input) return { kind: 'input', task: input[1], text: input[2].trim() };

  const action = /^(approve|reject|retry)\s+(\S+)\s*$/i.exec(t);
  if (action) {
    return { kind: action[1].toLowerCase() as 'approve' | 'reject' | 'retry', task: action[2] };
  }

  return null;
}
