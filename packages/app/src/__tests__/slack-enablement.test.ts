import { describe, it, expect } from 'vitest';
import { slackDisabledForTests } from '../slack-enablement.js';

describe('slackDisabledForTests', () => {
  it('is true when NODE_ENV is test', () => {
    expect(slackDisabledForTests({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is true when INVOKER_DISABLE_SLACK is 1', () => {
    expect(slackDisabledForTests({ INVOKER_DISABLE_SLACK: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is false for a normal production env with real creds', () => {
    expect(
      slackDisabledForTests({ NODE_ENV: 'production', SLACK_BOT_TOKEN: 'xoxb-real' } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('is false when the disable flag is not exactly "1"', () => {
    expect(slackDisabledForTests({ INVOKER_DISABLE_SLACK: '0' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
