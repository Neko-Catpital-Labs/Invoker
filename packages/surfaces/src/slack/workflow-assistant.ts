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

export const SLACK_DIRECT_ANSWER_GUIDANCE =
  'Answer in simple ELI5 Slack prose. By default, keep the answer to 40 words or fewer. If the question is clearly technical, include the necessary technical detail even if that exceeds 40 words.';

export function buildAssistantPrompt(question: string, ctx: WorkflowContext): string {
  const lines: string[] = [
    `You are answering questions about Invoker workflow \`${ctx.workflowId}\`.`,
    "Answer ONLY from this workflow's planning conversation and task transcripts below.",
    'If the answer is not present in this context, say you do not know — never guess or use outside knowledge.',
    SLACK_DIRECT_ANSWER_GUIDANCE,
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
  | { kind: 'input'; task: string; text: string };

export function parseWorkflowControl(text: string): WorkflowControl | null {
  const t = text.trim();
  if (/^status\b/i.test(t)) return { kind: 'status' };

  const input = /^input\s+(\S+)\s*:\s*([\s\S]+)$/i.exec(t);
  if (input) return { kind: 'input', task: input[1], text: input[2].trim() };

  const action = /^(approve|reject|retry)\s+(\S+)\s*$/i.exec(t);
  if (action) {
    return { kind: action[1].toLowerCase() as 'approve' | 'reject' | 'retry', task: action[2] };
  }

  return null;
}
