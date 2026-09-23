import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLAUDE_HOOK_SCRIPT } from './fragments.js';

type HookRun = { stdout: string; additionalContext: string | null };

describe('claude prompt submit hook', () => {
  let root: string;
  let scriptPath: string;
  let statePath: string;
  let transcriptPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'invoker-hook-test-'));
    scriptPath = path.join(root, 'claude_prompt_submit.mjs');
    writeFileSync(scriptPath, CLAUDE_HOOK_SCRIPT);
    statePath = path.join(root, 'state');
    mkdirSync(statePath, { recursive: true });
    transcriptPath = path.join(root, 'transcript.jsonl');
    writeFileSync(transcriptPath, '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(event: Record<string, unknown>): HookRun {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: statePath },
    });
    const trimmed = stdout.trim();
    if (!trimmed) return { stdout, additionalContext: null };
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return { stdout, additionalContext: parsed.hookSpecificOutput?.additionalContext ?? null };
  }

  function humanPrompt(sessionId = 'session-a'): HookRun {
    appendFileSync(transcriptPath, `${JSON.stringify({ type: 'user' })}\n`);
    return run({ session_id: sessionId, transcript_path: transcriptPath, prompt: 'please do the thing' });
  }

  function taskNotification(sessionId = 'session-a'): HookRun {
    appendFileSync(transcriptPath, `${JSON.stringify({ type: 'user' })}\n`);
    return run({
      session_id: sessionId,
      transcript_path: transcriptPath,
      prompt: '<task-notification>Agent finished</task-notification>',
    });
  }

  function compact(): void {
    appendFileSync(transcriptPath, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`);
  }

  it('injects once per session and once after each compaction, never for task notifications', () => {
    const runs = [humanPrompt(), taskNotification(), taskNotification(), taskNotification(), humanPrompt()];
    compact();
    runs.push(humanPrompt());

    const injected = runs.filter((entry) => entry.additionalContext !== null);
    expect(injected).toHaveLength(2);
    expect(runs.map((entry) => entry.additionalContext !== null)).toEqual([true, false, false, false, false, true]);
    for (const entry of injected) {
      expect(entry.additionalContext).toContain('# Invoker execution routing');
    }
  });

  it('emits nothing for a task notification that opens a fresh session', () => {
    expect(taskNotification('session-fresh').additionalContext).toBeNull();
    expect(humanPrompt('session-fresh').additionalContext).not.toBeNull();
  });

  it('injects again for every later compaction', () => {
    expect(humanPrompt().additionalContext).not.toBeNull();
    compact();
    expect(humanPrompt().additionalContext).not.toBeNull();
    expect(humanPrompt().additionalContext).toBeNull();
    compact();
    expect(humanPrompt().additionalContext).not.toBeNull();
  });

  it('tracks each session separately', () => {
    expect(humanPrompt('session-one').additionalContext).not.toBeNull();
    expect(humanPrompt('session-one').additionalContext).toBeNull();
    expect(humanPrompt('session-two').additionalContext).not.toBeNull();
  });

  it('still injects when the transcript cannot be read', () => {
    const missing = path.join(root, 'nope.jsonl');
    expect(run({ session_id: 's', transcript_path: missing, prompt: 'hi' }).additionalContext).not.toBeNull();
    expect(run({ session_id: 's', transcript_path: missing, prompt: 'hi' }).additionalContext).not.toBeNull();
  });
});
