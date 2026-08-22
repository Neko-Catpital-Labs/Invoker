import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { InAppPlanningSubmitResponse } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';
import type { PlanningConfirmationMode, PlanningReviewDraft } from '../../planning-core/src/planning-review.js';
import { buildPlanningHandoffInstructions } from '../../planning-core/src/planning-handoff-prompt.js';
import { confirmationTextForMode, preparePlanningReview } from '../../planning-core/src/planning-review.js';
import type { PlanSummary } from '../../planning-core/src/plan-summary.js';
import { parsePlanFile } from '@invoker/workflow-core';
import { z } from 'zod';
import { createDefaultMessageBus, discoverLiveOwner } from './live-owner-bus.js';
import {
  assertPlanUnchanged,
  createReviewTokenStore,
  type ReviewTokenStore,
} from './mcp-review-binding.js';
import {
  normalizeTaskSnapshots,
  normalizeWorkflowSnapshot,
  waitForWorkflowTasks,
  type WorkflowTaskSnapshot,
} from './mcp-workflow-status.js';

export type McpSubmitMode = 'live' | 'auto' | 'standalone';

export interface McpCliRunner {
  run(args: string[], options?: { cwd?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export const HANDOFF_PROMPT_DESCRIPTION = 'Plan a requested change, trigger PR skills for PR/stack work, convert it to Invoker YAML, review the canonical ordered steps, and submit it live.';

const NO_COMPLETE_PLAN_DRAFTED_ERROR = 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.';
const NO_LIVE_OWNER_ERROR = 'No live Invoker app is running to answer this planning session.';
const EXCLUSIVE_SOURCE_ERROR = 'Provide exactly one of planPath or sessionId.';
const MISSING_REVIEW_TOKEN_ERROR = 'reviewToken is required. Call invoker_prepare_plan_review first and pass the returned reviewToken.';
const UNKNOWN_REVIEW_TOKEN_ERROR = 'Unknown or expired reviewToken. Call invoker_prepare_plan_review again.';

interface PlanningChatSessionSnapshot {
  draftPlanText?: string;
  draftPlanSummary?: PlanSummary;
  confirmationMode: PlanningConfirmationMode;
  status: string;
}

type McpToolErrorResult = { content: [{ type: 'text'; text: string }]; isError: true };
type McpToolTextResult = { content: [{ type: 'text'; text: string }]; isError?: false };

function mcpError(text: string): McpToolErrorResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function mcpJson(value: unknown): McpToolTextResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function resolveEffectiveSessionId(sessionId: string | undefined): string | undefined {
  if (sessionId) return sessionId;
  const envSessionId = process.env.INVOKER_PLANNING_SESSION_ID;
  return envSessionId && envSessionId.length > 0 ? envSessionId : undefined;
}

function resolveExclusiveSource(input: {
  planPath?: string;
  sessionId?: string;
}): { kind: 'planPath'; planPath: string } | { kind: 'sessionId'; sessionId: string } | McpToolErrorResult {
  const explicitSessionId = input.sessionId && input.sessionId.length > 0 ? input.sessionId : undefined;
  const planPath = input.planPath && input.planPath.length > 0 ? input.planPath : undefined;
  if (explicitSessionId && planPath) {
    return mcpError(EXCLUSIVE_SOURCE_ERROR);
  }
  if (explicitSessionId) {
    return { kind: 'sessionId', sessionId: explicitSessionId };
  }
  if (planPath) {
    // Env session only applies when the caller did not pass planPath.
    return { kind: 'planPath', planPath };
  }
  const envSessionId = resolveEffectiveSessionId(undefined);
  if (envSessionId) {
    return { kind: 'sessionId', sessionId: envSessionId };
  }
  return mcpError(EXCLUSIVE_SOURCE_ERROR);
}

export async function preparePlanReviewForSession(
  sessionId: string,
  createBus: () => Promise<MessageBus> = createDefaultMessageBus,
): Promise<PlanningReviewDraft | McpToolErrorResult> {
  const bus = await createBus();
  try {
    const owner = await discoverLiveOwner(bus);
    if (!owner) {
      return mcpError(NO_LIVE_OWNER_ERROR);
    }
    const response = await bus.request<{ kind: string; sessionId: string }, { session: PlanningChatSessionSnapshot | null }>(
      'headless.query',
      { kind: 'planning-chat-session', sessionId },
    );
    const session = response.session;
    if (!session) {
      return mcpError(`Unknown planning session "${sessionId}". It may have been deleted or never existed.`);
    }
    if (!session.draftPlanText) {
      return mcpError(NO_COMPLETE_PLAN_DRAFTED_ERROR);
    }
    return {
      planText: session.draftPlanText,
      summary: session.draftPlanSummary as PlanSummary,
      confirmationMode: session.confirmationMode,
      confirmationText: confirmationTextForMode(session.confirmationMode),
    };
  } finally {
    bus.disconnect();
  }
}

export async function loadSessionPlanText(
  sessionId: string,
  createBus: () => Promise<MessageBus> = createDefaultMessageBus,
): Promise<{ ok: true; planText: string } | McpToolErrorResult> {
  const draft = await preparePlanReviewForSession(sessionId, createBus);
  if ('isError' in draft) return draft;
  return { ok: true, planText: draft.planText };
}

export async function submitPlanForSession(
  sessionId: string,
  createBus: () => Promise<MessageBus> = createDefaultMessageBus,
): Promise<{ ok: true; workflowId: string } | McpToolErrorResult> {
  const bus = await createBus();
  try {
    const owner = await discoverLiveOwner(bus);
    if (!owner) {
      return mcpError(NO_LIVE_OWNER_ERROR);
    }
    const response = await bus.request<{ channel: string; args: unknown[] }, InAppPlanningSubmitResponse>(
      'headless.gui-mutation',
      { channel: 'invoker:planning-chat-submit', args: [{ sessionId }] },
    );
    if (!response.ok) {
      return mcpError(response.error);
    }
    return { ok: true, workflowId: response.workflowId };
  } finally {
    bus.disconnect();
  }
}

type SubmitSuccess = { ok: true; workflowId: string; stdout: string };
type SubmitFailure = { ok: false; exitCode: number; stdout: string; stderr: string; error?: string };

export function resolveCliInvocation(
  execPath: string,
  cliPath: string,
  args: string[],
): { command: string; args: string[] } {
  if (!cliPath) {
    throw new Error('Unable to resolve CLI path for spawning invoker-cli');
  }
  if (cliPath === execPath) {
    return { command: execPath, args };
  }
  return { command: execPath, args: [cliPath, ...args] };
}

export function createProcessRunner(cliPath = process.argv[1] ?? ''): McpCliRunner {
  return {
    run(args, options) {
      const complete = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
      let invocation: { command: string; args: string[] };
      try {
        invocation = resolveCliInvocation(process.execPath, cliPath, args);
      } catch (err) {
        complete.reject(err);
        return complete.promise;
      }
      const child = spawn(invocation.command, invocation.args, {
        cwd: options?.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', complete.reject);
      child.once('close', (code) => {
        complete.resolve({ exitCode: code ?? 1, stdout, stderr });
      });
      return complete.promise;
    },
  };
}

function argsForSubmit(absolutePlanPath: string, mode: McpSubmitMode): string[] {
  if (mode === 'auto') return ['run', absolutePlanPath, '--json'];
  if (mode === 'standalone') return ['run', absolutePlanPath, '--standalone', '--json'];
  return ['run', absolutePlanPath, '--live', '--json'];
}

function parseRunJson(stdout: string): { workflowId: string } {
  const parsed = JSON.parse(stdout.trim()) as { workflow?: { id?: unknown }; result?: { workflowId?: unknown } };
  const id = parsed.workflow?.id ?? parsed.result?.workflowId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Missing workflow id in invoker-cli run --json output');
  }
  return { workflowId: id };
}

export async function validatePlanForMcp(
  planPath: string,
): Promise<{ ok: true; name: string; taskCount: number } | { ok: false; error: string }> {
  try {
    const plan = await parsePlanFile(resolve(planPath));
    return { ok: true, name: plan.name, taskCount: plan.tasks.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
export async function preparePlanReviewForMcp(
  planPath: string,
  confirmationMode: PlanningConfirmationMode = 'require',
): Promise<PlanningReviewDraft | { ok: false; error: string }> {
  try {
    const planText = await readFile(resolve(planPath), 'utf8');
    const review = preparePlanningReview({ plannerOutput: planText, confirmationMode });
    if ('kind' in review && review.kind === 'message') {
      return { ok: false, error: 'I could not read that Invoker YAML plan. Regenerate the YAML, then try the review step again.' };
    }
    return review;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function submitPlanForMcp(
  planPath: string,
  mode: McpSubmitMode = 'live',
  runner: McpCliRunner = createProcessRunner(),
): Promise<SubmitSuccess | SubmitFailure> {
  const absolutePlanPath = resolve(planPath);
  const result = await runner.run(argsForSubmit(absolutePlanPath, mode));
  if (result.exitCode !== 0) {
    return { ok: false, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
  try {
    const parsed = parseRunJson(result.stdout);
    return { ok: true, workflowId: parsed.workflowId, stdout: result.stdout };
  } catch (err) {
    return {
      ok: false,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: `Invalid invoker-cli run --json output: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function formatSubmitFailure(result: SubmitFailure): string {
  return [
    result.error,
    `Invoker plan submission failed with exit code ${result.exitCode}.`,
    result.stderr ? `stderr:\n${result.stderr}` : undefined,
    result.stdout ? `stdout:\n${result.stdout}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

async function queryLiveOwnerJson(
  createBus: () => Promise<MessageBus>,
  args: string[],
): Promise<unknown> {
  const bus = await createBus();
  try {
    const owner = await discoverLiveOwner(bus);
    if (!owner) {
      throw new Error(NO_LIVE_OWNER_ERROR);
    }
    const raw = await bus.request<{ kind: string; args: string[] }, { output?: unknown }>(
      'headless.query',
      { kind: 'cli-query', args },
    );
    if (!raw || typeof raw !== 'object' || typeof raw.output !== 'string') {
      throw new Error('Live owner returned invalid headless.query response: missing output string');
    }
    return JSON.parse(raw.output);
  } finally {
    bus.disconnect();
  }
}

async function loadWorkflowTasks(
  workflowId: string,
  createBus: () => Promise<MessageBus>,
  status?: string,
): Promise<WorkflowTaskSnapshot[]> {
  const args = ['query', 'tasks', '--workflow', workflowId, '--output', 'json'];
  if (status) {
    args.push('--status', status);
  }
  return normalizeTaskSnapshots(await queryLiveOwnerJson(createBus, args));
}

export function handoffPrompt(request: string): string {
  const handoffInstructions = buildPlanningHandoffInstructions({
    planFilePath: 'plans/invoker-handoff.yaml',
    reviewInstruction: 'Call `invoker_prepare_plan_review` with exactly one of `planPath` or `sessionId`, then show the returned ordered steps and confirmation text to the user. Keep the returned `reviewToken`.',
    shortReplyInstruction: 'Then keep the chat reply focused on the review summary and approval state. Never paste the YAML into chat.',
    submissionInstruction: 'If `invoker_prepare_plan_review` returns `confirmationMode: "require"`, wait for approval before `invoker_submit_plan`. If it returns `confirmationMode: "auto_submit"`, show the same review output and then call `invoker_submit_plan` immediately. Always pass the same source (`planPath` or `sessionId`) plus the `reviewToken`. Use mode `live` so the workflow appears in the running Invoker app. After submit, use `invoker_get_workflow`, `invoker_list_tasks`, or bounded `invoker_wait_for_workflow` to report status.',
  });
  return [
    `User request: ${request}`,
    '',
    `Use this host's native planning mode when the host supports entering it from this command. If the host cannot be switched by this command, do a read-only planning pass and do not edit product code before the plan is approved.`,
    'If the request involves creating, updating, publishing, or splitting pull requests or PR stacks, first read and follow skill://make-pr/SKILL.md before PR authoring or publication.',
    'If the request involves multiple review slices, first read and follow skill://review-compression/SKILL.md before writing workflow YAML.',
    'Write the planning artifact to plans/invoker-handoff.md.',
    'Convert the approved Markdown plan to plans/invoker-handoff.yaml.',
    handoffInstructions,
    'If MCP tools are unavailable but `invoker-cli` is on PATH, mirror the same flow with `invoker-cli run plans/invoker-handoff.yaml --live` only after the approval step that `invoker_prepare_plan_review` would have gated.',
  ].join('\n');
}

export interface McpServerOptions {
  runner?: McpCliRunner;
  cliPath?: string;
  createMessageBus?: () => Promise<MessageBus>;
  reviewTokens?: ReviewTokenStore;
  sleep?: (ms: number) => Promise<void>;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const runner = options.runner ?? createProcessRunner(options.cliPath);
  const createBus = options.createMessageBus ?? createDefaultMessageBus;
  const reviewTokens = options.reviewTokens ?? createReviewTokenStore();
  const sleep = options.sleep;
  const server = new McpServer({ name: 'invoker', version: '0.0.6' });

  server.registerTool(
    'invoker_validate_plan',
    {
      description: 'Validate an existing Invoker YAML plan without submitting it.',
      inputSchema: { planPath: z.string() },
    },
    async ({ planPath }) => {
      const result = await validatePlanForMcp(planPath);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `Invalid Invoker plan: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Valid Invoker plan: ${result.name} (${result.taskCount} tasks).`,
          },
        ],
      };
    },
  );
  server.registerTool(
    'invoker_prepare_plan_review',
    {
      description: 'Prepare the canonical ordered-step review for an existing Invoker YAML plan or planning session. Provide exactly one of planPath or sessionId.',
      inputSchema: {
        planPath: z.string().optional(),
        confirmationMode: z.enum(['require', 'auto_submit']).optional(),
        sessionId: z.string().optional(),
      },
    },
    async ({ planPath, confirmationMode, sessionId }) => {
      const source = resolveExclusiveSource({ planPath, sessionId });
      if ('isError' in source) return source;

      if (source.kind === 'sessionId') {
        const sessionResult = await preparePlanReviewForSession(source.sessionId, createBus);
        if ('isError' in sessionResult) {
          return sessionResult;
        }
        const binding = reviewTokens.issue({
          planText: sessionResult.planText,
          source,
        });
        return mcpJson({
          ...sessionResult,
          reviewToken: binding.token,
        });
      }

      let rawPlanText: string;
      try {
        rawPlanText = await readFile(resolve(source.planPath), 'utf8');
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Could not prepare Invoker plan review: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
      const result = await preparePlanReviewForMcp(source.planPath, confirmationMode ?? 'require');
      if ('ok' in result && result.ok === false) {
        return {
          content: [{ type: 'text', text: `Could not prepare Invoker plan review: ${result.error}` }],
          isError: true,
        };
      }
      const draft = result as PlanningReviewDraft;
      const binding = reviewTokens.issue({
        // Bind to on-disk bytes so submit's re-read matches.
        planText: rawPlanText,
        source: { kind: 'planPath', planPath: resolve(source.planPath) },
      });
      return mcpJson({
        ...draft,
        reviewToken: binding.token,
      });
    },
  );

  server.registerTool(
    'invoker_submit_plan',
    {
      description: 'Submit a previously reviewed Invoker plan. Provide the same planPath or sessionId used for review, plus the reviewToken.',
      inputSchema: {
        planPath: z.string().optional(),
        mode: z.enum(['live', 'auto', 'standalone']).optional(),
        sessionId: z.string().optional(),
        reviewToken: z.string(),
      },
    },
    async ({ planPath, mode, sessionId, reviewToken }) => {
      if (!reviewToken) {
        return mcpError(MISSING_REVIEW_TOKEN_ERROR);
      }
      const source = resolveExclusiveSource({ planPath, sessionId });
      if ('isError' in source) return source;

      const binding = reviewTokens.get(reviewToken);
      if (!binding) {
        return mcpError(UNKNOWN_REVIEW_TOKEN_ERROR);
      }
      if (binding.source.kind !== source.kind
        || (source.kind === 'planPath' && binding.source.kind === 'planPath' && resolve(binding.source.planPath) !== resolve(source.planPath))
        || (source.kind === 'sessionId' && binding.source.kind === 'sessionId' && binding.source.sessionId !== source.sessionId)) {
        return mcpError('reviewToken does not match the provided planPath/sessionId. Re-run invoker_prepare_plan_review.');
      }

      if (source.kind === 'sessionId') {
        const current = await loadSessionPlanText(source.sessionId, createBus);
        if ('isError' in current) return current;
        try {
          assertPlanUnchanged(binding.contentHash, current.planText);
        } catch (err) {
          return mcpError(err instanceof Error ? err.message : String(err));
        }
        reviewTokens.consume(reviewToken);
        const sessionResult = await submitPlanForSession(source.sessionId, createBus);
        if ('isError' in sessionResult) {
          return sessionResult;
        }
        return mcpJson({
          ok: true,
          workflowId: sessionResult.workflowId,
          message: `Submitted Invoker plan. Workflow id: ${sessionResult.workflowId}.`,
        });
      }

      let planText: string;
      try {
        planText = await readFile(resolve(source.planPath), 'utf8');
        assertPlanUnchanged(binding.contentHash, planText);
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : String(err));
      }
      reviewTokens.consume(reviewToken);
      const result = await submitPlanForMcp(source.planPath, mode ?? 'live', runner);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: formatSubmitFailure(result) }],
          isError: true,
        };
      }
      return mcpJson({
        ok: true,
        workflowId: result.workflowId,
        message: `Submitted Invoker plan. Workflow id: ${result.workflowId}.`,
        stdout: result.stdout,
      });
    },
  );

  server.registerTool(
    'invoker_get_workflow',
    {
      description: 'Read one workflow snapshot from the live Invoker owner.',
      inputSchema: { workflowId: z.string() },
    },
    async ({ workflowId }) => {
      try {
        const raw = await queryLiveOwnerJson(createBus, ['query', 'workflows', '--output', 'json']);
        const workflow = normalizeWorkflowSnapshot(raw, workflowId);
        return mcpJson({ ok: true, workflow });
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'invoker_list_tasks',
    {
      description: 'List tasks for a workflow from the live Invoker owner.',
      inputSchema: {
        workflowId: z.string(),
        status: z.string().optional(),
      },
    },
    async ({ workflowId, status }) => {
      try {
        const tasks = await loadWorkflowTasks(workflowId, createBus, status);
        return mcpJson({ ok: true, workflowId, tasks });
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'invoker_wait_for_workflow',
    {
      description: 'Poll a workflow until tasks settle or maxWaitMs elapses. Default maxWaitMs is 30000.',
      inputSchema: {
        workflowId: z.string(),
        maxWaitMs: z.number().int().positive().optional(),
        pollIntervalMs: z.number().int().positive().optional(),
      },
    },
    async ({ workflowId, maxWaitMs, pollIntervalMs }) => {
      try {
        const result = await waitForWorkflowTasks({
          workflowId,
          maxWaitMs,
          pollIntervalMs,
          sleep,
          loadTasks: () => loadWorkflowTasks(workflowId, createBus),
        });
        return mcpJson({ ok: true, ...result });
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerPrompt(
    'invoker-plan-to-invoker',
    {
      description: HANDOFF_PROMPT_DESCRIPTION,
      argsSchema: { request: z.string() },
    },
    ({ request }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: handoffPrompt(request) },
        },
      ],
    }),
  );

  return server;
}

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}
