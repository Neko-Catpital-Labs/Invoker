import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import {
  createInAppPlanningChatSessions,
  createPlanningChatSession,
  sendPlanningChatMessage,
} from '../in-app-planner.js';

const VALID_PLAN_TEXT = `name: Mock Plan
onFinish: none
tasks:
  - id: first
    description: First task
    command: echo first
  - id: second
    description: Second task
    dependencies: [first]
    command: echo second`;

describe('in-app planner draft folder', () => {
  const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));
  const originalDbDir = process.env.INVOKER_DB_DIR;
  let invokerHome: string;
  let workingDir: string;

  beforeEach(() => {
    invokerHome = mkdtempSync(join(tmpdir(), 'in-app-draft-home-'));
    workingDir = mkdtempSync(join(tmpdir(), 'in-app-draft-bundle-'));
    chmodSync(workingDir, 0o555);
    process.env.INVOKER_DB_DIR = invokerHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = originalDbDir;
    }
    chmodSync(workingDir, 0o755);
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(invokerHome, { recursive: true, force: true });
  });

  it('stages a draft under the Invoker home when the working folder is read-only', async () => {
    const sessions = createInAppPlanningChatSessions();
    const created = await createPlanningChatSession({}, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      workingDir,
    });
    if (!created.ok) throw new Error(created.error);
    const session = sessions.get(created.session.id);
    if (!session) throw new Error('expected session in map');

    const draftPath = session.conversation.planDraftFilePath();
    if (!draftPath) throw new Error('expected draft path');
    expect(draftPath.startsWith(invokerHome)).toBe(true);
    expect(draftPath.startsWith(workingDir)).toBe(false);
    expect(draftPath).not.toBe(join(invokerHome, 'plan-drafts', `${session.id}.yaml`));

    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockImplementation(async () => {
      writeFileSync(draftPath, VALID_PLAN_TEXT, 'utf8');
      return 'Plan written.';
    });

    const result = await sendPlanningChatMessage({
      sessionId: session.id,
      message: 'draft the full plan',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      workingDir,
    });

    expect(result).toMatchObject({ ok: true, draftPlanAvailable: true });
    expect(sessions.get(session.id)?.draftPlanText).toBe(VALID_PLAN_TEXT);
  });
});
