import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter, ConversationRepository, WorkflowChannelRepository } from '@invoker/data-store';
import { registerBuiltinAgents } from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';
import type { AgentSessionData } from '@invoker/contracts';
import { presetToExecutionAgent, gatherWorkflowContext } from '../slack-workflow-context.js';

const silent = () => {};

const PRESETS = {
  'cursor+claude': { tool: 'cursor', model: 'claude' },
  'cursor+codex': { tool: 'cursor', model: 'codex' },
  'omp+claude': { tool: 'omp', model: 'claude' },
  codex: { tool: 'codex' },
};
const REGISTERED = new Set(['claude', 'codex', 'omp']);

describe('presetToExecutionAgent', () => {
  it('uses the preset tool when it is a registered execution agent', () => {
    expect(presetToExecutionAgent('omp+claude', PRESETS, REGISTERED, 'claude')).toBe('omp');
    expect(presetToExecutionAgent('codex', PRESETS, REGISTERED, 'claude')).toBe('codex');
  });

  it('falls back to the preset model when the tool is not an execution agent', () => {
    expect(presetToExecutionAgent('cursor+codex', PRESETS, REGISTERED, 'claude')).toBe('codex');
    expect(presetToExecutionAgent('cursor+claude', PRESETS, REGISTERED, 'claude')).toBe('claude');
  });

  it('uses the default agent for unknown or missing presets', () => {
    expect(presetToExecutionAgent('mystery', PRESETS, REGISTERED, 'claude')).toBe('claude');
    expect(presetToExecutionAgent(undefined, PRESETS, REGISTERED, 'claude')).toBe('claude');
  });
});

describe('gatherWorkflowContext', () => {
  let adapter: SQLiteAdapter;
  let conversationRepo: ConversationRepository;
  let workflowChannelRepo: WorkflowChannelRepository;

  const apiTask: TaskState = {
    id: 'wf-1/api',
    description: 'api',
    status: 'completed',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: 'wf-1' },
    execution: { agentSessionId: 'sess-1', agentName: 'claude' },
    taskStateVersion: 1,
  };
  const mergeTask: TaskState = {
    id: '__merge__wf-1',
    description: 'merge',
    status: 'pending',
    dependencies: ['wf-1/api'],
    createdAt: new Date(),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {},
    taskStateVersion: 1,
  };

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    conversationRepo = new ConversationRepository(adapter, { info: silent, warn: silent, error: silent });
    conversationRepo.saveConversation('t1', [{ role: 'user', content: 'plan this' }], null, false, 'CLOBBY', 'U1');
    workflowChannelRepo = new WorkflowChannelRepository(adapter);
    workflowChannelRepo.save({ workflowId: 'wf-1', channelId: 'C123', lobbyThreadTs: 't1', createdAt: new Date().toISOString() });
  });

  afterEach(() => { adapter.close(); });

  it('returns the planning conversation plus one entry per non-merge task with its transcript', async () => {
    const resolveSession = async (sessionId: string, agentName: string): Promise<AgentSessionData> => ({
      agentName,
      sessionId,
      state: 'finished',
      messages: [{ role: 'assistant', content: 'did X on api', timestamp: '' }],
    });

    const ctx = await gatherWorkflowContext(
      {
        persistence: {
          loadTasks: () => [mergeTask, apiTask],
          getTaskOutput: (id) => (id === 'wf-1/api' ? 'added /health' : ''),
        },
        conversationRepo,
        workflowChannelRepo,
        agentRegistry: registerBuiltinAgents(),
        resolveSession,
      },
      'wf-1',
    );

    expect(ctx.workflowId).toBe('wf-1');
    expect(ctx.planning).toEqual([{ role: 'user', content: 'plan this' }]);
    expect(ctx.tasks).toEqual([
      {
        id: 'wf-1/api',
        status: 'completed',
        agentName: 'claude',
        transcript: [{ role: 'assistant', content: 'did X on api' }],
        output: 'added /health',
      },
    ]);
  });

  it('tolerates a session load failure and still lists the task', async () => {
    const resolveSession = async (): Promise<AgentSessionData> => { throw new Error('boom'); };
    const ctx = await gatherWorkflowContext(
      {
        persistence: { loadTasks: () => [apiTask], getTaskOutput: () => '' },
        conversationRepo,
        workflowChannelRepo,
        agentRegistry: registerBuiltinAgents(),
        resolveSession,
        log: silent,
      },
      'wf-1',
    );
    expect(ctx.tasks).toEqual([
      { id: 'wf-1/api', status: 'completed', agentName: 'claude', transcript: [], output: undefined },
    ]);
  });
});
