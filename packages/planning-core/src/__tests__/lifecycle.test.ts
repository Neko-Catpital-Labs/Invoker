import { describe, expect, it } from 'vitest';
import {
  hasExplicitDraftIntent,
  isDraftingAuthorized,
  looksLikeQuestion,
} from '../lifecycle.js';

describe('Planning Terminal lifecycle contract', () => {
  it('authorizes only explicit draft intent or confirmation of an assistant draft question', () => {
    expect(hasExplicitDraftIntent('proceed')).toBe(true);
    expect(hasExplicitDraftIntent('submit')).toBe(true);
    expect(hasExplicitDraftIntent('submit it!')).toBe(true);
    expect(hasExplicitDraftIntent('submit to invoker')).toBe(true);
    expect(hasExplicitDraftIntent("don't submit to Slack; submit to Invoker")).toBe(false);
    expect(isDraftingAuthorized('yes', [
      { role: 'assistant', content: 'Would you like me to draft the YAML plan?' },
    ])).toBe(true);
    expect(isDraftingAuthorized('yes', [
      { role: 'assistant', content: 'Here is an explanation.' },
    ])).toBe(false);
  });

  it('classifies questions without relying solely on an ASCII "?"', () => {
    expect(looksLikeQuestion('What files are in this repo')).toBe(true);
    expect(looksLikeQuestion('How does this work')).toBe(true);
    expect(looksLikeQuestion('Can you explain the auth flow')).toBe(true);
    expect(looksLikeQuestion('这个文件在哪里？')).toBe(true);
    expect(looksLikeQuestion('¿Qué archivos hay')).toBe(true);
    expect(looksLikeQuestion('من فضلك، أين الملف؟')).toBe(true);
    expect(looksLikeQuestion('What files are in this repo?')).toBe(true);
    expect(looksLikeQuestion('Here is the info you need.')).toBe(false);
    expect(looksLikeQuestion('The API key is stored in .env.')).toBe(false);
    expect(looksLikeQuestion('')).toBe(false);
  });
});
