import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { InvokerConfig, McpServerLaunchConfig } from './config.js';

export interface SplitterFeedbackLogger {
  info?(message: string, meta?: unknown): void;
  warn?(message: string, meta?: unknown): void;
}

export interface SplitterFeedbackRequest {
  config: Pick<InvokerConfig, 'experimentalPlanner' | 'splitterFeedback'>;
  splitterPlanId?: string;
  splitterPerson?: string;
  liked?: boolean;
  comment?: string;
  logger?: SplitterFeedbackLogger;
  callTool?: SplitterFeedbackToolCaller;
}

export interface SplitterFeedbackToolCall {
  toolName: 'feedback' | 'correct';
  args: Record<string, unknown>;
  server: McpServerLaunchConfig;
  timeoutMs: number;
}

export type SplitterFeedbackToolCaller = (call: SplitterFeedbackToolCall) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PERSON = 'edbert';

const DEFAULT_SPLITTER_MCP_SERVER: McpServerLaunchConfig = {
  command: 'uvx',
  args: ['--from', 'personal-stack-planner', 'invoker-planner-redirect'],
};

export function splitterFeedbackEnabled(config: Pick<InvokerConfig, 'experimentalPlanner' | 'splitterFeedback'>): boolean {
  if (config.splitterFeedback?.enabled === false) return false;
  return config.splitterFeedback?.enabled === true || config.experimentalPlanner === true;
}

function resolveSplitterFeedbackPerson(
  config: Pick<InvokerConfig, 'splitterFeedback'>,
  splitterPerson?: string,
): string {
  const fromPlan = splitterPerson?.trim();
  if (fromPlan) return fromPlan;
  const fromConfig = config.splitterFeedback?.person?.trim();
  return fromConfig || DEFAULT_PERSON;
}

function resolveSplitterFeedbackTimeout(config: Pick<InvokerConfig, 'splitterFeedback'>): number {
  const configured = config.splitterFeedback?.timeoutMs;
  return Number.isFinite(configured) && configured! > 0 ? Math.floor(configured!) : DEFAULT_TIMEOUT_MS;
}

function resolveSplitterMcpServer(config: Pick<InvokerConfig, 'splitterFeedback'>): McpServerLaunchConfig {
  return config.splitterFeedback?.mcpServer ?? DEFAULT_SPLITTER_MCP_SERVER;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function callSplitterFeedbackTool(call: SplitterFeedbackToolCall): Promise<unknown> {
  const transport = new StdioClientTransport({
    command: call.server.command,
    args: call.server.args,
    cwd: call.server.cwd,
    env: call.server.env ? { ...process.env, ...call.server.env } as Record<string, string> : undefined,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'invoker-splitter-feedback', version: '0.0.6' }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), call.timeoutMs, 'Splitter MCP connect');
    return await withTimeout(
      client.callTool({ name: call.toolName, arguments: call.args }),
      call.timeoutMs,
      `Splitter MCP ${call.toolName}`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function recordSplitterPlanFeedback(request: SplitterFeedbackRequest): Promise<'sent' | 'skipped' | 'failed'> {
  const planId = request.splitterPlanId?.trim();
  if (!planId) return 'skipped';
  if (!splitterFeedbackEnabled(request.config)) return 'skipped';

  const person = resolveSplitterFeedbackPerson(request.config, request.splitterPerson);
  const timeoutMs = resolveSplitterFeedbackTimeout(request.config);
  const server = resolveSplitterMcpServer(request.config);
  const caller = request.callTool ?? callSplitterFeedbackTool;
  try {
    await caller({
      toolName: 'feedback',
      server,
      timeoutMs,
      args: {
        plan_id: planId,
        liked: request.liked ?? true,
        comment: request.comment ?? 'Invoker generated plan submitted',
        person,
      },
    });
    request.logger?.info?.(`splitter feedback recorded for plan ${planId}`, { module: 'splitter-feedback' });
    return 'sent';
  } catch (error) {
    request.logger?.warn?.(
      `splitter feedback failed for plan ${planId}: ${error instanceof Error ? error.message : String(error)}`,
      { module: 'splitter-feedback' },
    );
    return 'failed';
  }
}
