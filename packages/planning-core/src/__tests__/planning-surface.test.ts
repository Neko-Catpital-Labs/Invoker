import { describe, expect, it } from 'vitest';
import {
  formatPlanningHostedTurn,
  resolvePlanningSubmitAction,
} from '../planning-surface.js';

describe('planning surface parity contract', () => {
  it('resolves exact submit commands from shared draft state', () => {
    for (const command of ['submit', 'Submit it!', 'submit to invoker.']) {
      expect(resolvePlanningSubmitAction(command, false)).toBe('prepare_review');
      expect(resolvePlanningSubmitAction(command, true)).toBe('submit_ready');
    }
  });

  it('does not execute submit-like prose', () => {
    expect(resolvePlanningSubmitAction("don't submit to Slack; submit to Invoker", true)).toBeNull();
    expect(resolvePlanningSubmitAction('can you submit this?', true)).toBeNull();
    expect(resolvePlanningSubmitAction('submit to inovker', true)).toBeNull();
  });

  it('restates the current host on every hosted turn', () => {
    expect(formatPlanningHostedTurn('in_app', 'continue')).toContain('Current planning host: Invoker in-app planner.');
    expect(formatPlanningHostedTurn('in_app', 'continue')).toContain('Never direct the user to Slack');
    expect(formatPlanningHostedTurn('slack', 'continue')).toContain('Current planning host: Invoker Slack planner.');
  });
});
