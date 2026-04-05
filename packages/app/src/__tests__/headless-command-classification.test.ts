import { describe, expect, it } from 'vitest';
import { isHeadlessMutatingCommand, isHeadlessReadOnlyCommand } from '../headless-command-classification.js';

describe('headless-command-classification', () => {
  it('classifies read-only commands', () => {
    expect(isHeadlessReadOnlyCommand([])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['query'])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['list'])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['session'])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['open-terminal'])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['run'])).toBe(false);
  });

  it('classifies mutating commands', () => {
    expect(isHeadlessMutatingCommand([])).toBe(false);
    expect(isHeadlessMutatingCommand(['query'])).toBe(false);
    expect(isHeadlessMutatingCommand(['open-terminal'])).toBe(false);
    expect(isHeadlessMutatingCommand(['slack'])).toBe(false);

    expect(isHeadlessMutatingCommand(['run'])).toBe(true);
    expect(isHeadlessMutatingCommand(['cancel-workflow'])).toBe(true);
    expect(isHeadlessMutatingCommand(['set', 'agent'])).toBe(true);
    expect(isHeadlessMutatingCommand(['set', 'unknown'])).toBe(false);
  });
});
