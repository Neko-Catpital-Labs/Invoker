/**
 * Regression tests for the headless → runtime-service bridge.
 *
 * Verifies that `composeHeadlessStartup` correctly routes through
 * `composeRuntimeServices` from `@invoker/runtime-service`, producing
 * a frozen `RuntimeServices` facade with owner-delegation parity.
 *
 * Upstream: wf-1778055155540-3/wire-headless-to-runtime-service (ce3006a6)
 */

import { describe, it, expect } from 'vitest';
import {
  composeHeadlessStartup,
  composeRuntimeServices,
  type RuntimeServiceDeps,
  type RuntimeServices,
} from '@invoker/runtime-service';

// ── Stub factories ───────────────────────────────────────────

/** Minimal deps matching the adapter shape used in headless.ts. */
function stubDeps(): RuntimeServiceDeps {
  return {
    workspaceProbe: { probeWorkspace: async () => ({}) },
    containerProbe: { probeContainer: async () => ({}) },
    sessionProbe: { probeSession: async () => ({}) },
    terminalLauncher: {
      launchTerminal: async () => ({ result: 'attached' }) as any,
    },
  };
}

// ── Bridge wiring correctness ────────────────────────────────

describe('headless → runtime-service bridge', () => {
  describe('adapter identity pass-through', () => {
    it('workspaceProbe adapter is the same object after composition', () => {
      const deps = stubDeps();
      const services = composeHeadlessStartup(deps);
      expect(services.workspaceProbe).toBe(deps.workspaceProbe);
    });

    it('containerProbe adapter is the same object after composition', () => {
      const deps = stubDeps();
      const services = composeHeadlessStartup(deps);
      expect(services.containerProbe).toBe(deps.containerProbe);
    });

    it('sessionProbe adapter is the same object after composition', () => {
      const deps = stubDeps();
      const services = composeHeadlessStartup(deps);
      expect(services.sessionProbe).toBe(deps.sessionProbe);
    });

    it('terminalLauncher adapter is the same object after composition', () => {
      const deps = stubDeps();
      const services = composeHeadlessStartup(deps);
      expect(services.terminalLauncher).toBe(deps.terminalLauncher);
    });
  });

  describe('facade immutability', () => {
    it('composed object is frozen', () => {
      const services = composeHeadlessStartup(stubDeps());
      expect(Object.isFrozen(services)).toBe(true);
    });

    it('assigning to a property throws', () => {
      const services = composeHeadlessStartup(stubDeps());
      expect(() => {
        (services as unknown as Record<string, unknown>).workspaceProbe = {};
      }).toThrow();
    });

    it('deleting a property throws', () => {
      const services = composeHeadlessStartup(stubDeps());
      expect(() => {
        delete (services as unknown as Record<string, unknown>).workspaceProbe;
      }).toThrow();
    });

    it('adding a new property throws', () => {
      const services = composeHeadlessStartup(stubDeps());
      expect(() => {
        (services as unknown as Record<string, unknown>).extra = true;
      }).toThrow();
    });
  });

  describe('facade shape', () => {
    it('exposes exactly the four expected keys', () => {
      const services = composeHeadlessStartup(stubDeps());
      expect(Object.keys(services).sort()).toEqual([
        'containerProbe',
        'sessionProbe',
        'terminalLauncher',
        'workspaceProbe',
      ]);
    });

    it('satisfies the RuntimeServices type contract', () => {
      const services: RuntimeServices = composeHeadlessStartup(stubDeps());
      expect(services.workspaceProbe.probeWorkspace).toBeTypeOf('function');
      expect(services.containerProbe.probeContainer).toBeTypeOf('function');
      expect(services.sessionProbe.probeSession).toBeTypeOf('function');
      expect(services.terminalLauncher.launchTerminal).toBeTypeOf('function');
    });
  });

  describe('owner-delegation parity with composeRuntimeServices', () => {
    it('produces an equivalent facade to composeRuntimeServices', () => {
      const deps = stubDeps();
      const headless = composeHeadlessStartup(deps);
      const main = composeRuntimeServices(deps);
      // Same adapter references wired through both paths
      expect(headless.workspaceProbe).toBe(main.workspaceProbe);
      expect(headless.containerProbe).toBe(main.containerProbe);
      expect(headless.sessionProbe).toBe(main.sessionProbe);
      expect(headless.terminalLauncher).toBe(main.terminalLauncher);
    });

    it('both paths produce frozen facades', () => {
      const deps = stubDeps();
      expect(Object.isFrozen(composeHeadlessStartup(deps))).toBe(true);
      expect(Object.isFrozen(composeRuntimeServices(deps))).toBe(true);
    });

    it('both paths expose the same keys', () => {
      const deps = stubDeps();
      const headlessKeys = Object.keys(composeHeadlessStartup(deps)).sort();
      const mainKeys = Object.keys(composeRuntimeServices(deps)).sort();
      expect(headlessKeys).toEqual(mainKeys);
    });
  });

  describe('deterministic behavior', () => {
    it('independent calls produce distinct facade objects', () => {
      const s1 = composeHeadlessStartup(stubDeps());
      const s2 = composeHeadlessStartup(stubDeps());
      expect(s1).not.toBe(s2);
    });

    it('same deps produce facades with identical adapter references', () => {
      const deps = stubDeps();
      const s1 = composeHeadlessStartup(deps);
      const s2 = composeHeadlessStartup(deps);
      expect(s1.workspaceProbe).toBe(s2.workspaceProbe);
      expect(s1.containerProbe).toBe(s2.containerProbe);
      expect(s1.sessionProbe).toBe(s2.sessionProbe);
      expect(s1.terminalLauncher).toBe(s2.terminalLauncher);
    });

    it('different deps produce facades with different adapter references', () => {
      const s1 = composeHeadlessStartup(stubDeps());
      const s2 = composeHeadlessStartup(stubDeps());
      expect(s1.workspaceProbe).not.toBe(s2.workspaceProbe);
      expect(s1.containerProbe).not.toBe(s2.containerProbe);
    });
  });

  describe('adapter method delegation', () => {
    it('probeWorkspace delegates through the composed facade', async () => {
      const expected = { workspacePath: '/headless/workspace' };
      const deps = stubDeps();
      deps.workspaceProbe.probeWorkspace = async () => expected;
      const services = composeHeadlessStartup(deps);
      const result = await services.workspaceProbe.probeWorkspace('task-h1');
      expect(result).toBe(expected);
    });

    it('probeContainer delegates through the composed facade', async () => {
      const expected = { containerId: 'ctr-headless' };
      const deps = stubDeps();
      deps.containerProbe.probeContainer = async () => expected;
      const services = composeHeadlessStartup(deps);
      const result = await services.containerProbe.probeContainer('task-h1');
      expect(result).toBe(expected);
    });

    it('probeSession delegates through the composed facade', async () => {
      const expected = { agentName: 'headless-agent', sessionId: 's-h1' };
      const deps = stubDeps();
      deps.sessionProbe.probeSession = async () => expected;
      const services = composeHeadlessStartup(deps);
      const result = await services.sessionProbe.probeSession('task-h1');
      expect(result).toBe(expected);
    });

    it('launchTerminal delegates through the composed facade', async () => {
      const expected = { result: 'attached' } as any;
      const deps = stubDeps();
      deps.terminalLauncher.launchTerminal = async () => expected;
      const services = composeHeadlessStartup(deps);
      const result = await services.terminalLauncher.launchTerminal({
        taskId: 'task-h1',
        workspacePath: '/tmp/headless-ws',
      });
      expect(result).toBe(expected);
    });
  });
});
