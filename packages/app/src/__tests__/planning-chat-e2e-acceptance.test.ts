import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInvokerHomeRoot } from '@invoker/contracts';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import {
  createInAppPlanningChatSessions,
  createPlanningChatSession,
  rebindPlanningChatRepo,
  sendPlanningChatMessage,
  submitPlanningChatDraft,
} from '../in-app-planner.js';
import type { PlanningRepoPool } from '../planning-chat-worktree.js';
import { SQLiteAdapter } from '@invoker/data-store';

const REPO_A = 'https://example.com/repo-a.git';
const REPO_B = 'https://example.com/repo-b.git';
const REAPER_INCIDENT_PLAN_TEXT = readFileSync(
  fileURLToPath(new URL('./fixtures/planning-review-ad665bff.yaml', import.meta.url)),
  'utf8',
).trim();

const EXPLORE_REPLY = 'This repo is an Invoker planning chat redesign. No draft was requested.';

const PLAN_A_REPLY = `Here is the plan.

\`\`\`yaml
name: Plan A
onFinish: none
tasks:
  - id: only
    description: Only task
    command: echo a
\`\`\``;
const PLAN_A_TEXT = `name: Plan A
onFinish: none
tasks:
  - id: only
    description: Only task
    command: echo a`;

const CRITIQUE_REPLY_WITH_COINCIDENTAL_YAML = `Sure, that dependency is optional.

\`\`\`yaml
name: Coincidental Restatement
onFinish: none
tasks:
  - id: only
    description: Only task
    command: echo coincidental
\`\`\``;

const PLAN_C_REPLY = `Here is the revised plan against the new repo.

\`\`\`yaml
name: Plan C
onFinish: none
tasks:
  - id: only
    description: Only task
    command: echo c
\`\`\``;
const PLAN_C_TEXT = `name: Plan C
onFinish: none
tasks:
  - id: only
    description: Only task
    command: echo c`;

function createFakeRepoPool(bindings: Record<string, { worktreePath: string; headSha: string }>): PlanningRepoPool {
  return {
    ensureCloneThroughRepoQueue: vi.fn(async (repoUrl: string) => bindings[repoUrl]?.worktreePath ?? '/fake/clone'),
    resolveBaseCommit: vi.fn(async (repoUrl: string) => {
      const binding = bindings[repoUrl];
      if (!binding) throw new Error(`No fake binding registered for ${repoUrl}`);
      return binding.headSha;
    }),
    acquireWorktree: vi.fn(async (repoUrl: string, branch: string) => {
      const binding = bindings[repoUrl];
      if (!binding) throw new Error(`No fake binding registered for ${repoUrl}`);
      mkdirSync(binding.worktreePath, { recursive: true });
      return {
        clonePath: '/fake/clone',
        worktreePath: binding.worktreePath,
        branch,
        release: vi.fn(async () => {}),
        softRelease: vi.fn(),
      };
    }),
    externalWorktreePath: vi.fn((repoUrl: string) => bindings[repoUrl]?.worktreePath ?? '/fake/nonexistent'),
  };
}

function sidecarPathFor(sessionId: string): string {
  return join(resolveInvokerHomeRoot(), 'plan-drafts', `${sessionId}.yaml`);
}

describe('planning chat E2E acceptance: explore -> draft -> critique -> repo switch -> re-draft -> submit', () => {
  let sessionId: string | undefined;

  afterEach(() => {
    if (sessionId) rmSync(sidecarPathFor(sessionId), { force: true });
    vi.restoreAllMocks();
  });

  it('proves worktree binding, durable draft persistence, post-draft immutability, repo-switch invalidation, and DB-identical submit all hold together across one continuous session', async () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'planning-chat-e2e-'));
    const repoPool = createFakeRepoPool({
      [REPO_A]: { worktreePath: join(worktreeRoot, 'repo-a'), headSha: 'sha-repo-a' },
      [REPO_B]: { worktreePath: join(worktreeRoot, 'repo-b'), headSha: 'sha-repo-b' },
    });
    const adapter = await SQLiteAdapter.create(':memory:');
    const sessions = createInAppPlanningChatSessions();
    const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));
    const loadGeneratedPlan = vi.fn(async (planText: string) => ({
      planName: 'Submitted Plan',
      workflowId: 'wf-e2e-1',
      submittedPlanText: planText,
    }));

    const spawnPlanner = vi.spyOn(PlanConversation.prototype, 'spawnPlanner');

    try {
      const created = await createPlanningChatSession({}, {
        config: { defaultRepoUrl: REPO_A, defaultBranch: 'main' },
        loadGeneratedPlan,
        sessions,
        planningCommandBuilder,
        repoPool,
        planningSessionStore: adapter,
      });
      if (!created.ok) throw new Error(created.error);
      sessionId = created.session.id;

      expect(created.session.repoUrl).toBe(REPO_A);
      expect(created.session.baseCommit).toBe('sha-repo-a');

      spawnPlanner.mockResolvedValueOnce(EXPLORE_REPLY);
      const exploreTurn = await sendPlanningChatMessage({
        sessionId,
        message: 'What does this repo do?',
      }, {
        config: { defaultRepoUrl: REPO_A, defaultBranch: 'main' },
        loadGeneratedPlan,
        sessions,
        planningCommandBuilder,
        repoPool,
        planningSessionStore: adapter,
      });
      if (!exploreTurn.ok) throw new Error(exploreTurn.error);
      expect(exploreTurn.draftPlanAvailable).toBe(false);
      expect(sessions.get(sessionId)?.draftPlanText).toBeUndefined();
      expect(sessions.get(sessionId)?.status).not.toBe('draft_ready');
      expect(existsSync(sidecarPathFor(sessionId))).toBe(false);

      spawnPlanner.mockResolvedValueOnce(PLAN_A_REPLY);
      const draftTurn = await sendPlanningChatMessage({
        sessionId,
        message: 'draft the full plan',
      }, {
        config: { defaultRepoUrl: REPO_A, defaultBranch: 'main' },
        loadGeneratedPlan,
        sessions,
        planningCommandBuilder,
        repoPool,
        planningSessionStore: adapter,
      });
      if (!draftTurn.ok) throw new Error(draftTurn.error);
      expect(sessions.get(sessionId)?.status).toBe('draft_ready');
      const planAText = sessions.get(sessionId)?.draftPlanText;
      expect(planAText).toBe(PLAN_A_TEXT);
      expect(adapter.loadInAppPlanningSession(sessionId)?.draftPlanText).toBe(PLAN_A_TEXT);
      expect(existsSync(sidecarPathFor(sessionId))).toBe(true);
      expect(readFileSync(sidecarPathFor(sessionId), 'utf8')).toBe(PLAN_A_TEXT);

      spawnPlanner.mockResolvedValueOnce(CRITIQUE_REPLY_WITH_COINCIDENTAL_YAML);
      const critiqueTurn = await sendPlanningChatMessage({
        sessionId,
        message: 'Can we skip the extra dependency?',
      }, {
        config: { defaultRepoUrl: REPO_A, defaultBranch: 'main' },
        loadGeneratedPlan,
        sessions,
        planningCommandBuilder,
        repoPool,
        planningSessionStore: adapter,
      });
      if (!critiqueTurn.ok) throw new Error(critiqueTurn.error);
      expect(sessions.get(sessionId)?.draftPlanText).toBe(planAText);
      expect(sessions.get(sessionId)?.status).toBe('draft_ready');
      expect(adapter.loadInAppPlanningSession(sessionId)?.draftPlanText).toBe(planAText);

      const rebindResult = await rebindPlanningChatRepo({
        sessionId,
        repoUrl: REPO_B,
        baseBranch: 'main',
      }, {
        config: {},
        sessions,
        repoPool,
        planningSessionStore: adapter,
      });
      expect(rebindResult).toEqual({ ok: true, action: 'invalidate_and_block_submit' });
      expect(sessions.get(sessionId)?.draftPlanText).toBeUndefined();
      expect(sessions.get(sessionId)?.status).toBe('still_discussing');
      expect(sessions.get(sessionId)?.repoUrl).toBe(REPO_B);
      expect(sessions.get(sessionId)?.baseCommit).toBe('sha-repo-b');
      expect(adapter.loadInAppPlanningSession(sessionId)?.draftPlanText).toBeUndefined();
      expect(existsSync(sidecarPathFor(sessionId))).toBe(false);
      const invalidateMessage = sessions.get(sessionId)?.messages.at(-1);
      expect(invalidateMessage?.tone).toBe('error');

      const submitBeforeRedraft = await submitPlanningChatDraft({ sessionId }, {
        sessions,
        loadGeneratedPlan,
        planningSessionStore: adapter,
      });
      expect(submitBeforeRedraft.ok).toBe(false);
      expect(loadGeneratedPlan).not.toHaveBeenCalled();

      spawnPlanner.mockResolvedValueOnce(PLAN_C_REPLY);
      const redraftTurn = await sendPlanningChatMessage({
        sessionId,
        message: 'draft the full plan again',
      }, {
        config: { defaultRepoUrl: REPO_B, defaultBranch: 'main' },
        loadGeneratedPlan,
        sessions,
        planningCommandBuilder,
        repoPool,
        planningSessionStore: adapter,
      });
      if (!redraftTurn.ok) throw new Error(redraftTurn.error);
      expect(sessions.get(sessionId)?.status).toBe('draft_ready');
      const planCText = sessions.get(sessionId)?.draftPlanText;
      expect(planCText).toBe(PLAN_C_TEXT);
      expect(planCText).not.toBe(planAText);
      expect(adapter.loadInAppPlanningSession(sessionId)?.draftPlanText).toBe(PLAN_C_TEXT);
      expect(existsSync(sidecarPathFor(sessionId))).toBe(true);
      expect(readFileSync(sidecarPathFor(sessionId), 'utf8')).toBe(PLAN_C_TEXT);

      const dbDraftBeforeSubmit = adapter.loadInAppPlanningSession(sessionId)?.draftPlanText;
      const submitResult = await submitPlanningChatDraft({ sessionId }, {
        sessions,
        loadGeneratedPlan,
        planningSessionStore: adapter,
      });
      if (!submitResult.ok) throw new Error(submitResult.error);

      expect(loadGeneratedPlan).toHaveBeenCalledWith(dbDraftBeforeSubmit);
      expect(loadGeneratedPlan).toHaveBeenCalledWith(planCText);
      expect(submitResult.workflowId).toBe('wf-e2e-1');
      expect(sessions.get(sessionId)?.status).toBe('submitted');
      expect(sessions.get(sessionId)?.submittedWorkflowId).toBe('wf-e2e-1');
      expect(existsSync(sidecarPathFor(sessionId))).toBe(true);
      expect(readFileSync(sidecarPathFor(sessionId), 'utf8')).toBe(PLAN_C_TEXT);
    } finally {
      adapter.close();
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });
});

describe('planning chat incident ad665bff: valid sidecar after repository answer', () => {
  let incidentSessionId: string | undefined;

  afterEach(() => {
    if (incidentSessionId) rmSync(sidecarPathFor(incidentSessionId), { force: true });
    vi.restoreAllMocks();
  });

  it.fails('persists the exact recovered reaper draft and makes it review-ready', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'planning-chat-ad665bff-'));
    const adapter = await SQLiteAdapter.create(':memory:');
    const sessions = createInAppPlanningChatSessions();
    const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));
    const loadGeneratedPlan = vi.fn(async () => ({
      planName: 'Reaper workers for finished e2e and admin-bypass tasks',
      workflowId: 'wf-reaper-incident',
    }));

    try {
      const created = await createPlanningChatSession({}, {
        config: { defaultRepoUrl: REPO_A, defaultBranch: 'main' },
        loadGeneratedPlan,
        sessions,
        planningCommandBuilder,
        planningSessionStore: adapter,
        workingDir,
      });
      if (!created.ok) throw new Error(created.error);
      incidentSessionId = created.session.id;

      vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockImplementationOnce(function writeIncidentSidecar() {
        const planDraftPath = this.planDraftFilePath();
        if (!planDraftPath) throw new Error('Incident repro requires a plan draft path.');
        writeFileSync(planDraftPath, REAPER_INCIDENT_PLAN_TEXT, 'utf8');
        return Promise.resolve('I wrote the 3-slice plan to the draft file.');
      });

      const result = await sendPlanningChatMessage({
        sessionId: incidentSessionId,
        message: 'github.com/Neko-Catpital-Labs/Invoker/',
      }, {
        config: { defaultRepoUrl: REPO_A, defaultBranch: 'main' },
        loadGeneratedPlan,
        sessions,
        planningCommandBuilder,
        planningSessionStore: adapter,
        workingDir,
      });
      if (!result.ok) throw new Error(result.error);

      expect(result.draftPlanAvailable).toBe(true);
      expect(result.draftPlanText).toBe(REAPER_INCIDENT_PLAN_TEXT);
      expect(result.draftPlanSummary).toMatchObject({
        name: 'Reaper workers for finished e2e and admin-bypass tasks',
        workflowCount: 3,
        taskCount: 6,
      });
      expect(sessions.get(incidentSessionId)?.status).toBe('draft_ready');
      expect(adapter.loadInAppPlanningSession(incidentSessionId)?.draftPlanText).toBe(REAPER_INCIDENT_PLAN_TEXT);
    } finally {
      adapter.close();
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
