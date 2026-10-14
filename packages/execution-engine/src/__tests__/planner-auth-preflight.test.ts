import { describe, expect, it, vi } from 'vitest';

import {
  PLANNER_AUTH_PREFLIGHT_TIMEOUT_MS,
  buildPlannerAuthPreflightArgs,
  defaultPlannerAuthPreflightRunner,
  interpretClaudeAuthStatusOutput,
  interpretCodexLoginStatus,
  interpretCursorAuthStatus,
  resolvePlannerAuthPreflightExecutable,
  resolvePlannerAuthPreflightHarness,
  runPlannerAuthPreflight,
  throwIfPlannerAuthPreflightUnauthenticated,
  type PlannerAuthPreflightCommandRunner,
} from '../planner-auth-preflight.js';

describe('resolvePlannerAuthPreflightHarness', () => {
  it('maps known tools and leaves omp unsupported', () => {
    expect(resolvePlannerAuthPreflightHarness('claude')).toBe('claude');
    expect(resolvePlannerAuthPreflightHarness('omp+claude')).toBe('claude');
    expect(resolvePlannerAuthPreflightHarness('codex')).toBe('codex');
    expect(resolvePlannerAuthPreflightHarness('cursor+codex')).toBe('cursor');
    expect(resolvePlannerAuthPreflightHarness('omp')).toBe('unsupported');
    expect(resolvePlannerAuthPreflightHarness(undefined)).toBe('unsupported');
  });
});

describe('interpretClaudeAuthStatusOutput', () => {
  it('reads loggedIn from structured JSON', () => {
    expect(interpretClaudeAuthStatusOutput('{"loggedIn":true,"authMethod":"oauth"}')).toBe('authenticated');
    expect(interpretClaudeAuthStatusOutput('prefix\n{"loggedIn":false}\n')).toBe('unauthenticated');
  });

  it('returns unknown for malformed or incomplete JSON', () => {
    expect(interpretClaudeAuthStatusOutput('not json')).toBe('unknown');
    expect(interpretClaudeAuthStatusOutput('{"loggedIn":"yes"}')).toBe('unknown');
    expect(interpretClaudeAuthStatusOutput('{')).toBe('unknown');
  });
});

describe('interpretCodexLoginStatus', () => {
  it('treats auth failure text as unauthenticated even when exit is nonzero', () => {
    expect(interpretCodexLoginStatus({
      exitCode: 1,
      output: 'Not logged in\n',
      timedOut: false,
    })).toBe('unauthenticated');
  });

  it('treats exit 0 without auth failure as authenticated', () => {
    expect(interpretCodexLoginStatus({
      exitCode: 0,
      output: 'Logged in as user@example.com\n',
      timedOut: false,
    })).toBe('authenticated');
  });

  it('does not treat unrelated nonzero exits as auth failures', () => {
    expect(interpretCodexLoginStatus({
      exitCode: 2,
      output: 'fatal: unexpected internal error\n',
      timedOut: false,
    })).toBe('unknown');
  });

  it('returns unknown on timeout', () => {
    expect(interpretCodexLoginStatus({
      exitCode: null,
      output: '',
      timedOut: true,
    })).toBe('unknown');
  });
});

describe('interpretCursorAuthStatus', () => {
  it('classifies auth failure and limbo output as unauthenticated', () => {
    expect(interpretCursorAuthStatus({
      exitCode: 1,
      output: 'Authentication required. Please run cursor agent login\n',
      timedOut: false,
    })).toBe('unauthenticated');
    expect(interpretCursorAuthStatus({
      exitCode: null,
      output: 'Login successful!\nLogged in (unable to fetch user details)\n',
      timedOut: true,
    })).toBe('unauthenticated');
  });

  it('treats clean exit 0 as authenticated', () => {
    expect(interpretCursorAuthStatus({
      exitCode: 0,
      output: 'Logged in as user@example.com\n',
      timedOut: false,
    })).toBe('authenticated');
  });

  it('returns unknown on timeout without auth evidence', () => {
    expect(interpretCursorAuthStatus({
      exitCode: null,
      output: 'Checking authentication status...\n',
      timedOut: true,
    })).toBe('unknown');
  });

  it('returns unknown for nonzero exit without auth markers', () => {
    expect(interpretCursorAuthStatus({
      exitCode: 2,
      output: 'unknown option --foo\n',
      timedOut: false,
    })).toBe('unknown');
  });
});

describe('runPlannerAuthPreflight', () => {
  it('returns unsupported for omp without running a command', async () => {
    const runner = vi.fn<PlannerAuthPreflightCommandRunner>();
    const result = await runPlannerAuthPreflight({
      tool: 'omp',
      plannerCommand: 'omp',
      runner,
    });
    expect(result).toEqual({ status: 'unsupported', harness: 'omp' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns unknown when the preflight executable is missing', async () => {
    const result = await runPlannerAuthPreflight({
      tool: 'claude',
      plannerCommand: 'claude-binary-that-does-not-exist-xyz',
    });
    expect(result.status).toBe('unknown');
    expect(result.harness).toBe('claude');
    expect(result.detail).toMatch(/not found/i);
  });

  it('returns unknown on spawn errors without claiming unauthenticated', async () => {
    const result = await runPlannerAuthPreflight({
      tool: 'codex',
      plannerCommand: '/usr/bin/true',
      runner: async () => ({
        exitCode: null,
        output: '',
        timedOut: false,
        spawnError: 'ENOENT',
      }),
    });
    expect(result.status).toBe('unknown');
    expect(result.detail).toContain('ENOENT');
  });

  it('classifies claude authenticated and unauthenticated via runner output', async () => {
    const authed = await runPlannerAuthPreflight({
      tool: 'claude',
      plannerCommand: '/usr/bin/true',
      runner: async () => ({
        exitCode: 0,
        output: JSON.stringify({ loggedIn: true }),
        timedOut: false,
      }),
    });
    expect(authed.status).toBe('authenticated');

    const unauthed = await runPlannerAuthPreflight({
      tool: 'claude',
      plannerCommand: '/usr/bin/true',
      runner: async () => ({
        exitCode: 1,
        output: JSON.stringify({ loggedIn: false }),
        timedOut: false,
      }),
    });
    expect(unauthed.status).toBe('unauthenticated');
  });

  it('runs cursor-agent status args and maps timeout+limbo to unauthenticated', async () => {
    const runner = vi.fn<PlannerAuthPreflightCommandRunner>(async () => ({
      exitCode: null,
      output: 'unable to fetch user details',
      timedOut: true,
    }));
    const result = await runPlannerAuthPreflight({
      tool: 'cursor',
      plannerCommand: 'cursor',
      timeoutMs: 25,
      runner,
      env: { ...process.env, HOME: '/tmp' },
    });
    expect(result.status).toBe('unauthenticated');
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      args: buildPlannerAuthPreflightArgs('cursor'),
      timeoutMs: 25,
    }));
  });

  it('uses cursor-agent when the planner command is the wrapper', () => {
    const resolved = resolvePlannerAuthPreflightExecutable({
      harness: 'cursor',
      plannerCommand: 'cursor',
      env: { ...process.env, HOME: process.env.HOME },
    });
    if (resolved) {
      expect(resolved).toMatch(/cursor-agent/);
    }
  });
});

describe('throwIfPlannerAuthPreflightUnauthenticated', () => {
  it('throws only for unauthenticated', () => {
    expect(() => throwIfPlannerAuthPreflightUnauthenticated({
      status: 'authenticated',
      harness: 'claude',
    }, 'claude')).not.toThrow();
    expect(() => throwIfPlannerAuthPreflightUnauthenticated({
      status: 'unknown',
      harness: 'claude',
    }, 'claude')).not.toThrow();
    expect(() => throwIfPlannerAuthPreflightUnauthenticated({
      status: 'unsupported',
      harness: 'omp',
    }, 'omp')).not.toThrow();
    expect(() => throwIfPlannerAuthPreflightUnauthenticated({
      status: 'unauthenticated',
      harness: 'codex',
    }, 'codex')).toThrow(/Authentication required.*codex login/i);
  });
});

describe('PLANNER_AUTH_PREFLIGHT_TIMEOUT_MS', () => {
  it('exposes a positive default timeout', () => {
    expect(PLANNER_AUTH_PREFLIGHT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('defaultPlannerAuthPreflightRunner', () => {
  it('times out and terminates a hung subprocess', async () => {
    const result = await defaultPlannerAuthPreflightRunner({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: process.env,
      timeoutMs: 80,
    });
    expect(result.timedOut).toBe(true);
  }, 10_000);
});
