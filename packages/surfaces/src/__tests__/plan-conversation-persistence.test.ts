import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanConversation, extractYamlPlan } from '../slack/plan-conversation.js';
import { SQLiteAdapter } from '@invoker/data-store';
import { ConversationRepository } from '@invoker/data-store';
import type { PlanDefinition } from '@invoker/workflow-core';
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

// ── Helpers ─────────────────────────────────────────────────

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

  beforeEach(async () => {
    mockSpawn.mockReset();
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, silentLogger);
  });

  afterEach(() => {
    adapter.close();
  });

  function createConversation(threadTs: string, mode: 'agent' | 'plan' = 'plan'): PlanConversation {
    return new PlanConversation({
      threadTs,
      conversationRepo: repo,
      mode,
    });
  }

  // ── Basic persistence ──────────────────────────────────

  describe('basic state persistence', () => {
    it('saves conversation state after each exchange', async () => {
      const conv = createConversation('ts-1');
      mockCursorResponse('Hello! What would you like to build?');
      await conv.sendMessage('I want to add a REST API');

      const saved = repo.loadConversation('ts-1');
      expect(saved).not.toBeNull();
      expect(saved!.messages.length).toBeGreaterThanOrEqual(2);
    });

    it('persists conversation mode for recovery', async () => {
      const conv = createConversation('ts-agent-mode', 'agent');
      mockCursorResponse('Done locally.');
      await conv.sendMessage('Fix the local docs');

      const saved = repo.loadConversation('ts-agent-mode');
      expect(saved?.mode).toBe('agent');

      const recovered = createConversation('ts-agent-mode');
      await recovered.init();
      expect(recovered.conversationMode).toBe('agent');
    });

    it('no longer persists extractedPlan (plan is scanned on demand)', async () => {
      const conv = createConversation('ts-plan');
      mockCursorResponse(VALID_YAML_PLAN);
      await conv.sendMessage('Generate a plan');

      const saved = repo.loadConversation('ts-plan');
      expect(saved!.extractedPlan).toBeNull();
    });

    it('a drafted plan is recoverable from persistence via getDraftedPlan', async () => {
      const conv = createConversation('ts-submit');
      mockCursorResponse(VALID_YAML_PLAN);
      await conv.sendMessage('Generate a plan');
      expect(conv.planSubmitted).toBe(false);

      const recovered = createConversation('ts-submit');
      await recovered.init();
      const drafted = recovered.getDraftedPlan();
      expect(drafted).not.toBeNull();
      expect(drafted).toContain('Test Plan');
    });

    it('does not persist when no repo is configured', async () => {
      const conv = new PlanConversation({});
      mockCursorResponse('Hi there');
      await conv.sendMessage('Hello');
      expect(conv.history).toHaveLength(2);
    });

    it('does not persist when no threadTs is configured', async () => {
      const conv = new PlanConversation({ conversationRepo: repo });
      mockCursorResponse('Hi there');
      await conv.sendMessage('Hello');
      expect(repo.listActiveConversations()).toEqual([]);
    });
  });

  // ── Recovery after restart ─────────────────────────────

  describe('conversation recovery after restart', () => {
    it('recovers messages from a previous session', async () => {
      const conv1 = createConversation('ts-recover');
      mockCursorResponse('Tell me more about the feature.');
      await conv1.sendMessage('I want to build a chat app');

      const conv2 = createConversation('ts-recover');
      await conv2.init();

      expect(conv2.history.length).toBeGreaterThanOrEqual(2);
      expect(conv2.history[0]).toEqual(
        expect.objectContaining({ role: 'user', content: 'I want to build a chat app' }),
      );
    });

    it('recovered session exposes the drafted plan via getDraftedPlan', async () => {
      const conv1 = createConversation('ts-plan-recover');
      mockCursorResponse(VALID_YAML_PLAN);
      await conv1.sendMessage('Generate a plan for REST API');

      const conv2 = createConversation('ts-plan-recover');
      await conv2.init();

      const drafted = conv2.getDraftedPlan();
      expect(drafted).not.toBeNull();
      expect(typeof drafted).toBe('string');
      expect(drafted).toContain('Test Plan');
    });

    it('recovers planSubmitted state from a previous session', async () => {
      // The conversation flow never flips planSubmitted, but a value already
      // persisted in the repo must still round-trip back through init().
      repo.saveConversation('ts-submitted-recover', [
        { role: 'user', content: 'Generate a plan' },
        { role: 'assistant', content: VALID_YAML_PLAN },
      ], null, true);

      const conv2 = createConversation('ts-submitted-recover');
      await conv2.init();
      expect(conv2.planSubmitted).toBe(true);
    });

    it('continues conversation after recovery', async () => {
      const conv1 = createConversation('ts-continue');
      mockCursorResponse('What kind of API?');
      await conv1.sendMessage('Build an API');

      const conv2 = createConversation('ts-continue');
      mockCursorResponse('Got it. Here is a plan for a REST API.');
      await conv2.sendMessage('A REST API with Express');

      const saved = repo.loadConversation('ts-continue');
      expect(saved!.messages.length).toBeGreaterThanOrEqual(4);
    });

    it('init is idempotent — calling twice does not duplicate state', async () => {
      const conv1 = createConversation('ts-idempotent');
      mockCursorResponse('Hi');
      await conv1.sendMessage('Hello');

      const conv2 = createConversation('ts-idempotent');
      await conv2.init();
      await conv2.init();
      expect(conv2.history.length).toBeGreaterThanOrEqual(2);
    });

    it('init is called automatically on first sendMessage', async () => {
      const conv1 = createConversation('ts-auto-init');
      mockCursorResponse('Hello');
      await conv1.sendMessage('Hi');

      const conv2 = createConversation('ts-auto-init');
      mockCursorResponse('Continuing from where we left off.');
      await conv2.sendMessage('Continue please');

      const saved = repo.loadConversation('ts-auto-init');
      expect(saved!.messages.length).toBeGreaterThanOrEqual(4);
    });

    it('handles recovery when database has no saved state', async () => {
      const conv = createConversation('ts-no-state');
      await conv.init();
      expect(conv.history).toHaveLength(0);
      expect(conv.submittedPlanText).toBeNull();
      expect(conv.planSubmitted).toBe(false);
    });
  });

  // ── Reset and cleanup ──────────────────────────────────

  describe('reset and cleanup', () => {
    it('reset deletes conversation from database', async () => {
      const conv = createConversation('ts-reset');
      mockCursorResponse(VALID_YAML_PLAN);
      await conv.sendMessage('Generate plan');

      expect(repo.loadConversation('ts-reset')).not.toBeNull();
      conv.reset();

      expect(repo.loadConversation('ts-reset')).toBeNull();
      expect(conv.history).toHaveLength(0);
      expect(conv.submittedPlanText).toBeNull();
      expect(conv.planSubmitted).toBe(false);
    });

    it('reset without repo configured does not throw', () => {
      const conv = new PlanConversation({});
      expect(() => conv.reset()).not.toThrow();
    });

    it('conversation can be restarted after reset', async () => {
      const conv = createConversation('ts-restart');
      mockCursorResponse('Initial response');
      await conv.sendMessage('First conversation');

      conv.reset();

      mockCursorResponse('Fresh start');
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
    it('getDraftedPlan picks up the latest plan from history', async () => {
      const conv = createConversation('ts-plan-update');

      mockCursorResponse('```yaml\nname: "Plan A"\ntasks:\n  - id: t1\n    description: "Task A"\n    dependencies: []\n```');
      await conv.sendMessage('Generate plan A');

      mockCursorResponse('```yaml\nname: "Plan B"\ntasks:\n  - id: t1\n    description: "Task B"\n    dependencies: []\n```');
      await conv.sendMessage('Actually, generate plan B');

      const drafted = conv.getDraftedPlan();
      expect(drafted).not.toBeNull();
      expect(drafted).toContain('Plan B');
      expect(conv.planSubmitted).toBe(false);
    });

    it('complex plan is correctly found by getDraftedPlan', async () => {
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
      mockCursorResponse(complexYaml);
      await conv.sendMessage('Generate a complex plan');

      const planText = conv.getDraftedPlan();
      expect(planText).not.toBeNull();
      expect(typeof planText).toBe('string');
      // Parse to verify structure is preserved
      const { parse: parseYaml } = await import('yaml');
      const plan = parseYaml(planText!) as Record<string, any>;
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
      const failingRepo = new ConversationRepository(adapter, silentLogger);
      vi.spyOn(failingRepo, 'saveConversation').mockImplementation(() => {
        throw new Error('Database write failed');
      });

      const conv = new PlanConversation({
        threadTs: 'ts-fail',
        conversationRepo: failingRepo,
      });

      mockCursorResponse('Hello!');
      const reply = await conv.sendMessage('Hi');
      expect(reply).toBe('Hello!');
    });

    it('conversation starts fresh when persistence fails on load', async () => {
      const conv1 = createConversation('ts-load-fail');
      mockCursorResponse('First session');
      await conv1.sendMessage('Hello');

      const failingRepo = new ConversationRepository(adapter, silentLogger);
      vi.spyOn(failingRepo, 'loadConversation').mockImplementation(() => {
        throw new Error('Database read failed');
      });

      const conv2 = new PlanConversation({
        threadTs: 'ts-load-fail',
        conversationRepo: failingRepo,
      });

      await conv2.init();
      expect(conv2.history).toHaveLength(0);
      expect(conv2.submittedPlanText).toBeNull();
    });
  });

  // ── E2E: full round-trip with restart ──────────────────

  describe('E2E: full round-trip with restart', () => {
    it('recovers conversation after restart and exposes the drafted plan', async () => {
      const threadTs = 'ts-e2e-roundtrip';

      const conv1 = createConversation(threadTs);
      mockCursorResponse(VALID_YAML_PLAN);
      await conv1.sendMessage('Add a login form to the React app');

      const saved1 = repo.loadConversation(threadTs);
      expect(saved1).not.toBeNull();
      expect(saved1!.messages.length).toBeGreaterThanOrEqual(2);

      const conv2 = createConversation(threadTs);
      await conv2.init();

      expect(conv2.history.length).toBeGreaterThanOrEqual(2);
      expect(conv2.history[0].content).toContain('Add a login form');

      const drafted = conv2.getDraftedPlan();
      expect(drafted).not.toBeNull();
      expect(drafted).toContain('Test Plan');
      expect(conv2.planSubmitted).toBe(false);
    });

    it('recovered conversation retains message count for context', async () => {
      const threadTs = 'ts-e2e-context';

      const conv1 = createConversation(threadTs);
      mockCursorResponse('What kind of form? Login, signup, or contact?');
      await conv1.sendMessage('Add a form');

      mockCursorResponse(VALID_YAML_PLAN);
      await conv1.sendMessage('A login form with email and password');

      const saved = repo.loadConversation(threadTs);
      expect(saved!.messages.length).toBe(4);

      const conv2 = createConversation(threadTs);
      await conv2.init();
      expect(conv2.history.length).toBe(4);
    });
  });
});
