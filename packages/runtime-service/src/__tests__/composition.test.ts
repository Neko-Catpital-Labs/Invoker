import { describe, it, expect } from 'vitest';
import {
  composeRuntimeServices,
  type RuntimeServiceDeps,
  type RuntimeServices,
} from '../composition.js';
import { AttachmentResult } from '@invoker/runtime-domain';

function stubDeps(): RuntimeServiceDeps {
  return {
    workspaceProbe: { probeWorkspace: async () => ({}) },
    containerProbe: { probeContainer: async () => ({}) },
    sessionProbe: { probeSession: async () => ({}) },
    terminalLauncher: {
      launchTerminal: async () => ({ result: AttachmentResult.Attached }),
    },
  };
}

describe('composition shell', () => {
  describe('composeRuntimeServices', () => {
    it('passes through workspaceProbe unchanged', () => {
      const deps = stubDeps();
      const services = composeRuntimeServices(deps);
      expect(services.workspaceProbe).toBe(deps.workspaceProbe);
    });

    it('passes through containerProbe unchanged', () => {
      const deps = stubDeps();
      const services = composeRuntimeServices(deps);
      expect(services.containerProbe).toBe(deps.containerProbe);
    });

    it('passes through sessionProbe unchanged', () => {
      const deps = stubDeps();
      const services = composeRuntimeServices(deps);
      expect(services.sessionProbe).toBe(deps.sessionProbe);
    });

    it('passes through terminalLauncher unchanged', () => {
      const deps = stubDeps();
      const services = composeRuntimeServices(deps);
      expect(services.terminalLauncher).toBe(deps.terminalLauncher);
    });

    it('returns a frozen object that rejects mutation', () => {
      const services = composeRuntimeServices(stubDeps());
      expect(Object.isFrozen(services)).toBe(true);
      expect(() => {
        (services as unknown as Record<string, unknown>).workspaceProbe = {};
      }).toThrow();
    });

    it('exposes exactly the four expected keys', () => {
      const services = composeRuntimeServices(stubDeps());
      const keys = Object.keys(services).sort();
      expect(keys).toEqual([
        'containerProbe',
        'sessionProbe',
        'terminalLauncher',
        'workspaceProbe',
      ]);
    });

    it('satisfies the RuntimeServices type contract', () => {
      const services: RuntimeServices = composeRuntimeServices(stubDeps());
      expect(services.workspaceProbe.probeWorkspace).toBeTypeOf('function');
      expect(services.containerProbe.probeContainer).toBeTypeOf('function');
      expect(services.sessionProbe.probeSession).toBeTypeOf('function');
      expect(services.terminalLauncher.launchTerminal).toBeTypeOf('function');
    });

    it('produces independent instances per call', () => {
      const deps1 = stubDeps();
      const deps2 = stubDeps();
      const s1 = composeRuntimeServices(deps1);
      const s2 = composeRuntimeServices(deps2);
      expect(s1).not.toBe(s2);
      expect(s1.workspaceProbe).not.toBe(s2.workspaceProbe);
    });
  });
});
