import { describe, it, expect } from 'vitest';
import { parseThreadRequest } from '../slack/slack-surface.js';

const LIVE_FENCED_PLAN_BOT_REPLY =
  'I’ll treat this as a normal worktree task here, not an Invoker plan\n\nThere are already local edits in the target areas.';
const LIVE_FENCED_PLAN_USER =
  '```text\nplan: Prove and fix the adverse UI test issues found in the agent thread for Invoker.\n\nScope:\n1. Fix/prove @invoker/app build behavior when git SHA lookup hits false EPERM.\n```';
const LIVE_ADVERSE_AGENT_PROSE =
  'I’ll interpret “averse test” as adverse/edge-case UI testing for an Invoker plan';
const LIVE_PATH_LEAK =
  'I inspected [scripts/land-stack.mjs](/home/invoker/.invoker/slack-manager/planning-clones/64a63486912a/scripts/land-stack.mjs:1)';

describe('DO1 e2e: parse sole fenced plan: blocks as plan mode', () => {
  it('parseThreadRequest(LIVE_FENCED_PLAN_USER) returns mode plan', () => {
    const result = parseThreadRequest(LIVE_FENCED_PLAN_USER);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('plan');
    expect(result!.text).toContain('Prove and fix the adverse UI test issues');
  });

  it('keeps LIVE_* agent prose as agent mode (not plan)', () => {
    expect(parseThreadRequest(LIVE_FENCED_PLAN_BOT_REPLY)?.mode).toBe('agent');
    expect(parseThreadRequest(LIVE_ADVERSE_AGENT_PROSE)?.mode).toBe('agent');
    expect(parseThreadRequest(LIVE_PATH_LEAK)?.mode).toBe('agent');
  });
});
