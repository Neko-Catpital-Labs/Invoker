/**
 * Headless E2E test: prove that after a codex fix runs,
 * the returned sessionId is the REAL codex thread ID (not the local UUID),
 * and that buildResumeArgs would produce a valid resume command.
 *
 * Uses a fake shell script that emits real codex JSONL format.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CodexSessionDriver } from '../codex-session-driver.js';
import { extractCodexSessionId } from '../codex-session.js';
import { spawnAgentFixViaRegistry } from '../conflict-resolver.js';
import type { ExecutionAgent, AgentCommandSpec } from '../agent.js';

const REAL_THREAD_ID = '019d-real-thread-id-from-codex-backend';

describe('codex session resume E2E', () => {
  let tmpDir: string;
  let fakeCodexPath: string;
  let origDbDir: string | undefined;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-e2e-'));
    fakeCodexPath = join(tmpDir, 'fake-codex.sh');

    // Create a fake codex that emits real JSONL format (codex-cli 0.117+)
    writeFileSync(fakeCodexPath, `#!/bin/bash
echo '{"type":"thread.started","thread_id":"${REAL_THREAD_ID}"}'
echo '{"type":"turn.started"}'
echo '{"type":"message.output_text.delta","delta":"I will fix the issue."}'
echo '{"type":"message.output_text.done","text":"I will fix the issue."}'
echo '{"type":"response.completed"}'
echo '{"type":"turn.completed"}'
exit 0
`);
    chmodSync(fakeCodexPath, 0o755);

    origDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = tmpDir;
  });

  afterAll(() => {
    if (origDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = origDbDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFakeAgent(): ExecutionAgent {
    return {
      name: 'codex',
      stdinMode: 'ignore',
      linuxTerminalTail: 'exec_bash',
      buildCommand(fullPrompt: string): AgentCommandSpec {
        return { cmd: fakeCodexPath, args: [], sessionId: randomUUID(), fullPrompt };
      },
      buildResumeArgs(sessionId: string) {
        return { cmd: 'codex', args: ['exec', 'resume', sessionId] };
      },
      buildFixCommand(prompt: string): AgentCommandSpec {
        const localUuid = randomUUID();
        return { cmd: fakeCodexPath, args: [], sessionId: localUuid };
      },
    };
  }

  it('spawnAgentFixViaRegistry returns real thread ID, not local UUID', async () => {
    const agent = makeFakeAgent();
    const driver = new CodexSessionDriver();

    const result = await spawnAgentFixViaRegistry('Fix the bug', tmpDir, agent, driver);

    // The session ID must be the real codex thread ID, not a random UUID
    expect(result.sessionId).toBe(REAL_THREAD_ID);
  });

  it('buildResumeArgs with extracted ID produces correct resume command', async () => {
    const agent = makeFakeAgent();
    const driver = new CodexSessionDriver();

    const result = await spawnAgentFixViaRegistry('Fix the bug', tmpDir, agent, driver);
    const resume = agent.buildResumeArgs!(result.sessionId);

    expect(resume.cmd).toBe('codex');
    expect(resume.args).toEqual(['exec', 'resume', REAL_THREAD_ID]);
  });

  it('extractCodexSessionId parses real fake-codex JSONL output', () => {
    const rawStdout = execSync(fakeCodexPath).toString();
    expect(extractCodexSessionId(rawStdout)).toBe(REAL_THREAD_ID);
  });

  it('CodexSessionDriver.extractSessionId works on raw JSONL', () => {
    const driver = new CodexSessionDriver();
    const rawStdout = execSync(fakeCodexPath).toString();
    expect(driver.extractSessionId(rawStdout)).toBe(REAL_THREAD_ID);
  });

  it('local UUID is NOT the same as the real thread ID', async () => {
    const agent = makeFakeAgent();
    const driver = new CodexSessionDriver();

    // Capture what buildFixCommand generates
    const spec = agent.buildFixCommand!('test');
    const localUuid = spec.sessionId;

    // The real thread ID must differ from the local UUID
    expect(localUuid).not.toBe(REAL_THREAD_ID);

    // But after going through spawnAgentFixViaRegistry, we get the real one
    const result = await spawnAgentFixViaRegistry('Fix the bug', tmpDir, agent, driver);
    expect(result.sessionId).toBe(REAL_THREAD_ID);
    expect(result.sessionId).not.toBe(localUuid);
  });

  it('simulates WorktreeExecutor close handler: driver.extractSessionId replaces entry.agentSessionId', () => {
    const driver = new CodexSessionDriver();
    const rawStdout = execSync(fakeCodexPath).toString();

    // Simulate the entry state before close handler runs
    const entry = {
      agentSessionId: randomUUID(), // local UUID assigned at spawn time
      rawStdout,
    };

    // This is exactly what the worktree-executor close handler does:
    // if (driver && entry.rawStdout) {
    //   const readable = driver.processOutput(entry.agentSessionId ?? '', entry.rawStdout);
    //   const realId = driver.extractSessionId?.(entry.rawStdout);
    //   if (realId) entry.agentSessionId = realId;
    // }
    const readable = driver.processOutput(entry.agentSessionId, entry.rawStdout);
    const realId = driver.extractSessionId?.(entry.rawStdout);
    if (realId) {
      entry.agentSessionId = realId;
    }

    expect(entry.agentSessionId).toBe(REAL_THREAD_ID);
    // processOutput should return some readable text (even if empty for this format)
    expect(typeof readable).toBe('string');
  });
});
