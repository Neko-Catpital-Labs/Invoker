import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parsePlanFile } from '@invoker/workflow-core';
import { z } from 'zod';

export type McpSubmitMode = 'live' | 'auto' | 'standalone';

export interface McpCliRunner {
  run(args: string[], options?: { cwd?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export const HANDOFF_PROMPT_DESCRIPTION = 'Plan a requested change, trigger PR skills for PR/stack work, convert it to Invoker YAML, validate it, and submit it live.';

type SubmitSuccess = { ok: true; workflowId: string; stdout: string };
type SubmitFailure = { ok: false; exitCode: number; stdout: string; stderr: string; error?: string };

export function resolveCliInvocation(
  execPath: string,
  cliPath: string,
  args: string[],
): { command: string; args: string[] } {
  if (!cliPath || cliPath === execPath) {
    return { command: execPath, args };
  }
  return { command: execPath, args: [cliPath, ...args] };
}

function createProcessRunner(cliPath = process.argv[1] ?? ''): McpCliRunner {
  return {
    run(args, options) {
      const complete = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
      const { command, args: spawnArgs } = resolveCliInvocation(process.execPath, cliPath, args);
      const child = spawn(command, spawnArgs, {
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

export function handoffPrompt(request: string): string {
  return [
    `User request: ${request}`,
    '',
    `Use this host's native planning mode when the host supports entering it from this command. If the host cannot be switched by this command, do a read-only planning pass and do not edit product code before the plan is approved.`,
    'If the request involves creating, updating, publishing, or splitting pull requests or PR stacks, first read and follow skill://make-pr/SKILL.md before PR authoring or publication.',
    'If the request involves multiple review slices, first read and follow skill://review-compression/SKILL.md before writing workflow YAML.',
    'Write the planning artifact to plans/invoker-handoff.md.',
    'Convert the approved Markdown plan to plans/invoker-handoff.yaml.',
    'Validate with invoker_validate_plan before submitting.',
    'Submit with invoker_submit_plan using mode "live" so the workflow appears in the running Invoker app.',
    'If MCP tools are not available but invoker-cli is on PATH, run invoker-cli run plans/invoker-handoff.yaml --live instead.',
  ].join('\n');
}

export async function runMcpServer(options: { runner?: McpCliRunner; cliPath?: string } = {}): Promise<void> {
  const runner = options.runner ?? createProcessRunner(options.cliPath);
  const server = new McpServer({ name: 'invoker', version: '0.0.5' });

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
    'invoker_submit_plan',
    {
      description: 'Submit an existing Invoker YAML plan through invoker-cli run.',
      inputSchema: {
        planPath: z.string(),
        mode: z.enum(['live', 'auto', 'standalone']).optional(),
      },
    },
    async ({ planPath, mode }) => {
      const result = await submitPlanForMcp(planPath, mode ?? 'live', runner);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: formatSubmitFailure(result) }],
          isError: true,
        };
      }
      const workflowText = ` Workflow id: ${result.workflowId}.`;
      return {
        content: [
          {
            type: 'text',
            text: `Submitted Invoker plan.${workflowText}\nstdout:\n${result.stdout}`,
          },
        ],
      };
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

  await server.connect(new StdioServerTransport());
}
