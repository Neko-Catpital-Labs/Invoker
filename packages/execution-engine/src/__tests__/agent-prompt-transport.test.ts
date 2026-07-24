import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES,
  materializeLocalAgentPrompt,
} from '../agent-prompt-transport.js';

describe('materializeLocalAgentPrompt', () => {
  it('keeps prompts at the inline threshold unchanged', () => {
    const prompt = 'a'.repeat(DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES);
    const transport = materializeLocalAgentPrompt(prompt);

    expect(transport.effectivePrompt).toBe(prompt);
    transport.cleanup();
  });

  it('writes oversized prompts to a temporary file and removes it on cleanup', () => {
    const prompt = 'running task context\n'.repeat(10_000);
    const transport = materializeLocalAgentPrompt(prompt);
    const match = transport.effectivePrompt.match(/file: (.+)\n/);

    expect(match?.[1]).toContain('invoker-agent-prompt-');
    expect(readFileSync(match![1], 'utf8')).toBe(prompt);

    transport.cleanup();

    expect(existsSync(match![1])).toBe(false);
  });
});
