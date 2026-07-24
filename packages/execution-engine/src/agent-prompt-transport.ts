import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES = 64 * 1024;

export interface LocalPromptCleanupResult {
  directory: string;
  error: Error;
}

export interface LocalPromptTransport {
  effectivePrompt: string;
  cleanup: () => LocalPromptCleanupResult | undefined;
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


function removePromptDirectory(directory: string): LocalPromptCleanupResult | undefined {
  try {
    rmSync(directory, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return {
      directory,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function materializeLocalAgentPrompt(
  prompt: string,
  directoryPrefix: string = 'invoker-agent-prompt-',
): LocalPromptTransport {
  if (shouldInlineAgentPrompt(prompt)) {
    return { effectivePrompt: prompt, cleanup: () => undefined };
  }
  const directory = mkdtempSync(join(tmpdir(), directoryPrefix));
  const promptPath = join(directory, 'prompt.md');
  try {
    writeFileSync(promptPath, prompt, 'utf8');
  } catch (error) {
    removePromptDirectory(directory);
    throw error;
  }
  return {
    effectivePrompt: buildAgentPromptFileBootstrap(promptPath),
    cleanup: () => removePromptDirectory(directory),
  };
}
