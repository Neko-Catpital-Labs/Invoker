import { describe, expect, it } from 'vitest';

import {
  collectInvokerConfigDiagnostics,
  hasBlockingConfigDiagnostic,
  type ConfigDiagnostic,
} from '../config-diagnostics.js';

function errorPaths(config: unknown): string[] {
  return collectInvokerConfigDiagnostics(config)
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.path);
}

function warnings(config: unknown): ConfigDiagnostic[] {
  return collectInvokerConfigDiagnostics(config).filter((diagnostic) => diagnostic.severity === 'warning');
}

const sshTarget = { host: 'build-1', user: 'ci', sshKeyPath: '/home/ci/.ssh/id_ed25519' };

describe('collectInvokerConfigDiagnostics', () => {
  it('accepts an empty config', () => {
    expect(collectInvokerConfigDiagnostics({})).toEqual([]);
  });

  it('rejects a config that is not an object', () => {
    expect(hasBlockingConfigDiagnostic(collectInvokerConfigDiagnostics([]))).toBe(true);
  });

  describe('remoteTargets', () => {
    it('requires host, user, and sshKeyPath', () => {
      expect(errorPaths({ remoteTargets: { box: {} } })).toEqual([
        'remoteTargets.box.host',
        'remoteTargets.box.user',
        'remoteTargets.box.sshKeyPath',
      ]);
    });

    it('rejects a port outside the valid range', () => {
      expect(errorPaths({ remoteTargets: { box: { ...sshTarget, port: 70000 } } })).toEqual([
        'remoteTargets.box.port',
      ]);
    });

    it('rejects a non-positive maxConcurrentTasks instead of silently defaulting it', () => {
      expect(errorPaths({ remoteTargets: { box: { ...sshTarget, maxConcurrentTasks: 0 } } })).toEqual([
        'remoteTargets.box.maxConcurrentTasks',
      ]);
    });

    it('rejects a capacity supplied as a string', () => {
      expect(errorPaths({ remoteTargets: { box: { ...sshTarget, maxConcurrentTasks: '4' } } })).toEqual([
        'remoteTargets.box.maxConcurrentTasks',
      ]);
    });

    it('accepts a fully specified target', () => {
      expect(collectInvokerConfigDiagnostics({ remoteTargets: { box: { ...sshTarget, port: 22 } } })).toEqual([]);
    });
  });

  describe('executionPools', () => {
    it('rejects an empty member list', () => {
      expect(errorPaths({ executionPools: { fast: { members: [] } } })).toEqual(['executionPools.fast.members']);
    });

    it('rejects an unknown member type', () => {
      expect(errorPaths({ executionPools: { fast: { members: [{ type: 'vm', id: 'a' }] } } })).toEqual([
        'executionPools.fast.members[0].type',
      ]);
    });

    it('rejects an ssh member with no matching remote target', () => {
      expect(errorPaths({ executionPools: { fast: { members: [{ type: 'ssh', id: 'ghost' }] } } })).toEqual([
        'executionPools.fast.members[0].id',
      ]);
    });

    it('accepts an ssh member backed by a declared remote target', () => {
      expect(collectInvokerConfigDiagnostics({
        remoteTargets: { box: sshTarget },
        executionPools: { fast: { members: [{ type: 'ssh', id: 'box' }] } },
      })).toEqual([]);
    });

    it('rejects a member duplicated inside one pool', () => {
      expect(errorPaths({
        executionPools: { fast: { members: [{ type: 'worktree', id: 'local' }, { type: 'worktree', id: 'local' }] } },
      })).toEqual(['executionPools.fast.members[1]']);
    });

    it('warns when one member is shared across pools, because capacity is de-duplicated', () => {
      const shared = warnings({
        executionPools: {
          fast: { members: [{ type: 'worktree', id: 'local' }] },
          slow: { members: [{ type: 'worktree', id: 'local' }] },
        },
      });
      expect(shared).toHaveLength(1);
      expect(shared[0].message).toContain('multiple pools');
    });

    it('rejects an unknown selection strategy', () => {
      expect(errorPaths({
        executionPools: { fast: { members: [{ type: 'worktree', id: 'local' }], selectionStrategy: 'random' } },
      })).toEqual(['executionPools.fast.selectionStrategy']);
    });
  });

  describe('defaultPoolId', () => {
    it('rejects a default pool id when no pools are configured', () => {
      expect(errorPaths({ defaultPoolId: 'fast' })).toEqual(['defaultPoolId']);
    });

    it('rejects a default pool id that does not match a configured pool', () => {
      expect(errorPaths({
        executionPools: { fast: { members: [{ type: 'worktree', id: 'local' }] } },
        defaultPoolId: 'slow',
      })).toEqual(['defaultPoolId']);
    });

    it('accepts a default pool id that matches a configured pool', () => {
      expect(collectInvokerConfigDiagnostics({
        executionPools: { fast: { members: [{ type: 'worktree', id: 'local' }] } },
        defaultPoolId: 'fast',
      })).toEqual([]);
    });
  });

  describe('executorRoutingRules', () => {
    const pools = { fast: { members: [{ type: 'worktree', id: 'local' }] } };

    it('rejects an uncompilable regex at config time', () => {
      expect(errorPaths({
        executionPools: pools,
        executorRoutingRules: [{ regex: '([unclosed', poolId: 'fast' }],
      })).toEqual(['executorRoutingRules[0].regex']);
    });

    it('rejects a rule that defines neither pattern nor regex', () => {
      expect(errorPaths({ executionPools: pools, executorRoutingRules: [{ poolId: 'fast' }] })).toEqual([
        'executorRoutingRules[0]',
      ]);
    });

    it('rejects a rule pointing at an unknown pool', () => {
      expect(errorPaths({
        executionPools: pools,
        executorRoutingRules: [{ pattern: 'build', poolId: 'ghost' }],
      })).toEqual(['executorRoutingRules[0].poolId']);
    });

    it('rejects an unknown routing strategy', () => {
      expect(errorPaths({
        executionPools: pools,
        executorRoutingRules: [{ pattern: 'build', poolId: 'fast', strategy: 'prefer' }],
      })).toEqual(['executorRoutingRules[0].strategy']);
    });

    it('accepts a well-formed rule', () => {
      expect(collectInvokerConfigDiagnostics({
        executionPools: pools,
        executorRoutingRules: [{ regex: '^pnpm ', poolId: 'fast', strategy: 'route' }],
      })).toEqual([]);
    });
  });

  describe('heavyweightCommandRouting', () => {
    const pools = { fast: { members: [{ type: 'worktree', id: 'local' }] } };

    it('rejects a missing poolId', () => {
      expect(errorPaths({ executionPools: pools, heavyweightCommandRouting: { enabled: true } })).toEqual([
        'heavyweightCommandRouting.poolId',
      ]);
    });

    it('rejects a poolId that is not configured', () => {
      expect(errorPaths({ executionPools: pools, heavyweightCommandRouting: { poolId: 'ghost' } })).toEqual([
        'heavyweightCommandRouting.poolId',
      ]);
    });

    it('rejects an uncompilable matcher regex', () => {
      expect(errorPaths({
        executionPools: pools,
        heavyweightCommandRouting: { poolId: 'fast', matchers: [{ regex: '([unclosed' }] },
      })).toEqual(['heavyweightCommandRouting.matchers[0].regex']);
    });
  });

  it('rejects a non-positive maxConcurrency', () => {
    expect(errorPaths({ maxConcurrency: 0 })).toEqual(['maxConcurrency']);
  });

  it('reports every problem in one pass rather than stopping at the first', () => {
    const diagnostics = collectInvokerConfigDiagnostics({
      maxConcurrency: -1,
      remoteTargets: { box: { host: 'h' } },
      defaultPoolId: 'missing',
    });
    expect(diagnostics.filter((entry) => entry.severity === 'error').length).toBeGreaterThan(3);
  });
});
