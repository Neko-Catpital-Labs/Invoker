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
});

describe('looksLikeQuestion', () => {
  it('recognizes questions with an ASCII question mark', () => {
    expect(looksLikeQuestion('What files are in this repo?')).toBe(true);
    expect(looksLikeQuestion('is this correct?')).toBe(true);
  });

  it('recognizes punctuation-free questions from an interrogative lead word', () => {
    expect(looksLikeQuestion('What files are in this repo')).toBe(true);
    expect(looksLikeQuestion('How does the reaper worker retry tasks')).toBe(true);
    expect(looksLikeQuestion('Can we skip the extra dependency')).toBe(true);
  });

  it('recognizes questions punctuated with a non-ASCII question mark', () => {
    expect(looksLikeQuestion('¿Qué archivos hay en este repo¿')).toBe(true); // inverted ¿
    expect(looksLikeQuestion('这是什么？')).toBe(true); // fullwidth ？
    expect(looksLikeQuestion('Τί κάνει αυτό;')).toBe(true); // Greek ;
    expect(looksLikeQuestion('Այս ինչվին')).toBe(false);
  });

  it('does not flag informational statements as questions', () => {
    expect(looksLikeQuestion('github.com/Neko-Catpital-Labs/Invoker/')).toBe(false);
    expect(looksLikeQuestion('Use the SQLite adapter for persistence.')).toBe(false);
    expect(looksLikeQuestion('')).toBe(false);
  });
});
