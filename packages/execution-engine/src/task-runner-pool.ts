/**
 * task-runner-pool.ts — execution-pool math, pool-member selection, SSH
 * resource leasing, executor selection, and executor-cache maintenance.
 *
 * These were methods on `TaskRunner`; they now live here as free functions
 * over a `TaskRunnerPoolHost` — a `Pick<TaskRunner, …>` mirroring the
 * `task-runner-phase-host.ts` convention. `TaskRunner` keeps one-line
 * delegates so external callers and the phase host see the same method
 * surface. The type-only import of `TaskRunner` avoids a runtime cycle with
 * `task-runner.js`; this module never value-imports it.
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';

import type { TaskState } from '@invoker/workflow-core';
import type { Executor, ExecutorHandle } from './executor.js';
import { ResourceLimitError } from './repo-pool.js';
import { traceExecution } from './exec-trace.js';
import { DockerExecutor } from './docker-executor.js';
import { WorktreeExecutor } from './worktree-executor.js';
import { MergeGateExecutor } from './merge-gate-executor.js';
import { SshExecutor } from './ssh-executor.js';
import type { MergeRunnerHost } from './merge-runner.js';
import { computePoolMemberCooldownMs } from './task-runner-launch-support.js';
import type { TaskRunner } from './task-runner.js';

// ── Types ────────────────────────────────────────────────

export type ExecutionPoolMember =
  | { type: 'ssh'; id: string; maxConcurrentTasks?: number }
  | { type: 'worktree'; id: string; maxConcurrentTasks?: number };

export type ExecutionPoolConfig = {
  members: ExecutionPoolMember[];
  selectionStrategy?: 'roundRobin' | 'leastLoaded';
  maxConcurrentTasksPerMember?: number;
};

export type ResolvedExecutionSelection = {
  executionAgent: string;
  executionModel?: string;
};

export type SelectedExecutor = {
  executor: Executor;
  resolvedExecution: ResolvedExecutionSelection;
  selectedPoolMemberId?: string;
};

export type PoolSelection = {
  poolId: string;
  member: ExecutionPoolMember;
  memberKey: string;
  selectionStrategy: 'roundRobin' | 'leastLoaded';
  resolvedExecution?: ResolvedExecutionSelection;
  leaseResourceKey?: string;
  leaseHolderId?: string;
};

export type PoolMemberHealth = {
  consecutiveFailures: number;
  downUntil: number;
  cooldownMs: number;
  lastError?: string;
  lastEvictedAt: number;
};

export type RemoteTargetDisplay = {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  managedWorkspaces?: boolean;
  remoteInvokerHome?: string;
  use_api_key?: boolean;
  secretsFile?: string;
  remoteHeartbeatIntervalSeconds?: number;
  maxConcurrentTasks?: number;
};

// ── Host surface ─────────────────────────────────────────

/**
 * Subset of `TaskRunner` the pool functions touch: runner state plus the
 * collaborators outside this module. Sibling pool functions call each other
 * directly (module-local); `host` is only for reaching `TaskRunner`.
 */
export type TaskRunnerPoolHost = Pick<
  TaskRunner,
  | 'persistence'
  | 'logger'
  | 'pendingPoolSelections'
  | 'activeExecutions'
  | 'poolRoundRobinCursor'
  | 'poolMemberHealth'
  | 'sshExecutorCache'
  | 'runnerInstanceId'
  | 'getRemoteTargets'
  | 'getExecutionPools'
  | 'resolveExecutionAgent'
  | 'resolveExecutionModel'
  | 'executorRegistry'
  | 'dockerConfig'
  | 'executionAgentRegistry'
  | 'maxWorktreesPerRepo'
>;

// ── Pool math ────────────────────────────────────────────

export function poolMemberKey(member: ExecutionPoolMember): string {
  return `${member.type}:${member.id}`;
}

function poolMemberLoad(host: TaskRunnerPoolHost, poolId: string, memberKey: string): number {
  let load = 0;
  for (const selection of host.pendingPoolSelections.values()) {
    if (selection.poolId === poolId && selection.memberKey === memberKey) load += 1;
  }
  for (const entry of host.activeExecutions.values()) {
    if (entry.poolId === poolId && entry.poolMemberKey === memberKey) load += 1;
  }
  return load;
}

function poolMemberLimit(pool: ExecutionPoolConfig, member: ExecutionPoolMember): number | undefined {
  return member.maxConcurrentTasks ?? pool.maxConcurrentTasksPerMember;
}

function poolMemberHasCapacity(host: TaskRunnerPoolHost, poolId: string, pool: ExecutionPoolConfig, member: ExecutionPoolMember): boolean {
  const limit = poolMemberLimit(pool, member);
  return limit === undefined || poolMemberLoad(host, poolId, poolMemberKey(member)) < limit;
}

function isPoolMemberDown(host: TaskRunnerPoolHost, memberKey: string, now: number = Date.now()): boolean {
  const health = host.poolMemberHealth.get(memberKey);
  return health !== undefined && health.downUntil > now;
}

export function recordPoolMemberTransportFailure(
  host: TaskRunnerPoolHost,
  memberKey: string,
  error: unknown,
): PoolMemberHealth {
  const now = Date.now();
  const consecutiveFailures = (host.poolMemberHealth.get(memberKey)?.consecutiveFailures ?? 0) + 1;
  const cooldownMs = computePoolMemberCooldownMs(consecutiveFailures);
  const health: PoolMemberHealth = {
    consecutiveFailures,
    cooldownMs,
    downUntil: now + cooldownMs,
    lastError: error instanceof Error ? error.message : String(error),
    lastEvictedAt: now,
  };
  host.poolMemberHealth.set(memberKey, health);
  return health;
}

export function recordPoolMemberStartSuccess(host: TaskRunnerPoolHost, memberKey: string): boolean {
  return host.poolMemberHealth.delete(memberKey);
}

export function getPoolMemberHealthSnapshot(
  host: TaskRunnerPoolHost,
  now: number = Date.now(),
): Array<{
  memberKey: string;
  consecutiveFailures: number;
  downUntil: number;
  downForMs: number;
  lastError?: string;
}> {
  const snapshot: Array<{
    memberKey: string;
    consecutiveFailures: number;
    downUntil: number;
    downForMs: number;
    lastError?: string;
  }> = [];
  for (const [memberKey, health] of host.poolMemberHealth) {
    if (health.downUntil <= now) continue;
    snapshot.push({
      memberKey,
      consecutiveFailures: health.consecutiveFailures,
      downUntil: health.downUntil,
      downForMs: health.downUntil - now,
      lastError: health.lastError,
    });
  }
  return snapshot;
}

// ── Pool-member selection ────────────────────────────────

export function selectPoolMember(
  host: TaskRunnerPoolHost,
  poolId: string,
  pool: ExecutionPoolConfig,
  excludedMemberKeys: Set<string> = new Set(),
): ExecutionPoolMember | undefined {
  if (pool.members.length === 0) return undefined;

  if (pool.selectionStrategy === 'roundRobin') {
    const cursor = host.poolRoundRobinCursor.get(poolId) ?? 0;
    for (let offset = 0; offset < pool.members.length; offset += 1) {
      const index = (cursor + offset) % pool.members.length;
      const member = pool.members[index];
      if (excludedMemberKeys.has(poolMemberKey(member))) continue;
      if (isPoolMemberDown(host, poolMemberKey(member))) continue;
      if (!poolMemberHasCapacity(host, poolId, pool, member)) continue;
      host.poolRoundRobinCursor.set(poolId, (index + 1) % pool.members.length);
      return member;
    }
    return undefined;
  }

  const scored = pool.members
    .filter((member) => !excludedMemberKeys.has(poolMemberKey(member)))
    .filter((member) => !isPoolMemberDown(host, poolMemberKey(member)))
    .map((member, index) => {
      const memberKey = poolMemberKey(member);
      const load = poolMemberLoad(host, poolId, memberKey);
      const limit = poolMemberLimit(pool, member);
      return {
        member,
        index,
        load,
        hasCapacity: limit === undefined || load < limit,
      };
    });
  const candidates = scored.filter((entry) => entry.hasCapacity);
  candidates.sort((a, b) => a.load - b.load || a.index - b.index);
  return candidates[0]?.member;
}

function poolCapacitySnapshot(
  host: TaskRunnerPoolHost,
  poolId: string,
  pool: ExecutionPoolConfig,
  excludedMemberKeys: Set<string>,
): Array<{
  memberId: string;
  memberType: string;
  load: number;
  limit: number | undefined;
  excluded: boolean;
  down: boolean;
  downForMs?: number;
}> {
  const now = Date.now();
  return pool.members.map((member) => {
    const memberKey = poolMemberKey(member);
    const health = host.poolMemberHealth.get(memberKey);
    const down = health !== undefined && health.downUntil > now;
    return {
      memberId: member.id,
      memberType: member.type,
      load: poolMemberLoad(host, poolId, memberKey),
      limit: poolMemberLimit(pool, member),
      excluded: excludedMemberKeys.has(memberKey),
      down,
      downForMs: down ? health!.downUntil - now : undefined,
    };
  });
}

function poolCapacityError(
  host: TaskRunnerPoolHost,
  task: Pick<TaskState, 'id' | 'config'>,
  poolId: string,
  pool: ExecutionPoolConfig,
  excludedMemberKeys: Set<string>,
): Error {
  const snapshot = poolCapacitySnapshot(host, poolId, pool, excludedMemberKeys);
  const requirementAgent = host.resolveExecutionAgent(task);
  const requirementModel = host.resolveExecutionModel(task);
  const requirementLabel = requirementModel ? `${requirementAgent}/${requirementModel}` : requirementAgent;
  const reasonSuffix = snapshot
    .map((member) => {
      const reasons = [
        member.excluded ? 'excluded' : undefined,
        member.down ? `down ${Math.ceil((member.downForMs ?? 0) / 1000)}s` : undefined,
        member.limit !== undefined && member.load >= member.limit ? `capacity ${member.load}/${member.limit}` : undefined,
      ].filter((reason): reason is string => Boolean(reason));
      return `${member.memberType}:${member.memberId}${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`;
    })
    .join('; ');
  const message = `Execution pool "${poolId}" has no member capacity available for ${requirementLabel}${reasonSuffix ? `: ${reasonSuffix}` : ''}`;
  const resourceLimit = new ResourceLimitError(message);
  host.persistence.logEvent?.(task.id, 'task.executor.deferred', {
    reason: 'execution-pool-capacity',
    poolId,
    excludedMemberKeys: [...excludedMemberKeys],
    requirement: {
      executionAgent: requirementAgent,
      executionModel: requirementModel,
    },
    members: snapshot,
  });
  host.logger.info(`[TaskRunner] deferring task: ${message}`, {
    poolId,
    excludedMemberKeys: [...excludedMemberKeys],
    requirement: {
      executionAgent: requirementAgent,
      executionModel: requirementModel,
    },
    members: snapshot,
  });
  return new Error(message, { cause: resourceLimit });
}

// ── SSH selection leases ─────────────────────────────────

function sshResourceKey(target: RemoteTargetDisplay): string {
  return `ssh:${target.user}@${target.host}:${target.port ?? 22}`;
}

function leaseHolderId(host: TaskRunnerPoolHost, taskId: string, attemptId: string): string {
  return `${host.runnerInstanceId}:${process.pid}:${taskId}:${attemptId}`;
}

export function acquirePoolSelectionLease(host: TaskRunnerPoolHost, task: TaskState, attemptId: string, selection: PoolSelection | undefined): boolean {
  if (!selection || selection.member.type !== 'ssh') return true;
  const target = host.getRemoteTargets()[selection.member.id];
  if (!target) return true;
  const resourceKey = sshResourceKey(target);
  const holderId = leaseHolderId(host, task.id, attemptId);
  const acquired = host.persistence.claimExecutionResourceLease?.({
    resourceKey,
    resourceType: 'ssh',
    holderId,
    taskId: task.id,
    poolId: selection.poolId,
    poolMemberId: selection.member.id,
    metadata: {
      runnerInstanceId: host.runnerInstanceId,
      pid: process.pid,
    },
  }) ?? true;
  if (!acquired) {
    host.persistence.logEvent?.(task.id, 'task.executor.deferred', {
      reason: 'ssh-resource-lease-held',
      poolId: selection.poolId,
      poolMemberId: selection.member.id,
      resourceKey,
    });
    return false;
  }
  selection.leaseResourceKey = resourceKey;
  selection.leaseHolderId = holderId;
  return true;
}

export function renewPoolSelectionLease(host: TaskRunnerPoolHost, selection: PoolSelection | undefined): void {
  if (!selection?.leaseResourceKey || !selection.leaseHolderId) return;
  host.persistence.renewExecutionResourceLease?.(selection.leaseResourceKey, selection.leaseHolderId);
}

export function releasePoolSelectionLease(host: TaskRunnerPoolHost, selection: PoolSelection | undefined): void {
  if (!selection?.leaseResourceKey || !selection.leaseHolderId) return;
  host.persistence.releaseExecutionResourceLease?.(selection.leaseResourceKey, selection.leaseHolderId);
  selection.leaseResourceKey = undefined;
  selection.leaseHolderId = undefined;
}

// ── Executor-selection logging ───────────────────────────

export function logExecutorSelected(
  host: TaskRunnerPoolHost,
  task: TaskState,
  executor: Executor,
  handle: ExecutorHandle,
  attemptId: string,
  poolSelection: PoolSelection | undefined,
): void {
  const payload: Record<string, unknown> = {
    runnerKind: executor.type,
    reason: executorSelectionReason(task, executor, poolSelection),
    attemptId,
    workspacePath: handle.workspacePath,
    branch: handle.branch ?? undefined,
  };

  if (executor.type === 'ssh') {
    const targetId = selectedRemoteTargetId(host, task, poolSelection);
    const target = targetId ? host.getRemoteTargets()[targetId] : undefined;
    if (targetId) payload.poolMemberId = targetId;
    if (target) {
      payload.remoteHost = target.host;
      payload.remoteUser = target.user;
      payload.port = target.port;
    }
  }

  host.persistence.logEvent?.(task.id, 'task.executor.selected', payload);
}

function executorSelectionReason(
  task: TaskState,
  executor: Executor,
  poolSelection: PoolSelection | undefined,
): Record<string, unknown> {
  if (executor.type === 'ssh') {
    if (poolSelection) {
      return {
        type: 'poolId',
        poolId: poolSelection.poolId,
        selectionStrategy: poolSelection.selectionStrategy,
        poolMemberId: poolSelection.member.id,
      };
    }
    if ((task.config as { poolMemberId?: string }).poolMemberId) {
      return { type: 'explicitPoolMemberId' };
    }
    if (task.config.poolId) {
      return { type: 'poolId', poolId: task.config.poolId };
    }
  }

  if (executor.type === 'worktree') {
    if (task.config.runnerKind === 'ssh' && task.config.poolId) {
      return { type: 'sshPoolFallbackToWorktree', poolId: task.config.poolId };
    }
    if (task.config.runnerKind === 'worktree') {
      return { type: 'configuredWorktree' };
    }
    return { type: 'defaultWorktree' };
  }

  if (executor.type === 'docker') {
    return { type: 'dockerImage' };
  }

  return { type: 'configuredRunnerKind', runnerKind: executor.type };
}

export function selectedRemoteTargetId(host: TaskRunnerPoolHost, task: TaskState, poolSelection: PoolSelection | undefined): string | undefined {
  if (poolSelection?.member.type === 'ssh') return poolSelection.member.id;
  return (task.config as { poolMemberId?: string }).poolMemberId
    ?? (task.config.poolId && host.getRemoteTargets()[task.config.poolId] ? task.config.poolId : undefined);
}

// ── Executor selection ───────────────────────────────────

export function takeResolvedExecutionSelection(host: TaskRunnerPoolHost, taskId: string): ResolvedExecutionSelection | undefined {
  const selection = host.pendingPoolSelections.get(taskId);
  const resolvedExecution = selection?.resolvedExecution;
  if (selection) {
    selection.resolvedExecution = undefined;
  }
  return resolvedExecution;
}

/**
 * Reclaim any in-memory execution slot this task still holds from a prior
 * attempt whose executor was never reaped — a superseded/recreated launch
 * whose kill hook no-oped or whose orphaned executor never fired `onComplete`.
 * Left in `activeExecutions`, that stale entry counts against member capacity
 * forever ({@link poolMemberLoad}), so every member can read full while nothing
 * runs. Mirrors the `pendingPoolSelections` self-heal in `selectExecutor`; the
 * current attempt is never touched. Best-effort kills the orphan so freeing the
 * slot cannot over-subscribe the member.
 */
function reclaimSupersededExecutionSlots(host: TaskRunnerPoolHost, task: TaskState): void {
  const liveAttemptId = task.execution.selectedAttemptId;
  if (liveAttemptId === undefined) return;
  for (const [attemptId, entry] of host.activeExecutions) {
    if (entry.taskId !== task.id || attemptId === liveAttemptId) continue;
    host.activeExecutions.delete(attemptId);
    host.logger?.warn?.(
      `[TaskRunner] reclaimed superseded execution slot task=${task.id} staleAttempt=${attemptId} ` +
        `member=${entry.poolMemberKey ?? 'n/a'}; a prior attempt's executor was never reaped`,
      { taskId: task.id, staleAttempt: attemptId, member: entry.poolMemberKey, module: 'task-runner' },
    );
    if (entry.leaseResourceKey && entry.leaseHolderId) {
      host.persistence.releaseExecutionResourceLease?.(entry.leaseResourceKey, entry.leaseHolderId);
    }
    const onKillError = (err: unknown) =>
      host.logger?.warn?.(
        `[TaskRunner] best-effort kill of superseded execution failed task=${task.id} attempt=${attemptId}`,
        { err, module: 'task-runner' },
      );
    try {
      void Promise.resolve(entry.executor.kill(entry.handle)).catch(onKillError);
    } catch (err) {
      onKillError(err);
    }
  }
}

export function selectExecutor(
  host: TaskRunnerPoolHost & MergeRunnerHost,
  task: TaskState,
  excludedPoolMemberKeys: Set<string> = new Set(),
): SelectedExecutor {
  let effectiveType = task.config.isMergeNode
    ? 'merge'
    : task.config.runnerKind;
  let selectedPoolMemberId: string | undefined;
  const explicitPoolMemberId = (task.config as { poolMemberId?: string }).poolMemberId;
  let resolvedExecution: ResolvedExecutionSelection = {
    executionAgent: host.resolveExecutionAgent(task),
    executionModel: host.resolveExecutionModel(task),
  };
  host.pendingPoolSelections.delete(task.id);
  reclaimSupersededExecutionSlots(host, task);

  if (task.config.poolId && explicitPoolMemberId) {
    const pool = host.getExecutionPools()[task.config.poolId];
    const member = pool?.members.find((candidate) => candidate.type === 'ssh' && candidate.id === explicitPoolMemberId);
    if (pool && member) {
      if (
        excludedPoolMemberKeys.has(poolMemberKey(member))
        || !poolMemberHasCapacity(host, task.config.poolId, pool, member)
      ) {
        throw poolCapacityError(host, task, task.config.poolId, pool, excludedPoolMemberKeys);
      }
      effectiveType = member.type;
      selectedPoolMemberId = member.id;
      host.pendingPoolSelections.set(task.id, {
        poolId: task.config.poolId,
        member,
        memberKey: poolMemberKey(member),
        selectionStrategy: pool.selectionStrategy ?? 'roundRobin',
        resolvedExecution,
      });
    }
  } else if (task.config.poolId) {
    const pool = host.getExecutionPools()[task.config.poolId];
    const member = pool ? selectPoolMember(host, task.config.poolId, pool, excludedPoolMemberKeys) : undefined;
    if (member) {
      effectiveType = member.type;
      selectedPoolMemberId = member.type === 'ssh' ? member.id : undefined;
      host.pendingPoolSelections.set(task.id, {
        poolId: task.config.poolId,
        member,
        memberKey: poolMemberKey(member),
        selectionStrategy: pool.selectionStrategy ?? 'roundRobin',
        resolvedExecution,
      });
    } else if (pool) {
      throw poolCapacityError(host, task, task.config.poolId, pool, excludedPoolMemberKeys);
    }
  }
  if (
    effectiveType === 'ssh'
    && task.config.poolId
    && !selectedPoolMemberId
    && !explicitPoolMemberId
    && !host.getRemoteTargets()[task.config.poolId]
  ) {
    effectiveType = 'worktree';
  }

  if (effectiveType) {
    const registered = host.executorRegistry.get(effectiveType);
    if (registered && (effectiveType !== 'merge' || registered.type === 'merge')) {
      traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=${effectiveType} → ${registered.type}`);
      return { executor: registered, resolvedExecution, selectedPoolMemberId };
    }

    if (effectiveType === 'docker') {
      const docker = new DockerExecutor({
        imageName: task.config.dockerImage || host.dockerConfig.imageName,
        secretsFile: host.dockerConfig.secretsFile,
        agentRegistry: host.executionAgentRegistry,
      });
      host.executorRegistry.register(`docker:${task.id}`, docker);
      traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=docker → docker (per-task)`);
      return { executor: docker, resolvedExecution, selectedPoolMemberId };
    }

    if (effectiveType === 'worktree') {
      const invokerHome = resolve(homedir(), '.invoker');
      const worktree = new WorktreeExecutor({
        worktreeBaseDir: resolve(invokerHome, 'worktrees'),
        cacheDir: resolve(invokerHome, 'repos'),
        maxWorktrees: host.maxWorktreesPerRepo,
        agentRegistry: host.executionAgentRegistry,
      });
      host.executorRegistry.register('worktree', worktree);
      traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=worktree → worktree (lazy registered)`);
      return { executor: worktree, resolvedExecution, selectedPoolMemberId };
    }

    if (effectiveType === 'merge') {
      const merge = new MergeGateExecutor(host);
      host.executorRegistry.register?.('merge', merge);
      traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=merge → merge (lazy registered)`);
      return { executor: merge, resolvedExecution, selectedPoolMemberId };
    }

    if (effectiveType === 'ssh') {
      const remoteTargets = host.getRemoteTargets();
      const targetId =
        selectedPoolMemberId
        ?? (task.config as { poolMemberId?: string }).poolMemberId
        ?? (task.config.poolId && remoteTargets[task.config.poolId] ? task.config.poolId : undefined);
      if (!targetId) {
        throw new Error(`Task ${task.id} has runnerKind=ssh but no poolMemberId`);
      }

      const target = remoteTargets[targetId];
      if (!target) {
        throw new Error(
          `Task ${task.id} references poolMemberId="${targetId}" but no matching ` +
          `entry exists in remoteTargets config. Available: [${Object.keys(remoteTargets).join(', ')}]`,
        );
      }

      const configFingerprint = JSON.stringify({
        host: target.host,
        user: target.user,
        sshKeyPath: target.sshKeyPath,
        port: target.port,
        managedWorkspaces: target.managedWorkspaces,
        remoteInvokerHome: target.remoteInvokerHome,
        use_api_key: target.use_api_key === true,
        secretsFile: target.secretsFile ?? host.dockerConfig.secretsFile,
        remoteHeartbeatIntervalSeconds: target.remoteHeartbeatIntervalSeconds,
      });
      const cacheKey = `${targetId}|${configFingerprint}`;

      const cached = host.sshExecutorCache.get(cacheKey);
      if (cached) {
        traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=ssh remoteTarget=${targetId} → ssh (cached)`);
        return { executor: cached, resolvedExecution, selectedPoolMemberId: targetId };
      }

      for (const key of host.sshExecutorCache.keys()) {
        if (key.startsWith(`${targetId}|`)) {
          host.sshExecutorCache.delete(key);
        }
      }

      const ssh = new SshExecutor({
        host: target.host,
        user: target.user,
        sshKeyPath: target.sshKeyPath,
        port: target.port,
        agentRegistry: host.executionAgentRegistry,
        managedWorkspaces: target.managedWorkspaces,
        useApiKey: target.use_api_key,
        secretsFile: target.secretsFile ?? host.dockerConfig.secretsFile,
        remoteHeartbeatIntervalSeconds: target.remoteHeartbeatIntervalSeconds,
      });
      host.executorRegistry.register(`ssh:${targetId}`, ssh);
      host.sshExecutorCache.set(cacheKey, ssh);
      traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=ssh remoteTarget=${targetId} → ssh (lazy registered)`);
      return { executor: ssh, resolvedExecution, selectedPoolMemberId: targetId };
    }
  }

  const executor = host.executorRegistry.getDefault();
  traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=(default) → ${executor.type}`);
  return { executor, resolvedExecution, selectedPoolMemberId };
}

// ── Executor-cache maintenance ───────────────────────────

export async function clearSshExecutorCache(host: TaskRunnerPoolHost): Promise<void> {
  const destroyPromises = Array.from(host.sshExecutorCache.values()).map(
    (executor) => executor.destroyAll().catch(() => {}),
  );
  await Promise.all(destroyPromises);
  host.sshExecutorCache.clear();
}
