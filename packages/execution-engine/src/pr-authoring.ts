import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import type { ExecutionAgent } from './agent.js';
import type { SessionDriver } from './session-driver.js';
import { cleanElectronEnv } from './process-utils.js';
import { validateCanonicalPrBody } from './canonical-pr-body.js';
const DEFAULT_MAX_INLINE_PROMPT_BYTES = 64 * 1024;
const MAX_INLINE_PROMPT_BYTES = (() => {
  const raw = process.env.INVOKER_MAX_INLINE_AGENT_PROMPT_BYTES;
  if (!raw) return DEFAULT_MAX_INLINE_PROMPT_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INLINE_PROMPT_BYTES;
})();

export { validateCanonicalPrBody };

function promptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

function buildPromptFileBootstrap(promptPath: string): string {
  return [
    `The full task instructions are in this file: ${promptPath}`,
    'Read the file completely, then execute those instructions in this workspace.',
    'Do not ask for the file contents.',
  ].join('\n');
}

function materializeLocalPrompt(prompt: string): { effectivePrompt: string; cleanup: () => void } {
  if (promptByteLength(prompt) <= MAX_INLINE_PROMPT_BYTES) {
    return { effectivePrompt: prompt, cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), 'invoker-pr-author-prompt-'));
  const promptPath = join(dir, 'prompt.md');
  writeFileSync(promptPath, prompt, 'utf8');
  return {
    effectivePrompt: buildPromptFileBootstrap(promptPath),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

function extractAssistantBody(driver: SessionDriver | undefined, sessionId: string, fallback: string): string {
  const rawSession = driver?.loadSession(sessionId);
  if (rawSession && driver) {
    const messages = driver.parseSession(rawSession);
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      const message = messages[idx];
      if (message?.role === 'assistant' && message.content.trim()) {
        return message.content.trim();
      }
    }
  }
  return fallback.trim();
}

export function resolveInstalledSkillPathForAgent(agentName: string, skillName: string): string | null {
  const normalized = agentName.trim().toLowerCase();
  const home = homedir();
  const skillDir = normalized === 'codex'
    ? join(home, '.codex', 'skills', `invoker-${skillName}`)
    : normalized === 'claude'
      ? join(home, '.claude', 'skills', `invoker-${skillName}`)
      : null;
  if (!skillDir) return null;
  return existsSync(join(skillDir, 'SKILL.md')) ? skillDir : null;
}

const MAKE_PR_PROMPT_TEMPLATE = readFileSync(
  new URL('./make-pr-prompt.md', import.meta.url),
  'utf8',
);

function renderPromptTemplate(template: string, substitutions: Record<string, string>): string {
  let content = template;
  for (const [key, value] of Object.entries(substitutions)) {
    content = content.replaceAll(`%${key}%`, value);
  }
  return content.trim();
}

export function buildMakePrPrompt(args: {
  skillPath: string;
  title: string;
  baseBranch: string;
  featureBranch: string;
  workflowSummary: string;
}): string {
  return renderPromptTemplate(MAKE_PR_PROMPT_TEMPLATE, {
    SKILL_PATH: args.skillPath,
    TITLE: args.title,
    BASE_BRANCH: args.baseBranch,
    FEATURE_BRANCH: args.featureBranch,
    WORKFLOW_SUMMARY: args.workflowSummary.trim(),
  });
}

export function spawnAgentPrAuthorViaRegistry(
  prompt: string,
  cwd: string,
  agent: ExecutionAgent,
  driver?: SessionDriver,
): Promise<{ body: string; stdout: string; sessionId: string }> {
  const promptTransport = materializeLocalPrompt(prompt);
  const spec = agent.buildCommand(promptTransport.effectivePrompt);
  const sessionId = spec.sessionId ?? randomUUID();

  return new Promise<{ body: string; stdout: string; sessionId: string }>((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanElectronEnv(),
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      const realId = driver?.extractSessionId?.(stdout);
      const effectiveSessionId = realId ?? sessionId;
      const displayStdout = driver ? driver.processOutput(effectiveSessionId, stdout) : stdout;
      if (code === 0) {
        const body = extractAssistantBody(driver, effectiveSessionId, displayStdout);
        promptTransport.cleanup();
        resolve({ body, stdout: displayStdout, sessionId: effectiveSessionId });
        return;
      }
      promptTransport.cleanup();
      reject(new Error(`${agent.name} PR authoring exited with code ${code}: ${stderr.trim()}`));
    });
    child.on('error', (err) => {
      promptTransport.cleanup();
      reject(err);
    });
  });
}
