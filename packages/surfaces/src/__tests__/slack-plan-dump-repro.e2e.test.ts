import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanConversation } from '../slack/plan-conversation.js';
import { SQLiteAdapter } from '@invoker/data-store';
import { ConversationRepository } from '@invoker/data-store';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';

// ── Mock child_process.spawn ────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(child_process.spawn);

function createMockProcess(stdout: string, exitCode = 0): any {
  const proc = new EventEmitter() as any;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  proc.stdout = stdoutEmitter;
  proc.stderr = stderrEmitter;
  proc.kill = vi.fn();

  setTimeout(() => {
    stdoutEmitter.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  }, 0);

  return proc;
}

function mockCursorResponse(text: string) {
  mockSpawn.mockReturnValueOnce(createMockProcess(text));
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Shaped like a real Invoker chat-submit reply: prose, a fenced plan with
// many tasks (so the fence is long), then closing prose — the exact shape
// that appeared as a multi-message raw dump in Slack (see the "Invoker
// [11:57 AM]" transcript pasted into the CI-fix session on 2026-08-22).
const LONG_DRAFTED_PLAN = `Here's the plan staged for your review — this is a docs-only change:

\`\`\`yaml
name: "harness-self-delegation-routing"
onFinish: pull_request
mergeMode: external_review
repoUrl: "git@github.com:Neko-Catpital-Labs/Invoker.git"
tasks:
  - id: "add-self-triggered-delegation-routing"
    description: "Add routing text to skills/plan-to-invoker/SKILL.md and CLAUDE.md."
    prompt: "Add the routing criteria as described."
    dependencies: []
  - id: "verify-skill-md-self-delegation-text"
    description: "Proves the new heading and its two literal lines exist."
    command: "grep -F \\"### Self-triggered delegation routing\\" skills/plan-to-invoker/SKILL.md"
    dependencies: ["add-self-triggered-delegation-routing"]
  - id: "verify-claude-md-self-delegation-pointer"
    description: "Proves the new CLAUDE.md pointer exists."
    command: "grep -F \\"Self-triggered delegation routing\\" CLAUDE.md"
    dependencies: ["add-self-triggered-delegation-routing"]
  - id: "verify-plan-to-invoker-skill-regression"
    description: "Confirms the existing regression script still passes."
    command: "bash scripts/test-plan-to-invoker-skill.sh"
    dependencies: ["add-self-triggered-delegation-routing"]
\`\`\`

Approve to stage it for Invoker. Note: this lands the routing criteria as
docs/policy only — no application code changes.`;

describe('Slack plan-dump repro: drafted plan text must not be sent verbatim to Slack', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;

  beforeEach(async () => {
    mockSpawn.mockReset();
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, silentLogger);
  });

  afterEach(() => {
    adapter.close();
  });

  it('a turn that drafts a plan does not return the raw ```yaml fence for Slack to post verbatim', async () => {
    const conv = new PlanConversation({ threadTs: 'ts-plan-dump', conversationRepo: repo, mode: 'plan' });
    mockCursorResponse(LONG_DRAFTED_PLAN);

    // This is exactly what handleConversationMessage in slack-surface.ts
    // sends to Slack (chunked via splitForSlack, posted as one or more
    // plain-text messages) -- it must not still contain the raw fenced plan.
    const reply = await conv.sendMessage('Generate a plan');

    expect(reply).not.toContain('```yaml');
    expect(reply).not.toContain('verify-plan-to-invoker-skill-regression');

    // The draft itself must still be fully captured for the real review
    // flow (file-attached card), which reads conversation.lastTurnDraftPlanText
    // directly and does not re-parse the (now redacted) reply text.
    expect(conv.lastTurnDraftPlanText).toContain('harness-self-delegation-routing');
    expect(conv.lastTurnDraftPlanText).toContain('verify-plan-to-invoker-skill-regression');
  });

  it('a turn with no drafted plan is left completely untouched', async () => {
    const conv = new PlanConversation({ threadTs: 'ts-no-plan', conversationRepo: repo, mode: 'plan' });
    mockCursorResponse('What repo should this target?');

    const reply = await conv.sendMessage('I want to add a REST API');

    expect(reply).toBe('What repo should this target?');
  });
});
