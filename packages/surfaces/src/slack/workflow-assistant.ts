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

export type WorkflowControl =
  | { kind: 'status' }
  | { kind: 'approve' | 'reject' | 'retry'; task: string }
  | { kind: 'input'; task: string; text: string }
  | { kind: 'gate-policy'; updates: WorkflowGatePolicyUpdate[] };

const TARGET_TOKEN = /^[\w./-]+$/;

function parseGatePolicy(rest: string): Extract<WorkflowControl, { kind: 'gate-policy' }> | null {
  const withoutPolicy = rest.trim().replace(/[.!?]+$/, '').trim();
  let gatePolicy: WorkflowGatePolicy;
  let argsText: string;

  const reviewReady = /\s+review[-_\s]+ready$/i.exec(withoutPolicy);
  if (reviewReady) {
    gatePolicy = 'review_ready';
    argsText = withoutPolicy.slice(0, reviewReady.index).trim();
  } else {
    const completed = /\s+completed$/i.exec(withoutPolicy);
    if (!completed) return null;
    gatePolicy = 'completed';
    argsText = withoutPolicy.slice(0, completed.index).trim();
  }

  const args = argsText.split(/\s+/).filter(Boolean);
  if (args.length < 1 || args.length > 2) return null;
  if (!args.every((arg) => TARGET_TOKEN.test(arg))) return null;

  const [upstreamWorkflowToken, upstreamTaskToken] = args;
  const update = parseGatePolicyUpdate(upstreamWorkflowToken, upstreamTaskToken, gatePolicy);
  if (!update) return null;

  return { kind: 'gate-policy', updates: [update] };
}

function parseGatePolicyUpdate(
  upstreamWorkflowToken: string,
  upstreamTaskToken: string | undefined,
  gatePolicy: WorkflowGatePolicy,
): WorkflowGatePolicyUpdate | null {
  if (upstreamWorkflowToken.includes('/')) {
    if (upstreamTaskToken) return null;
    const [workflowId, taskId, ...extra] = upstreamWorkflowToken.split('/');
    if (!workflowId || !taskId || extra.length > 0) return null;
    return { workflowId, taskId, gatePolicy };
  }

  return upstreamTaskToken
    ? { workflowId: upstreamWorkflowToken, taskId: upstreamTaskToken, gatePolicy }
    : { workflowId: upstreamWorkflowToken, gatePolicy };
}

export function parseWorkflowControl(text: string): WorkflowControl | null {
  const t = text.trim();
  if (/^status\b/i.test(t)) return { kind: 'status' };

  const gatePolicy = /^(?:set\s+)?gate[-\s]+policy\b([\s\S]*)$/i.exec(t);
  if (gatePolicy) return parseGatePolicy(gatePolicy[1]);

  const input = /^input\s+(\S+)\s*:\s*([\s\S]+)$/i.exec(t);
  if (input) return { kind: 'input', task: input[1], text: input[2].trim() };

  const action = /^(approve|reject|retry)\s+(\S+)\s*$/i.exec(t);
  if (action) {
    return { kind: action[1].toLowerCase() as 'approve' | 'reject' | 'retry', task: action[2] };
  }

  return null;
}
