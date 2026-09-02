import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import type { ExecutorHandle } from '../executor.js';
import {
  OWNER_INVESTIGATION_EVIDENCE_PROMPT_MARKER,
  type WorkRequest,
  type WorkResponse,
} from '@invoker/contracts';
import type { ExecutionAgent } from '../agent.js';
import { AgentRegistry } from '../agent-registry.js';
import { resetShellEnvironmentForTests } from '../process-utils.js';
import { OWNER_EVIDENCE_PROMPT_CHAR_LIMIT, ScratchExecutor } from '../scratch-executor.js';

let reqCounter = 0;
function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  const { inputs: inputOverrides, ...restOverrides } = overrides;
  reqCounter += 1;
  return {
    requestId: `req-${reqCounter}`,
    actionId: `action-${reqCounter}`,
    actionType: 'command',
    inputs: { command: 'true', ...inputOverrides },
    callbackUrl: 'http://localhost:3000/callback',
    timestamps: { createdAt: new Date().toISOString() },
    ...restOverrides,
  };
}

function waitForComplete(executor: ScratchExecutor, handle: ExecutorHandle): Promise<WorkResponse> {
  return new Promise((resolve) => {
    executor.onComplete(handle, (res) => resolve(res));
  });
}

function capturePromptAgent(prompts: string[]): AgentRegistry {
  const registry = new AgentRegistry();
  const agent: ExecutionAgent = {
    name: 'codex',
    stdinMode: 'ignore',
    buildCommand: (prompt) => {
      prompts.push(prompt);
      return { cmd: '/bin/true', args: [], sessionId: 'captured-session', fullPrompt: prompt };
    },
    buildResumeArgs: () => ({ cmd: '/bin/true', args: [] }),
  };
  registry.registerExecution(agent);
  return registry;
}

function ownerEvidenceResponse() {
  return {
    ownerEvidence: {
      schemaVersion: 1 as const,
      capturedAt: '2026-09-02T12:00:00.000Z',
      queue: { maxConcurrency: 4, runningCount: 1, running: [], queued: [] },
      workers: [{
        kind: 'pr-admin-bypass-land',
        lifecycle: 'stopped' as const,
        policy: 'enabled' as const,
        desiredEnabled: true,
      }],
      workflows: [],
      tasks: [],
      repairFilings: [],
      totals: { workers: 1, workflows: 0, tasks: 0, repairFilings: 0 },
    },
  };
}

describe('ScratchExecutor', () => {
  it('runs a command task in an isolated temp dir with no .git present', async () => {
    const executor = new ScratchExecutor();
    const request = makeRequest({ inputs: { command: '[ ! -e .git ]' } });
    const handle = await executor.start(request);
    const response = await waitForComplete(executor, handle);

    expect(response.status).toBe('completed');
    expect(handle.workspacePath).toBeTruthy();
    expect(existsSync(handle.workspacePath!)).toBe(true);

    await executor.destroyAll();
  });

  it('does not require repoUrl on the request', async () => {
    const executor = new ScratchExecutor();
    const request = makeRequest();
    expect(request.inputs.repoUrl).toBeUndefined();
    const response = await waitForComplete(executor, await executor.start(request));
    expect(response.status).toBe('completed');
    await executor.destroyAll();
  });

  it('gives concurrently started tasks distinct temp dirs', async () => {
    const executor = new ScratchExecutor();
    const requests = Array.from({ length: 6 }, () => makeRequest({ inputs: { command: 'true' } }));
    const handles = await Promise.all(requests.map((r) => executor.start(r)));
    await Promise.all(handles.map((h) => waitForComplete(executor, h)));

    const paths = handles.map((h) => h.workspacePath);
    expect(paths.every((p) => !!p)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);

    await executor.destroyAll();
  });

  it('reports a non-zero exit code as a failed task', async () => {
    const executor = new ScratchExecutor();
    const request = makeRequest({ inputs: { command: 'exit 3' } });
    const handle = await executor.start(request);
    const response = await waitForComplete(executor, handle);

    expect(response.status).toBe('failed');
    expect(response.outputs.exitCode).toBe(3);

    await executor.destroyAll();
  });

  it('destroyAll removes temp dirs from disk', async () => {
    const executor = new ScratchExecutor();
    const request = makeRequest({ inputs: { command: 'true' } });
    const handle = await executor.start(request);
    await waitForComplete(executor, handle);
    const workspacePath = handle.workspacePath!;

    expect(existsSync(workspacePath)).toBe(true);
    await executor.destroyAll();
    expect(existsSync(workspacePath)).toBe(false);
  });

  it('injects bounded live-owner evidence when invoker-ui is absent from PATH', async () => {
    const originalPath = process.env.PATH;
    const prompts: string[] = [];
    const ownerEvidenceQuery = vi.fn(async () => ownerEvidenceResponse());
    process.env.PATH = '/path/without/invoker-ui';
    resetShellEnvironmentForTests();
    try {
      const executor = new ScratchExecutor({
        agentRegistry: capturePromptAgent(prompts),
        ownerEvidenceQuery,
      });
      const request = makeRequest({
        actionType: 'ai_task',
        inputs: {
          prompt: `Investigate the stopped worker.\n\n${OWNER_INVESTIGATION_EVIDENCE_PROMPT_MARKER}`,
          executionAgent: 'codex',
        },
      });

      const response = await waitForComplete(executor, await executor.start(request));

      expect(response.status).toBe('completed');
      expect(ownerEvidenceQuery).toHaveBeenCalledWith({ kind: 'investigation-evidence' });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Investigate the stopped worker.');
      expect(prompts[0]).toContain('"status": "available"');
      expect(prompts[0]).toContain('"kind": "pr-admin-bypass-land"');
      expect(prompts[0]).toContain('Do not invoke `invoker-ui`');
      expect(prompts[0]).not.toContain(OWNER_INVESTIGATION_EVIDENCE_PROMPT_MARKER);
      expect(prompts[0]!.length).toBeLessThan(OWNER_EVIDENCE_PROMPT_CHAR_LIMIT + 1_000);
      await executor.destroyAll();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      resetShellEnvironmentForTests();
    }
  });

  it('injects a structured owner-query error and still starts the scratch agent', async () => {
    const prompts: string[] = [];
    const queryError = Object.assign(new Error('Owner request timed out'), { code: 'REQUEST_TIMEOUT' });
    const executor = new ScratchExecutor({
      agentRegistry: capturePromptAgent(prompts),
      ownerEvidenceQuery: async () => { throw queryError; },
    });
    const request = makeRequest({
      actionType: 'ai_task',
      inputs: {
        prompt: `Investigate owner state.\n\n${OWNER_INVESTIGATION_EVIDENCE_PROMPT_MARKER}`,
        executionAgent: 'codex',
      },
    });

    const response = await waitForComplete(executor, await executor.start(request));

    expect(response.status).toBe('completed');
    expect(prompts[0]).toContain('"status": "query_error"');
    expect(prompts[0]).toContain('"code": "REQUEST_TIMEOUT"');
    expect(prompts[0]).toContain('"message": "Owner request timed out"');
    await executor.destroyAll();
  });

  it('does not query owner evidence for an unrelated scratch AI task', async () => {
    const prompts: string[] = [];
    const ownerEvidenceQuery = vi.fn(async () => ownerEvidenceResponse());
    const executor = new ScratchExecutor({
      agentRegistry: capturePromptAgent(prompts),
      ownerEvidenceQuery,
    });
    const request = makeRequest({
      actionType: 'ai_task',
      inputs: { prompt: 'Summarize this standalone input.', executionAgent: 'codex' },
    });

    const response = await waitForComplete(executor, await executor.start(request));

    expect(response.status).toBe('completed');
    expect(ownerEvidenceQuery).not.toHaveBeenCalled();
    expect(prompts).toEqual(['Summarize this standalone input.']);
    await executor.destroyAll();
  });
});
