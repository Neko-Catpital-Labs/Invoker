import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Orchestrator } from '../orchestrator.js';
import { CommandService } from '../command-service.js';
import { makeEnvelope } from '@invoker/contracts';

// ── Shared fixtures ────────────────────────────────────────────

function envelope<P>(payload: P) {
  return makeEnvelope<P>('test-cmd', 'headless', 'task', payload);
}

describe('restartTask deprecation shim', () => {
  // ── Orchestrator-level shim ──────────────────────────────────

  describe('Orchestrator.restartTask', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let recreateSpy: ReturnType<typeof vi.spyOn>;
    let retrySpy: ReturnType<typeof vi.spyOn>;
    let orch: Orchestrator;

    beforeEach(() => {
      // Build a minimally-valid orchestrator. Because we're
      // only asserting delegation we don't need plan loading;
      // we stub the target methods directly.
      orch = Object.create(Orchestrator.prototype) as Orchestrator;
      // The shim only calls `this.recreateTask`, so stubbing
      // that out and asserting the call is sufficient.
      recreateSpy = vi.spyOn(orch, 'recreateTask').mockImplementation(() => []);
      retrySpy = vi.spyOn(orch, 'retryTask').mockImplementation(() => []);
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    it('delegates restartTask to recreateTask (NOT retryTask)', () => {
      orch.restartTask('task-1');

      expect(recreateSpy).toHaveBeenCalledTimes(1);
      expect(recreateSpy).toHaveBeenCalledWith('task-1');
      expect(retrySpy).not.toHaveBeenCalled();
    });

    it('emits a deprecation warning on stderr', () => {
      orch.restartTask('task-1');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain('restartTask');
      expect(message).toContain('deprecated');
      expect(message).toContain('Routing to recreateTask');
      expect(message).toContain('retryTask');
      expect(message).toContain('recreateTask');
    });

    it('returns whatever recreateTask returns (passthrough)', () => {
      const sentinel = [{ id: 'task-1' } as never];
      recreateSpy.mockReturnValueOnce(sentinel);

      const result = orch.restartTask('task-1');

      expect(result).toBe(sentinel);
    });
  });

  // ── CommandService-level shim ────────────────────────────────

  describe('CommandService.restartTask', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let svc: CommandService;
    let orchestrator: {
      retryTask: ReturnType<typeof vi.fn>;
      recreateTask: ReturnType<typeof vi.fn>;
      getTask: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      orchestrator = {
        retryTask: vi.fn(() => []),
        recreateTask: vi.fn(() => []),
        // CommandService consults getTask() to scope the mutex
        // by workflow; returning undefined falls back to global.
        getTask: vi.fn(() => undefined),
      };
      // CommandService is a thin mutex-serialized wrapper; for
      // shim testing we just need the orchestrator delegate.
      svc = new CommandService(orchestrator as never);
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    it('delegates restartTask to orchestrator.recreateTask (NOT retryTask)', async () => {
      const result = await svc.restartTask(envelope({ taskId: 't-1' }));

      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.recreateTask).toHaveBeenCalledTimes(1);
      expect(orchestrator.recreateTask).toHaveBeenCalledWith('t-1');
      expect(orchestrator.retryTask).not.toHaveBeenCalled();
    });

    it('emits a deprecation warning', async () => {
      await svc.restartTask(envelope({ taskId: 't-1' }));

      expect(warnSpy).toHaveBeenCalled();
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain('restartTask');
      expect(message).toContain('deprecated');
      expect(message).toContain('Routing to recreateTask');
    });

    it('exposes explicit retryTask + recreateTask methods', async () => {
      // Sanity: the canonical verbs exist on the service
      // surface (so callers have somewhere to migrate to). If
      // either is missing, this test will fail at compile time.
      expect(typeof svc.retryTask).toBe('function');
      expect(typeof svc.recreateTask).toBe('function');

      await svc.retryTask(envelope({ taskId: 't-1' }));
      expect(orchestrator.retryTask).toHaveBeenCalledWith('t-1');

      await svc.recreateTask(envelope({ taskId: 't-1' }));
      expect(orchestrator.recreateTask).toHaveBeenCalledWith('t-1');
    });
  });

  // ── Lock-in: no production code calls .restartTask( ──────────

  describe('production lock-in: workflow-core/src/ has no .restartTask( call sites', () => {
    /**
     * Walk `packages/workflow-core/src/`, skipping `__tests__/`,
     * and assert that no production source file invokes
     * `.restartTask(`. The deprecated method DECLARATION still
     * exists in `orchestrator.ts` (and the shim body calls
     * `this.recreateTask`), so we explicitly allow:
     *   - the method declaration line (`restartTask(taskId: string): TaskState[] {`)
     *   - the deprecation warn message (`restartTask("...")`)
     *   - JSDoc comments (`* `restartTask` ...`)
     * We catch only actual `.restartTask(` invocations on a
     * receiver, which is what the chart's "Naming
     * inconsistency" section forbids going forward.
     */
    function walk(dir: string, files: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === '__tests__' || entry === 'node_modules') continue;
          walk(full, files);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
          files.push(full);
        }
      }
      return files;
    }

    it('no production .ts file under workflow-core/src/ calls .restartTask(', () => {
      const srcRoot = new URL('..', import.meta.url).pathname;
      const files = walk(srcRoot);
      expect(files.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Catch `.restartTask(` invocations on a receiver
          // (this/orchestrator/foo). Allow the declaration
          // (`  restartTask(`) and JSDoc references (`*` prefix
          // or backtick-quoted), and the warn message string
          // literal (which contains `restartTask("` not
          // `.restartTask(`).
          if (/\.\s*restartTask\s*\(/.test(line)) {
            offenders.push(`${relative(srcRoot, file)}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      expect(offenders, `Regression: production code still calls .restartTask(:\n${offenders.join('\n')}`).toEqual([]);
    });
  });
});
