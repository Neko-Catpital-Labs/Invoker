import { describe, it, expect } from 'vitest';
import { sanitizeSlashCommands } from '../slack/slack-message-helpers.js';

const LIVE_FENCED_PLAN_BOT_REPLY =
  'I’ll treat this as a normal worktree task here, not an Invoker plan\n\nThere are already local edits in the target areas.';
const LIVE_FENCED_PLAN_USER =
  '```text\nplan: Prove and fix the adverse UI test issues found in the agent thread for Invoker.\n\nScope:\n1. Fix/prove @invoker/app build behavior when git SHA lookup hits false EPERM.\n```';
const LIVE_ADVERSE_AGENT_PROSE =
  'I’ll interpret “averse test” as adverse/edge-case UI testing for an Invoker plan';
const LIVE_PATH_LEAK =
  'I inspected [scripts/land-stack.mjs](/home/invoker/.invoker/slack-manager/planning-clones/64a63486912a/scripts/land-stack.mjs:1)';

describe('DO1 e2e: sanitizeSlashCommands leaves Invoker plan prose alone', () => {
  it('does not rewrite LIVE_FENCED_PLAN_BOT_REPLY', () => {
    expect(sanitizeSlashCommands(LIVE_FENCED_PLAN_BOT_REPLY)).toBe(LIVE_FENCED_PLAN_BOT_REPLY);
  });

  it('does not rewrite LIVE_FENCED_PLAN_USER', () => {
    expect(sanitizeSlashCommands(LIVE_FENCED_PLAN_USER)).toBe(LIVE_FENCED_PLAN_USER);
  });

  it('does not rewrite LIVE_ADVERSE_AGENT_PROSE', () => {
    expect(sanitizeSlashCommands(LIVE_ADVERSE_AGENT_PROSE)).toBe(LIVE_ADVERSE_AGENT_PROSE);
  });

  it('does not rewrite LIVE_PATH_LEAK', () => {
    expect(sanitizeSlashCommands(LIVE_PATH_LEAK)).toBe(LIVE_PATH_LEAK);
  });

  it('still rewrites /invoker start_plan', () => {
    expect(sanitizeSlashCommands('run `/invoker start_plan` now')).toBe(
      'reply with "yes", "go", or "execute" to confirm now',
    );
  });

  it('does not splice a replacement into a backtick-adjacent confirmation word', () => {
    expect(sanitizeSlashCommands('reply with "yes", "go", or "execute" to confirm`/invoker submit`')).toBe(
      'reply with "yes", "go", or "execute" to confirm`/invoker submit`',
    );
  });
});
