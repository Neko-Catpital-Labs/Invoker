import { describe, it, expect } from 'vitest';
import { parseWorkflowStatusQuery } from '../slack/slack-surface.js';

describe('parseWorkflowStatusQuery false positive repro', () => {
  // Real message that triggered this in Slack: a /loop babysit-loop instruction.
  it('does not treat a long babysit/loop instruction as a status query', () => {
    const babysitLoopMessage = `/loop keep babysitting the DO1 admin-bypass repair worker. For each task and workflow that fails, please prove root
cause with a repro scirpt, how it happened, why we missed it, and fix the root issue and how we can avoid this kind of
issue again. Make a pr natively through /pr-skill and not thorugh invoker.
Context: PR #7652 (github.com/Neko-Catpital-Labs/Invoker/pull/7652) has all individually-required checks green.
It's in Mergify's admin-bypass queue, state "checking"/"Preparing checks", ETA has slipped from 00:17 to 00:27 UTC across
the last two checks (still healthy progress, GH Actions still catching up post-outage, not stuck -- checks_timeout is
60min per .mergify.yml so there's buffer).`;

    expect(parseWorkflowStatusQuery(babysitLoopMessage)).toBeNull();
  });
});
