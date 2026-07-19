import { describe, it, expect } from 'vitest';
import { isConfirmation } from '../slack/plan-conversation.js';

const LIVE_FENCED_PLAN_BOT_REPLY =
  'I’ll treat this as a normal worktree task here, not an Invoker plan\n\nThere are already local edits in the target areas.';
const LIVE_FENCED_PLAN_USER =
  '```text\nplan: Prove and fix the adverse UI test issues found in the agent thread for Invoker.\n\nScope:\n1. Fix/prove @invoker/app build behavior when git SHA lookup hits false EPERM.\n```';
const LIVE_ADVERSE_AGENT_PROSE =
  'I’ll interpret “averse test” as adverse/edge-case UI testing for an Invoker plan';
const LIVE_PATH_LEAK =
  'I inspected [scripts/land-stack.mjs](/home/invoker/.invoker/slack-manager/planning-clones/64a63486912a/scripts/land-stack.mjs:1)';

describe('DO1 e2e: confirmation matching for pending approval abandon', () => {
  it("isConfirmation('ok') is true", () => {
    expect(isConfirmation('ok')).toBe(true);
  });

  it("isConfirmation('yes please add more tests') is false", () => {
    expect(isConfirmation('yes please add more tests')).toBe(false);
  });

  it('does not treat LIVE_* prose as confirmations', () => {
    expect(isConfirmation(LIVE_FENCED_PLAN_BOT_REPLY)).toBe(false);
    expect(isConfirmation(LIVE_FENCED_PLAN_USER)).toBe(false);
    expect(isConfirmation(LIVE_ADVERSE_AGENT_PROSE)).toBe(false);
    expect(isConfirmation(LIVE_PATH_LEAK)).toBe(false);
  });
});
