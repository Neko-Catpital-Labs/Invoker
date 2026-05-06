import { describe, it, expect } from 'vitest';
import { composeRuntimeServices } from '../index.js';
import type { RuntimeServiceDeps, RuntimeServices } from '../index.js';
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

describe('composeRuntimeServices', () => {
  it('returns a RuntimeServices object with all ports', () => {
    const deps = stubDeps();
    const services: RuntimeServices = composeRuntimeServices(deps);

    expect(services.workspaceProbe).toBe(deps.workspaceProbe);
    expect(services.containerProbe).toBe(deps.containerProbe);
    expect(services.sessionProbe).toBe(deps.sessionProbe);
    expect(services.terminalLauncher).toBe(deps.terminalLauncher);
  });

  it('returns a frozen object', () => {
    const services = composeRuntimeServices(stubDeps());
    expect(Object.isFrozen(services)).toBe(true);
  });
});
