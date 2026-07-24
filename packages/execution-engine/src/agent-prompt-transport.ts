import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES = 64 * 1024;

export interface LocalPromptTransport {
  effectivePrompt: string;
  cleanup: () => void;
}

export function maxInlineAgentPromptBytes(): number {
  const raw = process.env.INVOKER_MAX_INLINE_AGENT_PROMPT_BYTES;
  if (!raw) return DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES;
}

export function shouldInlineAgentPrompt(prompt: string): boolean {
  return Buffer.byteLength(prompt, 'utf8') <= maxInlineAgentPromptBytes();
}

export function buildAgentPromptFileBootstrap(promptPath: string): string {
  return [
    `The full task instructions are in this file: ${promptPath}`,
    'Read the file completely, then execute those instructions in this workspace.',
    'Do not ask for the file contents.',
  ].join('\n');
}

export function materializeLocalAgentPrompt(
  prompt: string,
  directoryPrefix: string = 'invoker-agent-prompt-',
): LocalPromptTransport {
  if (shouldInlineAgentPrompt(prompt)) {
    return { effectivePrompt: prompt, cleanup: () => {} };
  }
  const directory = mkdtempSync(join(tmpdir(), directoryPrefix));
  const promptPath = join(directory, 'prompt.md');
  writeFileSync(promptPath, prompt, 'utf8');
  return {
    effectivePrompt: buildAgentPromptFileBootstrap(promptPath),
    cleanup: () => {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {}
    },
  };
}
