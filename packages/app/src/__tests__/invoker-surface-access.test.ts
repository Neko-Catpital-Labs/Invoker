import { describe, expect, it } from 'vitest';
import {
  checkInvokerSurfaceAccess,
  INVOKER_SURFACE_ACCESS_DENIAL_CODE,
} from '../invoker-surface-access.js';

describe('checkInvokerSurfaceAccess', () => {
  it('allows any execution agent when deployment configuration is unrestricted', () => {
    expect(checkInvokerSurfaceAccess({}, 'claude')).toEqual({ allowed: true });
  });

  it('allows an explicitly enabled Codex execution agent', () => {
    expect(checkInvokerSurfaceAccess({ enabledExecutionAgents: ['codex'] }, 'codex')).toEqual({ allowed: true });
  });

  it('uses the built-in default when the execution agent is omitted', () => {
    expect(checkInvokerSurfaceAccess({ enabledExecutionAgents: ['codex'] })).toEqual({ allowed: true });
  });

  it('uses the configured default when the execution-agent input is empty', () => {
    expect(checkInvokerSurfaceAccess({
      defaultExecutionAgent: 'omp',
      enabledExecutionAgents: ['omp'],
    }, '   ')).toEqual({ allowed: true });
  });

  it('treats an empty configured allowlist as unrestricted', () => {
    expect(checkInvokerSurfaceAccess({ enabledExecutionAgents: [] }, 'claude')).toEqual({ allowed: true });
  });

  it('denies a disabled Claude execution agent with a web-compatible error code', () => {
    expect(checkInvokerSurfaceAccess({ enabledExecutionAgents: ['codex'] }, 'claude')).toEqual({
      allowed: false,
      code: INVOKER_SURFACE_ACCESS_DENIAL_CODE,
      message: 'Execution agent "claude" is disabled by deployment configuration',
    });
    expect(INVOKER_SURFACE_ACCESS_DENIAL_CODE).toBe('execution_agent_disabled');
  });
});
