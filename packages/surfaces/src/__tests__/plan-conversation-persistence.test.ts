import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanConversation, extractYamlPlan } from '../slack/plan-conversation.js';
import { SQLiteAdapter } from '@invoker/persistence';
import { ConversationRepository } from '@invoker/persistence';
import type { PlanDefinition } from '@invoker/core';

// ── Mock Anthropic SDK ──────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

// ── Helpers ─────────────────────────────────────────────────

function mockTextResponse(text: string) {
  mockCreate.mockResolvedValueOnce({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
  });
}

function mockToolUseResponse(toolCalls: Array<{ id: string; name: string; input: any }>) {
  mockCreate.mockResolvedValueOnce({
    stop_reason: 'tool_use',
    content: toolCalls.map((t) => ({
      type: 'tool_use',
      id: t.id,
      name: t.name,
      input: t.input,
    })),
  });
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const VALID_YAML_PLAN = `Here's your plan:

\`\`\`yaml
name: "Test Plan"
onFinish: none
baseBranch: main
tasks:
  - id: task-1
    description: "First task"
    prompt: "Do something"
    dependencies: []
  - id: task-2
    description: "Second task"
    command: "npm test"
    dependencies:
      - task-1
\`\`\`

Let me know if you'd like changes!`;

// ── Tests ───────────────────────────────────────────────────

describe('PlanConversation persistence', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;

  beforeEach(() => {
    mockCreate.mockReset();
    adapter = new SQLiteAdapter(':memory:');
    repo = new ConversationRepository(adapter, silentLogger);
  });

  afterEach(() => {
    adapter.close();
  });

  function createConversation(threadTs: string): PlanConversation {
    return new PlanConversation({
      apiKey: 'test-key',
      threadTs,
      conversationRepo: repo,
    });
  }

  // ── Basic persistence ──────────────────────────────────

  describe('basic state persistence', () => {
    it('saves conversation state after each exchange', async () => {
      const conv = createConversation('ts-1');
      mockTextResponse('Hello! What would you like to build?');

      await conv.sendMessage('I want to add a REST API');

      const saved = repo.loadConversation('ts-1');
      expect(saved).not.toBeNull();
      expect(saved!.messages.length).toBeGreaterThanOrEqual(2);
    });

    it('no longer persists extractedPlan (plan is scanned on demand)', async () => {
      const conv = createConversation('ts-plan');
      mockTextResponse(VALID_YAML_PLAN);

      await conv.sendMessage('Generate a plan');

      const saved = repo.loadConversation('ts-plan');
      expect(saved!.extractedPlan).toBeNull();
    });

    it('persists planSubmitted state', async () => {
      const conv = createConversation('ts-submit');

      // First: generate a plan
      mockTextResponse(VALID_YAML_PLAN);
      await conv.sendMessage('Generate a plan');

      // Submit the plan
      await conv.executeTool('submit_plan', {});
      expect(conv.planSubmitted).toBe(true);

      // Manually save state after submit_plan (sendMessage auto-saves, but executeTool doesn't trigger saveState)
      // Plan submitted state is saved on the next sendMessage; verify the plan itself is saved
      mockTextResponse('Plan submitted!');
      await conv.sendMessage('Go ahead');

      const saved = repo.loadConversation('ts-submit');
      expect(saved!.planSubmitted).toBe(true);
    });

    it('does not persist when no repo is configured', async () => {
      const conv = new PlanConversation({ apiKey: 'test-key' });
      mockTextResponse('Hi there');

      await conv.sendMessage('Hello');

      // No crash, no saved state
      expect(conv.history).toHaveLength(2);
    });

    it('does not persist when no threadTs is configured', async () => {
      const conv = new PlanConversation({
        apiKey: 'test-key',
        conversationRepo: repo,
        // no threadTs
      });
      mockTextResponse('Hi there');

      await conv.sendMessage('Hello');

      // No crash, active conversations should be empty
      expect(repo.listActiveConversations()).toEqual([]);
    });
  });

  // ── Recovery after restart ─────────────────────────────

  describe('conversation recovery after restart', () => {
    it('recovers messages from a previous session', async () => {
      // Session 1: have a conversation
      const conv1 = createConversation('ts-recover');
      mockTextResponse('Tell me more about the feature.');
      await conv1.sendMessage('I want to build a chat app');

      // Session 2: create a new PlanConversation with the same threadTs
      const conv2 = createConversation('ts-recover');
      await conv2.init();

      // History should be restored
      expect(conv2.history.length).toBeGreaterThanOrEqual(2);
      expect(conv2.history[0]).toEqual(
        expect.objectContaining({ role: 'user', content: 'I want to build a chat app' }),
      );
    });

    it('recovered session can find plan via submit_plan (scans history)', async () => {
      // Session 1: generate a plan
      const conv1 = createConversation('ts-plan-recover');
      mockTextResponse(VALID_YAML_PLAN);
      await conv1.sendMessage('Generate a plan for REST API');

      // Session 2: recover and submit
      const conv2 = createConversation('ts-plan-recover');
      await conv2.init();

      const result = await conv2.executeTool('submit_plan', {});
      expect(result).toContain('submitted for execution');
      expect(conv2.submittedPlan).not.toBeNull();
      expect(conv2.submittedPlan!.name).toBe('Test Plan');
    });

    it('recovers planSubmitted state from a previous session', async () => {
      // Session 1: generate plan and mark as submitted
      const conv1 = createConversation('ts-submitted-recover');
      mockTextResponse(VALID_YAML_PLAN);
      await conv1.sendMessage('Generate a plan');

      // Simulate submission persisted via sendMessage
      mockTextResponse('Executing plan now.');
      // Manually set planSubmitted through executeTool then save via sendMessage
      await conv1.executeTool('submit_plan', {});

      // Save the submitted state via a follow-up exchange
      mockTextResponse('Done!');
      await conv1.sendMessage('Confirmed');

      // Session 2: recover
      const conv2 = createConversation('ts-submitted-recover');
      await conv2.init();

      expect(conv2.planSubmitted).toBe(true);
    });

    it('continues conversation after recovery', async () => {
      // Session 1: start conversation
      const conv1 = createConversation('ts-continue');
      mockTextResponse('What kind of API?');
      await conv1.sendMessage('Build an API');

      // Session 2: recover and continue
      const conv2 = createConversation('ts-continue');
      mockTextResponse('Got it. Here is a plan for a REST API.');
      await conv2.sendMessage('A REST API with Express');

      // Should have 4 messages total (2 from session 1 + 2 from session 2)
      const saved = repo.loadConversation('ts-continue');
      expect(saved!.messages.length).toBeGreaterThanOrEqual(4);
    });

    it('init is idempotent — calling twice does not duplicate state', async () => {
      const conv1 = createConversation('ts-idempotent');
      mockTextResponse('Hi');
      await conv1.sendMessage('Hello');

      const conv2 = createConversation('ts-idempotent');
      await conv2.init();
      await conv2.init(); // Second call should be a no-op

      expect(conv2.history.length).toBeGreaterThanOrEqual(2);
    });

    it('init is called automatically on first sendMessage', async () => {
      // Session 1: create state
      const conv1 = createConversation('ts-auto-init');
      mockTextResponse('Hello');
      await conv1.sendMessage('Hi');

      // Session 2: skip init(), just sendMessage
      const conv2 = createConversation('ts-auto-init');
      mockTextResponse('Continuing from where we left off.');
      await conv2.sendMessage('Continue please');

      // Should have recovered messages from session 1 + new messages
      const saved = repo.loadConversation('ts-auto-init');
      expect(saved!.messages.length).toBeGreaterThanOrEqual(4);
    });

    it('handles recovery when database has no saved state', async () => {
      const conv = createConversation('ts-no-state');
      await conv.init();

      // Should start fresh
      expect(conv.history).toHaveLength(0);
      expect(conv.submittedPlan).toBeNull();
      expect(conv.planSubmitted).toBe(false);
    });
  });

  // ── Reset and cleanup ──────────────────────────────────

  describe('reset and cleanup', () => {
    it('reset deletes conversation from database', async () => {
      const conv = createConversation('ts-reset');
      mockTextResponse(VALID_YAML_PLAN);
      await conv.sendMessage('Generate plan');

      expect(repo.loadConversation('ts-reset')).not.toBeNull();

      conv.reset();

      expect(repo.loadConversation('ts-reset')).toBeNull();
      expect(conv.history).toHaveLength(0);
      expect(conv.submittedPlan).toBeNull();
      expect(conv.planSubmitted).toBe(false);
    });

    it('reset without repo configured does not throw', () => {
      const conv = new PlanConversation({ apiKey: 'test-key' });
      expect(() => conv.reset()).not.toThrow();
    });

    it('conversation can be restarted after reset', async () => {
      const conv = createConversation('ts-restart');
      mockTextResponse('Initial response');
      await conv.sendMessage('First conversation');

      conv.reset();

      mockTextResponse('Fresh start');
      await conv.sendMessage('New conversation');

      expect(conv.history).toHaveLength(2);
      expect(conv.history[0].content).toBe('New conversation');

      const saved = repo.loadConversation('ts-restart');
      expect(saved).not.toBeNull();
      expect(saved!.messages).toHaveLength(2);
    });
  });

  // ── Plan extraction and submission state ───────────────

  describe('plan extraction and submission persistence', () => {
    it('submit_plan picks up the latest plan from history', async () => {
      const conv = createConversation('ts-plan-update');

      const firstYaml = '```yaml\nname: "Plan A"\ntasks:\n  - id: t1\n    description: "Task A"\n    dependencies: []\n```';
      mockTextResponse(firstYaml);
      await conv.sendMessage('Generate plan A');

      const secondYaml = '```yaml\nname: "Plan B"\ntasks:\n  - id: t1\n    description: "Task B"\n    dependencies: []\n```';
      mockTextResponse(secondYaml);
      await conv.sendMessage('Actually, generate plan B');

      const result = await conv.executeTool('submit_plan', {});
      expect(result).toContain('Plan B');
      expect(conv.submittedPlan!.name).toBe('Plan B');
    });

    it('complex plan is correctly found by submit_plan', async () => {
      const complexYaml = `\`\`\`yaml
name: "Complex Plan"
onFinish: pull_request
baseBranch: develop
featureBranch: feature/complex
tasks:
  - id: setup
    description: "Setup project"
    command: "npm install"
    dependencies: []
  - id: implement
    description: "Implement feature"
    prompt: "Add the feature"
    dependencies:
      - setup
    pivot: true
    experimentVariants:
      - id: approach-a
        description: "Approach A"
        prompt: "Try approach A"
      - id: approach-b
        description: "Approach B"
        prompt: "Try approach B"
  - id: test
    description: "Run tests"
    command: "npm test"
    dependencies:
      - implement
    requiresManualApproval: true
\`\`\``;

      const conv = createConversation('ts-complex');
      mockTextResponse(complexYaml);
      await conv.sendMessage('Generate a complex plan');

      const result = await conv.executeTool('submit_plan', {});
      expect(result).toContain('submitted for execution');

      const plan = conv.submittedPlan!;
      expect(plan.name).toBe('Complex Plan');
      expect(plan.onFinish).toBe('pull_request');
      expect(plan.baseBranch).toBe('develop');
      expect(plan.featureBranch).toBe('feature/complex');
      expect(plan.tasks).toHaveLength(3);
      expect(plan.tasks[1].pivot).toBe(true);
      expect(plan.tasks[1].experimentVariants).toHaveLength(2);
      expect(plan.tasks[2].requiresManualApproval).toBe(true);
    });
  });

  // ── Error resilience ───────────────────────────────────

  describe('error resilience', () => {
    it('conversation continues when persistence fails on save', async () => {
      // Create a conversation with a repo that will fail on save
      const failingRepo = new ConversationRepository(adapter, silentLogger);
      vi.spyOn(failingRepo, 'saveConversation').mockImplementation(() => {
        throw new Error('Database write failed');
      });

      const conv = new PlanConversation({
        apiKey: 'test-key',
        threadTs: 'ts-fail',
        conversationRepo: failingRepo,
      });

      mockTextResponse('Hello!');
      // Should not throw despite persistence failure
      const reply = await conv.sendMessage('Hi');
      expect(reply).toBe('Hello!');
    });

    it('conversation starts fresh when persistence fails on load', async () => {
      // Create some state first
      const conv1 = createConversation('ts-load-fail');
      mockTextResponse('First session');
      await conv1.sendMessage('Hello');

      // Create a conversation with a repo that fails on load
      const failingRepo = new ConversationRepository(adapter, silentLogger);
      vi.spyOn(failingRepo, 'loadConversation').mockImplementation(() => {
        throw new Error('Database read failed');
      });

      const conv2 = new PlanConversation({
        apiKey: 'test-key',
        threadTs: 'ts-load-fail',
        conversationRepo: failingRepo,
      });

      await conv2.init();

      // Should start fresh rather than crashing
      expect(conv2.history).toHaveLength(0);
      expect(conv2.submittedPlan).toBeNull();
    });
  });

  // ── E2E: full round-trip with restart ──────────────────

  describe('E2E: full round-trip with restart', () => {
    it('recovers conversation after restart, submit_plan scans history for plan', async () => {
      const threadTs = 'ts-e2e-roundtrip';

      // Phase 1: User requests a plan, Claude returns YAML
      const conv1 = createConversation(threadTs);
      mockTextResponse(VALID_YAML_PLAN);
      await conv1.sendMessage('Add a login form to the React app');

      const saved1 = repo.loadConversation(threadTs);
      expect(saved1).not.toBeNull();
      expect(saved1!.messages.length).toBeGreaterThanOrEqual(2);

      // Phase 2: Simulate bot restart — create new PlanConversation, call init()
      const conv2 = createConversation(threadTs);
      await conv2.init();

      // Verify recovery of messages
      expect(conv2.history.length).toBeGreaterThanOrEqual(2);
      expect(conv2.history[0].content).toContain('Add a login form');

      // Phase 3: User says "execute" — Claude calls submit_plan tool
      // submit_plan now scans history to find the YAML plan
      mockToolUseResponse([{ id: 'tool-1', name: 'submit_plan', input: {} }]);
      mockTextResponse('Plan submitted! Starting execution.');
      await conv2.sendMessage('execute');

      // Verify plan was submitted and found via history scan
      expect(conv2.planSubmitted).toBe(true);
      expect(conv2.submittedPlan).not.toBeNull();
      expect(conv2.submittedPlan!.name).toBe('Test Plan');

      // Verify full conversation persisted
      const saved2 = repo.loadConversation(threadTs);
      expect(saved2!.messages.length).toBeGreaterThanOrEqual(4);
      expect(saved2!.planSubmitted).toBe(true);
    });

    it('recovered conversation retains message count for Claude context', async () => {
      const threadTs = 'ts-e2e-context';

      // Multi-turn conversation
      const conv1 = createConversation(threadTs);
      mockTextResponse('What kind of form? Login, signup, or contact?');
      await conv1.sendMessage('Add a form');

      mockTextResponse(VALID_YAML_PLAN);
      await conv1.sendMessage('A login form with email and password');

      // Should have 4 messages (2 user + 2 assistant)
      const saved = repo.loadConversation(threadTs);
      expect(saved!.messages.length).toBe(4);

      // Restart
      const conv2 = createConversation(threadTs);
      await conv2.init();

      // Verify Claude will see all prior messages
      expect(conv2.history.length).toBe(4);
    });
  });

  // ── Tool-use loop with persistence ─────────────────────

  describe('tool-use loop with persistence', () => {
    it('persists state after tool-use loop completes', async () => {
      const conv = new PlanConversation({
        apiKey: 'test-key',
        workingDir: '/fake/dir',
        threadTs: 'ts-tools',
        conversationRepo: repo,
      });

      // Tool use → text response loop
      mockToolUseResponse([{ id: 'tool-1', name: 'list_files', input: {} }]);
      vi.spyOn(conv, 'executeTool').mockResolvedValueOnce('src/\npackage.json');
      mockTextResponse(VALID_YAML_PLAN);

      await conv.sendMessage('Explore and generate plan');

      const saved = repo.loadConversation('ts-tools');
      expect(saved).not.toBeNull();
      // Messages include: user msg, assistant (tool_use), user (tool_result), assistant (text)
      expect(saved!.messages.length).toBeGreaterThanOrEqual(3);
      // extractedPlan is no longer persisted; plan is scanned on demand
      expect(saved!.extractedPlan).toBeNull();
    });
  });
});
