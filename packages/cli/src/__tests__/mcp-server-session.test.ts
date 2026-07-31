import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LocalBus, type MessageBus } from '@invoker/transport';

import { createMcpServer, type McpServerOptions } from '../mcp-server.js';

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
      expect(parsed).toMatchObject({
        planText: expect.any(String),
        summary: { name: 'Hello World CLI', taskCount: 1 },
        confirmationMode: 'require',
        confirmationText: 'Approve to submit this exact YAML. Cancel keeps the draft. Discard removes it.',
      });
    } finally {
      await close();
    }
  });

  it('leaves the file-path invoker_submit_plan behavior unchanged with no sessionId and no env var', async () => {
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

      expect(result.isError).toBeFalsy();
      expect(runner.run).toHaveBeenCalledTimes(1);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain('wf-file-path');
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
        arguments: { planPath: '/nonexistent/plan.yaml', sessionId: 'sess-no-owner' },
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
        arguments: { planPath: '/nonexistent/plan.yaml', sessionId: 'sess-with-draft' },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed).toEqual({
        planText: 'name: Session Plan\nonFinish: none\ntasks: []\n',
        summary: { name: 'Session Plan', taskCount: 0, taskGroups: [] },
        confirmationMode: 'require',
        confirmationText: 'Approve to submit this exact YAML. Cancel keeps the draft. Discard removes it.',
      });
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
        arguments: { planPath: '/nonexistent/plan.yaml', sessionId: 'sess-missing' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe('Unknown planning session "sess-missing". It may have been deleted or never existed.');
    } finally {
      await close();
    }
  });

  it('dispatches invoker_submit_plan through headless.gui-mutation and maps an ok response', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    const guiMutation = vi.fn(async (req: unknown) => {
      expect(req).toEqual({
        channel: 'invoker:planning-chat-submit',
        args: [{ sessionId: 'sess-submit-ok' }],
      });
      return { ok: true, planName: 'Session Plan', workflowId: 'wf-session-1' };
    });
    bus.onRequest('headless.gui-mutation', guiMutation);
    const { client, close } = await connectMcpClient({ createMessageBus: async () => bus });
    try {
      const result = await client.callTool({
        name: 'invoker_submit_plan',
        arguments: { planPath: '/nonexistent/plan.yaml', sessionId: 'sess-submit-ok' },
      });

      expect(result.isError).toBeFalsy();
      expect(guiMutation).toHaveBeenCalledTimes(1);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe('Submitted Invoker plan. Workflow id: wf-session-1.');
    } finally {
      await close();
    }
  });

  it('maps a failed headless.gui-mutation response to an MCP error result', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.gui-mutation', async () => ({ ok: false, error: 'This planning session was already submitted.' }));
    const { client, close } = await connectMcpClient({ createMessageBus: async () => bus });
    try {
      const result = await client.callTool({
        name: 'invoker_submit_plan',
        arguments: { planPath: '/nonexistent/plan.yaml', sessionId: 'sess-submit-fail' },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe('This planning session was already submitted.');
    } finally {
      await close();
    }
  });

  it('honors INVOKER_PLANNING_SESSION_ID as a fallback when no explicit sessionId argument is given', async () => {
    process.env.INVOKER_PLANNING_SESSION_ID = 'sess-from-env';
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
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
    bus.onRequest('headless.query', query);
    const { client, close } = await connectMcpClient({ createMessageBus: async () => bus });
    try {
      const result = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { planPath: '/nonexistent/plan.yaml' },
      });

      expect(result.isError).toBeFalsy();
      expect(query).toHaveBeenCalledTimes(1);
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.confirmationMode).toBe('auto_submit');
      expect(parsed.confirmationText).toBe('Auto-submit is enabled. Submit this exact YAML now.');
    } finally {
      await close();
    }
  });
});
