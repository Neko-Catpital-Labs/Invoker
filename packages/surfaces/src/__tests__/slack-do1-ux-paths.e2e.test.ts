import { describe, it, expect } from 'vitest';
import { redactAbsolutePaths, sanitizeSlackOutbound } from '../slack/slack-message-helpers.js';

const LIVE_FENCED_PLAN_BOT_REPLY =
  'I’ll treat this as a normal worktree task here, not an Invoker plan\n\nThere are already local edits in the target areas.';
const LIVE_FENCED_PLAN_USER =
  '```text\nplan: Prove and fix the adverse UI test issues found in the agent thread for Invoker.\n\nScope:\n1. Fix/prove @invoker/app build behavior when git SHA lookup hits false EPERM.\n```';
const LIVE_ADVERSE_AGENT_PROSE =
  'I’ll interpret “averse test” as adverse/edge-case UI testing for an Invoker plan';
const LIVE_PATH_LEAK =
  'I inspected [scripts/land-stack.mjs](/home/invoker/.invoker/slack-manager/planning-clones/64a63486912a/scripts/land-stack.mjs:1)';

describe('DO1 e2e: redact absolute checkout paths from Slack replies', () => {
  it('redactAbsolutePaths removes /home/invoker from LIVE_PATH_LEAK', () => {
    const redacted = redactAbsolutePaths(LIVE_PATH_LEAK);
    expect(redacted).not.toContain('/home/invoker');
    expect(redacted).toContain('scripts/land-stack.mjs');
  });

  it('sanitizeSlackOutbound removes /home/invoker from LIVE_PATH_LEAK', () => {
    const scrubbed = sanitizeSlackOutbound(LIVE_PATH_LEAK);
    expect(scrubbed).not.toContain('/home/invoker');
    expect(scrubbed).toContain('…/');
  });

  it('does not alter LIVE_* prose without absolute paths', () => {
    expect(redactAbsolutePaths(LIVE_FENCED_PLAN_BOT_REPLY)).toBe(LIVE_FENCED_PLAN_BOT_REPLY);
    expect(redactAbsolutePaths(LIVE_FENCED_PLAN_USER)).toBe(LIVE_FENCED_PLAN_USER);
    expect(redactAbsolutePaths(LIVE_ADVERSE_AGENT_PROSE)).toBe(LIVE_ADVERSE_AGENT_PROSE);
  });
});
