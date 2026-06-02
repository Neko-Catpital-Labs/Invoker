import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { prepareHeadlessFix } from '../headless.js';
import { AUTO_FIX_FLAG, type ParsedFixCommand } from '../auto-fix-intents.js';

function makeDeps(opts: {
  autoFixAttempts?: number;
  shouldAutoFix?: boolean;
  openIntents?: unknown[];
  currentIntentId?: number;
} = {}) {
  const getTask = vi.fn(() => ({ execution: { autoFixAttempts: opts.autoFixAttempts ?? 0 } }));
  const shouldAutoFix = vi.fn(() => opts.shouldAutoFix ?? true);
  const listWorkflowMutationIntents = vi.fn(() => opts.openIntents ?? []);
  const updateTask = vi.fn();
  const logEvent = vi.fn();
  const deps = {
    orchestrator: { getTask, shouldAutoFix } as any,
    persistence: { listWorkflowMutationIntents, updateTask, logEvent } as any,
    currentIntentId: opts.currentIntentId,
  };
  return { deps, mocks: { getTask, shouldAutoFix, listWorkflowMutationIntents, updateTask, logEvent } };
}

const manual = (agentName?: string): ParsedFixCommand => ({ taskId: 'wf-1/task-1', agentName, autoFix: false });
const auto = (agentName?: string): ParsedFixCommand => ({ taskId: 'wf-1/task-1', agentName, autoFix: true });

describe('prepareHeadlessFix', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  describe('manual submissions (no auto-fix context)', () => {
    it('uses "Fix with AI" labels and defaults the agent to claude', () => {
      const { deps, mocks } = makeDeps();
      const result = prepareHeadlessFix('wf-1/task-1', 'wf-1', manual(), deps);
      expect(result).toEqual({
        agentName: 'claude',
        recreateOutputLabel: 'Fix with AI',
        failureOutputLabel: 'Fix with AI',
      });
      // Manual fix must not consume auto-fix budget or check eligibility.
      expect(mocks.updateTask).not.toHaveBeenCalled();
      expect(mocks.shouldAutoFix).not.toHaveBeenCalled();
      expect(mocks.listWorkflowMutationIntents).not.toHaveBeenCalled();
    });

    it('honours an explicit manual agent', () => {
      const { deps } = makeDeps();
      const result = prepareHeadlessFix('wf-1/task-1', 'wf-1', manual('Codex'), deps);
      expect(result?.agentName).toBe('codex');
    });
  });

  describe('auto-fix submissions', () => {
    it('increments autoFixAttempts exactly once and uses "Auto-fix" labels', () => {
      const { deps, mocks } = makeDeps({ autoFixAttempts: 2 });
      const result = prepareHeadlessFix('wf-1/task-1', 'wf-1', auto('claude'), deps, () => undefined);
      expect(result).toMatchObject({
        recreateOutputLabel: 'Auto-fix',
        failureOutputLabel: 'Auto-fix',
        agentName: 'claude',
      });
      expect(mocks.updateTask).toHaveBeenCalledTimes(1);
      expect(mocks.updateTask).toHaveBeenCalledWith('wf-1/task-1', { execution: { autoFixAttempts: 3 } });
    });

    it('prefers the configured autoFixAgent over the submitted agent', () => {
      const { deps } = makeDeps();
      const result = prepareHeadlessFix('wf-1/task-1', 'wf-1', auto('claude'), deps, () => 'Codex');
      expect(result?.agentName).toBe('codex');
    });

    it('leaves the agent unset when neither configured nor submitted', () => {
      const { deps } = makeDeps();
      const result = prepareHeadlessFix('wf-1/task-1', 'wf-1', auto(), deps, () => undefined);
      expect(result?.agentName).toBeUndefined();
    });

    it('skips and does not increment when a duplicate open fix intent exists', () => {
      const openIntents = [
        { id: 5, channel: 'invoker:fix-with-agent', args: ['wf-1/task-1'] },
      ];
      const { deps, mocks } = makeDeps({ openIntents });
      const result = prepareHeadlessFix('wf-1/task-1', 'wf-1', auto('claude'), deps, () => undefined);
      expect(result).toBeNull();
      expect(mocks.updateTask).not.toHaveBeenCalled();
      expect(mocks.logEvent).toHaveBeenCalledWith('wf-1/task-1', 'debug.auto-fix', expect.objectContaining({
        phase: 'headless-fix-skip',
        reason: 'duplicate-open-intent',
      }));
    });

    it('excludes the currently-executing intent so a worker fix is not self-suppressed', () => {
      const openIntents = [
        { id: 42, channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1', AUTO_FIX_FLAG] }] },
      ];
      const { deps, mocks } = makeDeps({ openIntents, currentIntentId: 42 });
      const result = prepareHeadlessFix('wf-1/task-1', 'wf-1', auto(), deps, () => undefined);
      expect(result).not.toBeNull();
      expect(mocks.updateTask).toHaveBeenCalledTimes(1);
    });

    it('skips and does not increment when shouldAutoFix is false (budget exhausted)', () => {
      const { deps, mocks } = makeDeps({ shouldAutoFix: false });
      const result = prepareHeadlessFix('wf-1/task-1', 'wf-1', auto('claude'), deps, () => undefined);
      expect(result).toBeNull();
      expect(mocks.updateTask).not.toHaveBeenCalled();
      expect(mocks.logEvent).toHaveBeenCalledWith('wf-1/task-1', 'debug.auto-fix', expect.objectContaining({
        phase: 'headless-fix-skip',
        reason: 'should-not-auto-fix',
      }));
    });
  });
});
