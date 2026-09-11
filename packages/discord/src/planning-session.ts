import { spawn } from 'node:child_process';
import { formatCodexPlannerStdout, materializeLocalAgentPrompt } from '@invoker/execution-engine';
import {
  PlanConversation,
  defaultPlanningCommand,
  type DraftSource,
  type LogFn,
  type PlanningCommandBuilder,
} from '@invoker/surfaces';

export const DISCORD_SURFACE = 'discord';

export interface PlanningSessionKey {
  surface: typeof DISCORD_SURFACE;
  channelId: string;
  threadId: string;
}

export function planningSessionKeyString(key: PlanningSessionKey): string {
  return `${key.surface}:${key.channelId}:${key.threadId}`;
}

export interface PlanningSession extends DraftSource {
  sendMessage(text: string): Promise<string>;
  runPlanConversion(): Promise<string>;
}

export interface PlanningSessionRequest {
  key: PlanningSessionKey;
  userId: string;
  tool: string;
  model?: string;
  workingDir?: string;
  repoUrl?: string;
}

export type PlanningSessionFactory = (request: PlanningSessionRequest) => PlanningSession;

export interface WorkflowQuestion {
  tool: string;
  model?: string;
  workingDir?: string;
  prompt: string;
}

export type WorkflowQuestionAnswerer = (question: WorkflowQuestion) => Promise<string>;

export interface PlannerProcessOptions {
  cursorCommand?: string;
  planningCommandBuilder?: PlanningCommandBuilder;
  defaultBranch?: string;
  timeoutMs?: number;
  log?: LogFn;
}

const DEFAULT_PLANNER_TIMEOUT_MS = 7_200_000;

export function createPlanConversationFactory(options: PlannerProcessOptions): PlanningSessionFactory {
  return (request) => new PlanConversation({
    cursorCommand: options.cursorCommand,
    planningCommandBuilder: options.planningCommandBuilder,
    tool: request.tool,
    model: request.model,
    mode: 'agent',
    workingDir: request.workingDir,
    repoUrl: request.repoUrl,
    threadTs: request.key.threadId,
    channelId: request.key.channelId,
    defaultBranch: options.defaultBranch,
    timeoutMs: options.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS,
    log: options.log,
  });
}

export function createOneShotAnswerer(options: PlannerProcessOptions): WorkflowQuestionAnswerer {
  return async (question) => {
    const promptTransport = materializeLocalAgentPrompt(question.prompt, 'invoker-discord-prompt-');
    try {
      const { command, args } = options.planningCommandBuilder
        ? options.planningCommandBuilder({ tool: question.tool, model: question.model, prompt: promptTransport.effectivePrompt })
        : defaultPlanningCommand(options.cursorCommand ?? 'agent', { model: question.model, prompt: promptTransport.effectivePrompt });
      const stdout = await runToCompletion(command, args, question.workingDir, options.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS);
      return formatCodexPlannerStdout(stdout).message || 'The planner completed without a final user-facing reply.';
    } finally {
      promptTransport.cleanup();
    }
  };
}

function runToCompletion(command: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Planner timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn planner CLI: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `Planner exited with code ${code}`));
    });
  });
}
