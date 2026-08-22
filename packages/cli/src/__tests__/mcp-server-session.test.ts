import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LocalBus, type MessageBus } from '@invoker/transport';

import { createMcpServer, type McpServerOptions } from '../mcp-server.js';
import { createReviewTokenStore } from '../mcp-review-binding.js';

const repoRoot = resolve(__dirname, '../../../..');
const fixturePlan = resolve(repoRoot, 'plans/fixtures/hello-world.yaml');

async function connectMcpClient(options: McpServerOptions) {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'invoker-cli-test-client', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function refusingCreateMessageBus(): () => Promise<MessageBus> {
  return () => {
    throw new Error('createMessageBus should not be called without an effective session id');
  };
}

/** LocalBus.disconnect() clears handlers, so multi-call flows need a fresh bus each time. */
function liveOwnerBusFactory(setup: (bus: LocalBus) => void): () => Promise<MessageBus> {
  return async () => {
    const bus = new LocalBus();
    setup(bus);
    return bus;
  };
}

describe('mcp-server session-scoped tools', () => {
  const previousEnv = process.env.INVOKER_PLANNING_SESSION_ID;

  afterEach(() => {
    if (previousEnv === undefined) {
      delete process.env.INVOKER_PLANNING_SESSION_ID;
    } else {
      process.env.INVOKER_PLANNING_SESSION_ID = previousEnv;
    }
    vi.restoreAllMocks();
  });

  it('leaves the file-path invoker_prepare_plan_review behavior unchanged with no sessionId and no env var', async () => {
    delete process.env.INVOKER_PLANNING_SESSION_ID;
    const { client, close } = await connectMcpClient({
      createMessageBus: refusingCreateMessageBus(),
    });
    try {
      const result = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { planPath: fixturePlan },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.planText).toEqual(expect.any(String));
      expect(parsed.summary).toEqual(expect.objectContaining({ name: 'Hello World CLI', taskCount: 1 }));
      expect(parsed.confirmationMode).toEqual('require');
      expect(parsed.confirmationText).toEqual('Approve to submit this exact YAML. Cancel keeps the draft. Discard removes it.');
      expect(parsed.reviewToken).toEqual(expect.stringMatching(/^rev_/));
    } finally {
      await close();
    }
  });

  it('rejects file-path submit without a reviewToken', async () => {
    delete process.env.INVOKER_PLANNING_SESSION_ID;
    const runner = {
      run: vi.fn(async () => ({ exitCode: 0, stdout: '{"workflow":{"id":"wf-file-path"}}\n', stderr: '' })),
    };
    const { client, close } = await connectMcpClient({
      runner,
      createMessageBus: refusingCreateMessageBus(),
    });
    try {
      const result = await client.callTool({
        name: 'invoker_submit_plan',
        arguments: { planPath: fixturePlan },
      });

      expect(String((result.content as Array<{text:string}>)[0]?.text ?? '')).toMatch(/reviewToken/i);
      expect(runner.run.mock.calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it('submits a file-path plan only with a matching reviewToken', async () => {
    delete process.env.INVOKER_PLANNING_SESSION_ID;
    const runner = {
      run: vi.fn(async () => ({ exitCode: 0, stdout: '{"workflow":{"id":"wf-file-path"}}\n', stderr: '' })),
    };
    const { client, close } = await connectMcpClient({
      runner,
      createMessageBus: refusingCreateMessageBus(),
    });
    try {
      const review = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { planPath: fixturePlan },
      });
      const reviewToken = JSON.parse((review.content as Array<{ text: string }>)[0]!.text).reviewToken as string;

      const result = await client.callTool({
        name: 'invoker_submit_plan',
        arguments: { planPath: fixturePlan, reviewToken },
      });

      expect(result.isError).toBeFalsy();
      expect(runner.run).toHaveBeenCalledTimes(1);
      const content = result.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0]!.text) as { ok: boolean; workflowId: string };
      expect(payload.ok).toEqual(true);
      expect(payload.workflowId).toEqual('wf-file-path');
    } finally {
      await close();
    }
  });

  it('rejects providing both planPath and sessionId', async () => {
    const { client, close } = await connectMcpClient({
      createMessageBus: refusingCreateMessageBus(),
    });
    try {
      const result = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { planPath: fixturePlan, sessionId: 'sess-both' },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text.includes('exactly one')).toEqual(true);
    } finally {
      await close();
    }
  });

  it('errors clearly and never touches the runner or file path when no live owner answers a session', async () => {
    const bus = new LocalBus();
    const runner = { run: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) };
    const { client, close } = await connectMcpClient({
      runner,
      createMessageBus: async () => bus,
    });
    try {
      const result = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { sessionId: 'sess-no-owner' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe('No live Invoker app is running to answer this planning session.');
      expect(runner.run).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('returns the session draft as a PlanningReviewDraft when the owner has one ready', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async (req: unknown) => {
      expect(req).toEqual({ kind: 'planning-chat-session', sessionId: 'sess-with-draft' });
      return {
        session: {
          draftPlanText: 'name: Session Plan\nonFinish: none\ntasks: []\n',
          draftPlanSummary: { name: 'Session Plan', taskCount: 0, taskGroups: [] },
          confirmationMode: 'require',
          status: 'draft_ready',
        },
      };
    });
    const { client, close } = await connectMcpClient({ createMessageBus: async () => bus });
    try {
      const result = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { sessionId: 'sess-with-draft' },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.planText).toEqual('name: Session Plan\nonFinish: none\ntasks: []\n');
      expect(parsed.summary).toEqual({ name: 'Session Plan', taskCount: 0, taskGroups: [] });
      expect(parsed.confirmationMode).toEqual('require');
      expect(parsed.confirmationText).toEqual('Approve to submit this exact YAML. Cancel keeps the draft. Discard removes it.');
      expect(parsed.reviewToken).toEqual(expect.stringMatching(/^rev_/));
    } finally {
      await close();
    }
  });

  it('returns a clear error when the session id is unknown to the owner', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async () => ({ session: null }));
    const { client, close } = await connectMcpClient({ createMessageBus: async () => bus });
    try {
      const result = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { sessionId: 'sess-missing' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe('Unknown planning session "sess-missing". It may have been deleted or never existed.');
    } finally {
      await close();
    }
  });

  it('dispatches invoker_submit_plan through headless.gui-mutation and maps an ok response', async () => {
    const planText = 'name: Session Plan\nonFinish: none\ntasks: []\n';
    const guiMutation = vi.fn(async (req: unknown) => {
      expect(req).toEqual({
        channel: 'invoker:planning-chat-submit',
        args: [{ sessionId: 'sess-submit-ok' }],
      });
      return { ok: true, planName: 'Session Plan', workflowId: 'wf-session-1' };
    });
    const { client, close } = await connectMcpClient({
      createMessageBus: liveOwnerBusFactory((bus) => {
        bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
        bus.onRequest('headless.query', async () => ({
          session: {
            draftPlanText: planText,
            draftPlanSummary: { name: 'Session Plan', taskCount: 0, taskGroups: [] },
            confirmationMode: 'require',
            status: 'draft_ready',
          },
        }));
        bus.onRequest('headless.gui-mutation', guiMutation);
      }),
    });
    try {
      const review = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { sessionId: 'sess-submit-ok' },
      });
      const reviewToken = JSON.parse((review.content as Array<{ text: string }>)[0]!.text).reviewToken as string;

      const result = await client.callTool({
        name: 'invoker_submit_plan',
        arguments: { sessionId: 'sess-submit-ok', reviewToken },
      });

      expect(result.isError).toBeFalsy();
      expect(guiMutation).toHaveBeenCalledTimes(1);
      const content = result.content as Array<{ type: string; text: string }>;
      const submitPayload = JSON.parse(content[0]!.text) as { ok: boolean; workflowId: string };
      expect(submitPayload.ok).toEqual(true);
      expect(submitPayload.workflowId).toEqual('wf-session-1');
    } finally {
      await close();
    }
  });

  it('rejects submit when session draft changed after review', async () => {
    let draft = 'name: Session Plan\nonFinish: none\ntasks: []\n';
    const guiMutation = vi.fn(async () => ({ ok: true, planName: 'Session Plan', workflowId: 'wf-session-1' }));
    const { client, close } = await connectMcpClient({
      createMessageBus: liveOwnerBusFactory((bus) => {
        bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
        bus.onRequest('headless.query', async () => ({
          session: {
            draftPlanText: draft,
            draftPlanSummary: { name: 'Session Plan', taskCount: 0, taskGroups: [] },
            confirmationMode: 'require',
            status: 'draft_ready',
          },
        }));
        bus.onRequest('headless.gui-mutation', guiMutation);
      }),
    });
    try {
      const review = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { sessionId: 'sess-stale' },
      });
      const reviewToken = JSON.parse((review.content as Array<{ text: string }>)[0]!.text).reviewToken as string;
      draft = 'name: Changed Plan\nonFinish: none\ntasks: []\n';

      const result = await client.callTool({
        name: 'invoker_submit_plan',
        arguments: { sessionId: 'sess-stale', reviewToken },
      });

      expect(result.isError).toBe(true);
      expect(guiMutation).not.toHaveBeenCalled();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain('changed after review');
    } finally {
      await close();
    }
  });

  it('maps a failed headless.gui-mutation response to an MCP error result', async () => {
    const planText = 'name: Session Plan\nonFinish: none\ntasks: []\n';
    const { client, close } = await connectMcpClient({
      createMessageBus: liveOwnerBusFactory((bus) => {
        bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
        bus.onRequest('headless.query', async () => ({
          session: {
            draftPlanText: planText,
            draftPlanSummary: { name: 'Session Plan', taskCount: 0, taskGroups: [] },
            confirmationMode: 'require',
            status: 'draft_ready',
          },
        }));
        bus.onRequest('headless.gui-mutation', async () => ({ ok: false, error: 'This planning session was already submitted.' }));
      }),
    });
    try {
      const review = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { sessionId: 'sess-submit-fail' },
      });
      const reviewToken = JSON.parse((review.content as Array<{ text: string }>)[0]!.text).reviewToken as string;
      const result = await client.callTool({
        name: 'invoker_submit_plan',
        arguments: { sessionId: 'sess-submit-fail', reviewToken },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe('This planning session was already submitted.');
    } finally {
      await close();
    }
  });

  it('honors INVOKER_PLANNING_SESSION_ID as a fallback when no planPath or sessionId is given', async () => {
    process.env.INVOKER_PLANNING_SESSION_ID = 'sess-from-env';
    const query = vi.fn(async (req: unknown) => {
      expect(req).toEqual({ kind: 'planning-chat-session', sessionId: 'sess-from-env' });
      return {
        session: {
          draftPlanText: 'name: Env Session Plan\nonFinish: none\ntasks: []\n',
          draftPlanSummary: { name: 'Env Session Plan', taskCount: 0, taskGroups: [] },
          confirmationMode: 'auto_submit',
          status: 'draft_ready',
        },
      };
    });
    const { client, close } = await connectMcpClient({
      createMessageBus: liveOwnerBusFactory((bus) => {
        bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
        bus.onRequest('headless.query', query);
      }),
    });
    try {
      const result = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(query).toHaveBeenCalledTimes(1);
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.confirmationMode).toBe('auto_submit');
      expect(parsed.confirmationText).toBe('Auto-submit is enabled. Submit this exact YAML now.');
      expect(parsed.reviewToken).toMatch(/^rev_/);
    } finally {
      await close();
    }
  });

  it('returns workflow and task snapshots from live owner queries', async () => {
    const { client, close } = await connectMcpClient({
      createMessageBus: liveOwnerBusFactory((bus) => {
        bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
        bus.onRequest('headless.query', async (req: unknown) => {
          const request = req as { kind: string; args: string[] };
          expect(request.kind).toBe('cli-query');
          if (request.args.includes('workflows')) {
            return { output: JSON.stringify([{ id: 'wf-1', name: 'Demo', status: 'running' }]) };
          }
          return {
            output: JSON.stringify([
              { id: 'wf-1/task-a', status: 'completed', description: 'A' },
              { id: 'wf-1/task-b', status: 'running', description: 'B' },
            ]),
          };
        });
      }),
    });
    try {
      const workflow = await client.callTool({
        name: 'invoker_get_workflow',
        arguments: { workflowId: 'wf-1' },
      });
      const tasks = await client.callTool({
        name: 'invoker_list_tasks',
        arguments: { workflowId: 'wf-1' },
      });
      expect(workflow.isError).toBeFalsy();
      expect(tasks.isError).toBeFalsy();
      expect(JSON.parse((workflow.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        ok: true,
        workflow: { id: 'wf-1', name: 'Demo' },
      });
      expect(JSON.parse((tasks.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        ok: true,
        workflowId: 'wf-1',
        tasks: [
          { id: 'wf-1/task-a', status: 'completed' },
          { id: 'wf-1/task-b', status: 'running' },
        ],
      });
    } finally {
      await close();
    }
  });

  it('bounded wait times out while tasks remain unsettled', async () => {
    const sleep = vi.fn(async () => undefined);
    const { client, close } = await connectMcpClient({
      createMessageBus: liveOwnerBusFactory((bus) => {
        bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
        bus.onRequest('headless.query', async () => ({
          output: JSON.stringify([{ id: 'wf-1/task-a', status: 'running', description: 'A' }]),
        }));
      }),
      sleep,
      reviewTokens: createReviewTokenStore(),
    });
    try {
      const result = await client.callTool({
        name: 'invoker_wait_for_workflow',
        arguments: { workflowId: 'wf-1', maxWaitMs: 5, pollIntervalMs: 1 },
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(parsed).toMatchObject({
        ok: true,
        settled: false,
        timedOut: true,
        status: { running: 1 },
      });
    } finally {
      await close();
    }
  });
});
