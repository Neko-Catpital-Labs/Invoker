import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import * as child_process from 'node:child_process';
import { buildPlanSystemPrompt, PlanConversation, isConfirmation } from '../slack/plan-conversation.js';

// Activation side: the planner is told to write the full plan to the draft file
// and reply with a summary, and each turn starts from a cleared file so a prior
// turn's plan can never be mistaken for the current one.

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(child_process.spawn);
const testDir = dirname(fileURLToPath(import.meta.url));

function fakePlannerChild(stdout: string, beforeClose?: () => void): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    beforeClose?.();
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);
  return proc;
}

const VALID_PLAN_YAML = `name: "Draft Activation"
onFinish: none
tasks:
  - id: implement
    description: "Implement the change"
    prompt: "Do the work"
    dependencies: []
`;

const SUBMIT_REPLY_LINE = 'Reply `submit` to submit it.';

const INLINE_PLAN_RESPONSE = `Here is the plan:

\`\`\`yaml
name: "Draft Activation"
onFinish: none
tasks:
  - id: implement
    description: "Implement the change"
    prompt: "Do the work"
    dependencies: []
\`\`\`

${SUBMIT_REPLY_LINE}`;

describe('plan draft file - activation side', () => {
  let workingDir: string;

  beforeEach(() => {
    mockSpawn.mockReset();
    workingDir = mkdtempSync(join(tmpdir(), 'plan-draft-act-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('instructs the planner to write the plan to the draft file instead of inline', () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', plannerRetryLimit: 0 });
    const path = conversation.planDraftFilePath();
    const prompt = conversation.buildCursorPrompt();

    expect(path).not.toBeNull();
    expect(prompt).toContain(String(path));
    expect(prompt).toContain(`write the COMPLETE YAML to \`${String(path)}\``);
    expect(prompt).toContain('Then reply in chat with only a one-or-two-sentence summary. Never paste the YAML into chat.');
    expect(prompt).not.toContain('output the plan inside a ```yaml code block');
  });

  it('keeps the inline instruction when there is no draft file path', () => {
    const conversation = new PlanConversation({ plannerRetryLimit: 0 });
    const prompt = conversation.buildCursorPrompt();

    expect(conversation.planDraftFilePath()).toBeNull();
    expect(prompt).toContain('When the final YAML plan is ready, output the COMPLETE YAML inside a ```yaml code block.');
  });

  it('keeps the last valid plan after a later turn clears its draft file', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', plannerRetryLimit: 0 });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      `Drafted the plan.\n\n${SUBMIT_REPLY_LINE}`,
      () => writeFileSync(path, VALID_PLAN_YAML, 'utf8'),
    ));
    const firstReply = await conversation.sendMessage('Draft it');
    expect(firstReply).toContain(SUBMIT_REPLY_LINE);

    mockSpawn.mockReturnValueOnce(fakePlannerChild(`Drafted the plan. Summary: one step.\n\n${SUBMIT_REPLY_LINE}`));
    const followUpReply = await conversation.sendMessage('What does it do?');

    expect(existsSync(path)).toBe(false);
    expect(followUpReply).toBe('Drafted the plan. Summary: one step.');
    expect(conversation.history[conversation.history.length - 1]?.content).toBe(followUpReply);
    expect(conversation.getDraftedPlan()).toBe(VALID_PLAN_YAML.trim());
  });

  it('does not expose a plan when a summary-only turn has no prior draft', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', plannerRetryLimit: 0 });

    mockSpawn.mockReturnValueOnce(fakePlannerChild(`Drafted the plan. Summary: one step.\n\n${SUBMIT_REPLY_LINE}`));
    const reply = await conversation.sendMessage('Draft it');

    expect(reply).toBe('Drafted the plan. Summary: one step.');
    expect(conversation.history[conversation.history.length - 1]?.content).toBe(reply);
    expect(reply).not.toContain(SUBMIT_REPLY_LINE);
    expect(conversation.getDraftedPlan()).toBeNull();
  });

  it('routes approval through the review flow instead of a submit reply', () => {
    const conversation = new PlanConversation({});
    (conversation as any).messages.push({ role: 'user', content: 'Draft a plan' });

    const prompt = conversation.buildCursorPrompt();

    expect(prompt).not.toContain(SUBMIT_REPLY_LINE);
    expect(prompt).toContain('wait for approval before any submission step');
    expect(prompt).toContain('Do not tell the user to reply `submit`');
  });

  it('exposes the latest draft for the submit handler without marking it submitted', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'submit-123', plannerRetryLimit: 0 });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      `Drafted the plan.\n\n${SUBMIT_REPLY_LINE}`,
      () => writeFileSync(path, VALID_PLAN_YAML, 'utf8'),
    ));
    const reply = await conversation.sendMessage('Create the plan');

    expect(reply).toContain(SUBMIT_REPLY_LINE);
    expect(isConfirmation('submit')).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(conversation.planSubmitted).toBe(false);
    expect(conversation.submittedPlanText).toBeNull();

    const draftedPlan = conversation.getDraftedPlan();
    expect(draftedPlan).not.toBeNull();
    const parsedDraft = parseYaml(draftedPlan!) as Record<string, unknown>;
    expect(parsedDraft.name).toBe('Draft Activation');
  });

  it('falls back to the latest inline plan when no draft file path exists', async () => {
    const conversation = new PlanConversation({ plannerRetryLimit: 0 });

    mockSpawn.mockReturnValueOnce(fakePlannerChild(INLINE_PLAN_RESPONSE));
    await conversation.sendMessage('Create the plan');

    const draftedPlan = conversation.getDraftedPlan();
    expect(draftedPlan).not.toBeNull();
    const parsedDraft = parseYaml(draftedPlan!) as Record<string, unknown>;
    expect(parsedDraft.name).toBe('Draft Activation');
  });

  it('does not expose the 76829fbb sidecar incident before the draft passes the full doctor', async () => {
    const conversation = new PlanConversation({
      workingDir,
      threadTs: '76829fbb-432f-4115-b401-72d08c1645a4',
      plannerRetryLimit: 0,
      planDoctorRepairLimit: 0,
      planDoctorScriptPath: join(testDir, '../../../../skills/plan-to-invoker/scripts/skill-doctor.sh'),
    });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');
    const incidentPlan = readFileSync(join(testDir, 'planning-review-76829fbb.yaml'), 'utf8');

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      'Drafted the plan.',
      () => writeFileSync(path, incidentPlan, 'utf8'),
    ));
    const reply = await conversation.sendMessage('Draft the approved plan');

    expect(reply).toContain('Draft not shown: the plan doctor rejected it.');
    expect(reply).toContain('uses "autoFix", which is no longer supported');
    expect(existsSync(path)).toBe(false);
    expect(conversation.lastTurnDraftPlanText).toBeNull();
    expect(conversation.getDraftedPlan()).toBeNull();
  });

  it('exposes the exact candidate when the full doctor passes', async () => {
    const conversation = new PlanConversation({
      workingDir,
      threadTs: 'doctor-pass',
      plannerRetryLimit: 0,
      planDoctorScriptPath: join(testDir, '../../../../skills/plan-to-invoker/scripts/skill-doctor.sh'),
    });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');
    const validPlan = readFileSync(
      join(testDir, '../../../../skills/plan-to-invoker/fixtures/positive/08-bash-wrapped-pipefail.yaml'),
      'utf8',
    ).trim();

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      'Drafted the plan.',
      () => writeFileSync(path, validPlan, 'utf8'),
    ));
    const reply = await conversation.sendMessage('Draft the approved plan');

    expect(reply).toBe('Drafted the plan.');
    expect(conversation.lastTurnDraftPlanText).toBe(validPlan);
    expect(conversation.getDraftedPlan()).toBe(validPlan);
  });

  it('repairs a rejected candidate and exposes only the replacement that passes', async () => {
    const doctor = vi.fn()
      .mockResolvedValueOnce({ ok: false, diagnostics: ['validate-plan: task uses unsupported autoFix'] })
      .mockResolvedValueOnce({ ok: true, diagnostics: [] });
    const conversation = new PlanConversation({
      workingDir,
      threadTs: 'doctor-repair',
      plannerRetryLimit: 0,
      planDoctorRepairLimit: 2,
      draftDoctor: doctor,
    });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');
    const incidentPlan = readFileSync(join(testDir, 'planning-review-76829fbb.yaml'), 'utf8');

    mockSpawn
      .mockReturnValueOnce(fakePlannerChild('Drafted the first plan.', () => writeFileSync(path, incidentPlan, 'utf8')))
      .mockReturnValueOnce(fakePlannerChild('Drafted the corrected plan.', () => writeFileSync(path, VALID_PLAN_YAML, 'utf8')));

    const reply = await conversation.sendMessage('Draft the approved plan');

    expect(reply).toBe('Drafted the corrected plan.');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(doctor).toHaveBeenCalledTimes(2);
    expect(doctor).toHaveBeenNthCalledWith(1, incidentPlan.trim());
    expect(doctor).toHaveBeenNthCalledWith(2, VALID_PLAN_YAML.trim());
    expect(String(mockSpawn.mock.calls[1]?.[1])).toContain('validate-plan: task uses unsupported autoFix');
    expect(conversation.lastTurnDraftPlanText).toBe(VALID_PLAN_YAML.trim());
    expect(conversation.getDraftedPlan()).toBe(VALID_PLAN_YAML.trim());
  });

  it('fails closed after the bounded repair budget is exhausted', async () => {
    const doctor = vi.fn().mockResolvedValue({ ok: false, diagnostics: ['validate-plan: still invalid'] });
    const conversation = new PlanConversation({
      workingDir,
      threadTs: 'doctor-exhausted',
      plannerRetryLimit: 0,
      planDoctorRepairLimit: 2,
      draftDoctor: doctor,
    });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');

    mockSpawn
      .mockReturnValueOnce(fakePlannerChild('Candidate one.', () => writeFileSync(path, VALID_PLAN_YAML, 'utf8')))
      .mockReturnValueOnce(fakePlannerChild('Candidate two.', () => writeFileSync(path, VALID_PLAN_YAML, 'utf8')))
      .mockReturnValueOnce(fakePlannerChild('Candidate three.', () => writeFileSync(path, VALID_PLAN_YAML, 'utf8')));

    const reply = await conversation.sendMessage('Draft the approved plan');

    expect(reply).toContain('Draft not shown: the plan doctor rejected it.');
    expect(reply).toContain('Nothing was submitted.');
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(doctor).toHaveBeenCalledTimes(3);
    expect(existsSync(path)).toBe(false);
    expect(conversation.lastTurnDraftPlanText).toBeNull();
    expect(conversation.getDraftedPlan()).toBeNull();
  });
});

describe('plan draft-file activation prompt policy', () => {
  it('keeps direct plan mode ready to draft YAML by default', () => {
    const prompt = buildPlanSystemPrompt('main', 'git@github.com:test/repo.git');

    expect(prompt).toContain('Generate a YAML task plan');
    expect(prompt).toContain('repoUrl: "git@github.com:test/repo.git"');
    expect(prompt).toContain('name: "Plan Name"');
    expect(prompt).toContain('When the final YAML plan is ready, output the COMPLETE YAML inside a ```yaml code block.');
    expect(prompt).toContain('Slack orchestrator reads that exact YAML');
  });

  it('keeps YAML and draft-file mechanics unavailable before conversational authorization', () => {
    const prompt = buildPlanSystemPrompt('main', undefined, {
      conversationalPlanning: true,
      draftingAuthorized: false,
      planningSurface: 'slack',
    });

    expect(prompt).toContain('conversational planning mode');
    expect(prompt).toContain('Drafting is not authorized yet');
    expect(prompt).toContain('do NOT write a draft plan file');
    expect(prompt).toContain('Ask scoping questions first');
    expect(prompt).toContain('edge cases, corner cases, architecture choices, ambiguity');
    expect(prompt).toContain('explain like the user is five');
    expect(prompt).not.toContain('name: "Plan Name"');
    expect(prompt).not.toContain('When ready, output the plan inside a ```yaml code block');
    expect(prompt).not.toContain(SUBMIT_REPLY_LINE);
  });

  it('points at the plan-to-invoker skill after conversational authorization, instead of embedding the ad hoc YAML contract', () => {
    const prompt = buildPlanSystemPrompt('develop', undefined, {
      conversationalPlanning: true,
      draftingAuthorized: true,
      planningSurface: 'slack',
    });

    expect(prompt).toContain('The user has explicitly approved drafting');
    expect(prompt).toContain('plan-to-invoker');
    expect(prompt).toContain('Harness handoff mode');
    expect(prompt).toContain('skills/plan-to-invoker/SKILL.md');
    expect(prompt).not.toContain('name: "Plan Name"');
    expect(prompt).not.toContain('tasks:\n  - id: task-1');
  });
});
