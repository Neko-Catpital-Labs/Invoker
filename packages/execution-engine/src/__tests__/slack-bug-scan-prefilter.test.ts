import { describe, expect, it } from 'vitest';
import { looksLikeBugComplaint } from '../workers/slack-bug-scan-prefilter.js';

describe('slack-bug-scan prefilter', () => {
  it('matches common complaint phrasing', () => {
    expect(looksLikeBugComplaint('the login button is broken')).toBe(true);
    expect(looksLikeBugComplaint('this crashes every time I click submit')).toBe(true);
    expect(looksLikeBugComplaint("it doesn't work at all")).toBe(true);
    expect(looksLikeBugComplaint('the request timed out again')).toBe(true);
  });

  it('does not match ordinary chatter', () => {
    expect(looksLikeBugComplaint('good morning everyone')).toBe(false);
    expect(looksLikeBugComplaint('can someone review my PR when they get a chance')).toBe(false);
  });
});
