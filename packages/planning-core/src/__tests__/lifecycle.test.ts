import { describe, expect, it } from 'vitest';
import {
  hasExplicitDraftIntent,
  isDraftingAuthorized,
} from '../lifecycle.js';

describe('Planning Terminal lifecycle contract', () => {
  it('authorizes only explicit draft intent or confirmation of an assistant draft question', () => {
    expect(hasExplicitDraftIntent('proceed')).toBe(true);
    expect(isDraftingAuthorized('yes', [
      { role: 'assistant', content: 'Would you like me to draft the YAML plan?' },
    ])).toBe(true);
    expect(isDraftingAuthorized('yes', [
      { role: 'assistant', content: 'Here is an explanation.' },
    ])).toBe(false);
  });
});
