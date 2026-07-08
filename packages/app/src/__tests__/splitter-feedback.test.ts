import { describe, expect, it, vi } from 'vitest';
import { recordSplitterPlanFeedback, splitterFeedbackEnabled } from '../splitter-feedback.js';

describe('splitter-feedback', () => {
  it('enables feedback when experimental planner is on', () => {
    expect(splitterFeedbackEnabled({ experimentalPlanner: true })).toBe(true);
    expect(splitterFeedbackEnabled({ experimentalPlanner: true, splitterFeedback: { enabled: false } })).toBe(false);
    expect(splitterFeedbackEnabled({ experimentalPlanner: false, splitterFeedback: { enabled: true } })).toBe(true);
  });

  it('skips when no Splitter plan id is present', async () => {
    const callTool = vi.fn();
    const result = await recordSplitterPlanFeedback({
      config: { experimentalPlanner: true },
      callTool,
    });

    expect(result).toBe('skipped');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('sends accepted feedback through the configured MCP server', async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    const result = await recordSplitterPlanFeedback({
      config: {
        experimentalPlanner: true,
        splitterFeedback: {
          person: 'config-person',
          timeoutMs: 1234,
          mcpServer: {
            command: 'python3',
            args: ['-m', 'integrations.invoker_planner.server'],
            env: { PLANNER_URL: 'http://127.0.0.1:9' },
          },
        },
      },
      splitterPlanId: ' plan-123 ',
      splitterPerson: ' plan-person ',
      callTool,
    });

    expect(result).toBe('sent');
    expect(callTool).toHaveBeenCalledWith({
      toolName: 'feedback',
      timeoutMs: 1234,
      server: {
        command: 'python3',
        args: ['-m', 'integrations.invoker_planner.server'],
        env: { PLANNER_URL: 'http://127.0.0.1:9' },
      },
      args: {
        plan_id: 'plan-123',
        liked: true,
        comment: 'Invoker generated plan submitted',
        person: 'plan-person',
      },
    });
  });

  it('logs and does not throw when MCP feedback fails', async () => {
    const logger = { warn: vi.fn() };
    const result = await recordSplitterPlanFeedback({
      config: { experimentalPlanner: true },
      splitterPlanId: 'plan-123',
      callTool: vi.fn().mockRejectedValue(new Error('server down')),
      logger,
    });

    expect(result).toBe('failed');
    expect(logger.warn.mock.calls[0][0]).toContain('server down');
  });
});
