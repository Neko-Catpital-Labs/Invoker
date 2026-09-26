import { describe, expect, it } from 'vitest';
import type { Logger } from '@invoker/contracts';

import { Orchestrator } from '../orchestrator.js';
import { InMemoryBus, InMemoryPersistence, makeResponse } from './helpers/cross-workflow-cascade-helpers.js';

type LogEntry = { level: string; msg: string; meta?: Record<string, unknown> };

function capturingLogger(entries: LogEntry[]): Logger {
  const record = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
    entries.push({ level, msg, meta });
  };
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return logger as unknown as Logger;
}

function failOneTask(error: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const orchestrator = new Orchestrator({
    persistence: new InMemoryPersistence(),
    messageBus: new InMemoryBus(),
    maxConcurrency: 8,
    resolveRepoDefaultBranch: () => 'master',
    logger: capturingLogger(entries),
  });
  orchestrator.loadPlan({
    name: 'failed-task-owner-log',
    onFinish: 'none',
    tasks: [{ id: 'filer', description: 'filer', command: 'x', runnerKind: 'worktree' }],
  });
  const task = orchestrator.getAllTasks().find((t) => t.id.endsWith('/filer'))!;
  orchestrator.startExecution();
  orchestrator.handleWorkerResponse(makeResponse({
    actionId: task.id,
    status: 'failed',
    outputs: { exitCode: 128, error },
  }));
  return entries;
}

describe('failed task owner log', () => {
  it('records the exit code, failure class, and error text of every failed task', () => {
    const entries = failOneTask('git branch --show-current failed (code 128): fatal: not a git repository: (null)');
    const failure = entries.find((e) => e.msg === '[orchestrator] finalizeFailedTask');
    expect(failure).toBeDefined();
    expect(failure!.level).toBe('warn');
    expect(failure!.meta).toMatchObject({ exitCode: 128 });
    expect(String(failure!.meta?.error)).toContain('fatal: not a git repository');
  });

  it('keeps the tail of a very long error', () => {
    const entries = failOneTask(`${'x'.repeat(10_000)}FINAL-LINE-OF-ERROR`);
    const failure = entries.find((e) => e.msg === '[orchestrator] finalizeFailedTask');
    const logged = String(failure?.meta?.error);
    expect(logged).toContain('FINAL-LINE-OF-ERROR');
    expect(logged.length).toBeLessThan(5_000);
  });
});
