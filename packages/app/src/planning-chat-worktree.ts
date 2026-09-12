import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcquiredWorktree, RepoPool } from '@invoker/execution-engine';
import {
  preparePlanningWorktreeDependencies,
  type PlanningDependencyPreparationOptions,
} from './planning-chat-dependency-cache.js';

export type PlanningRepoPool = Pick<
  RepoPool,
  'ensureCloneThroughRepoQueue' | 'resolveBaseCommit' | 'acquireWorktree' | 'externalWorktreePath'
>;

export function resolvePlanningWorktreeBranch(sessionId: string): string {
  return `invoker/planning/${sessionId}`;
}

export interface PlanningWorktreeBinding {
  repoUrl: string;
  baseBranch: string;
  sessionId: string;
}

export interface ProvisionedPlanningWorktree {
  worktreePath: string;
  baseCommit: string;
  branch: string;
}

export interface PlanningWorktreeState {
  repoUrl: string;
  baseCommit: string;
  sessionId: string;
  worktreePath?: string;
}

export function planningMcpConfigPath(worktreePath: string): string {
  return join(worktreePath, '.mcp.json');
}

export function writePlanningMcpConfig(worktreePath: string, sessionId: string): void {
  try {
    writeFileSync(planningMcpConfigPath(worktreePath), JSON.stringify({
      mcpServers: {
        invoker: {
          type: 'stdio',
          command: 'invoker-cli',
          args: ['mcp'],
          env: { INVOKER_PLANNING_SESSION_ID: sessionId },
        },
      },
    }, null, 2), 'utf8');
  } catch (error) {
    console.warn(
      `[planning-chat-worktree] writePlanningMcpConfig failed in ${worktreePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function acquireProvisionAndSoftRelease(
  pool: Pick<PlanningRepoPool, 'acquireWorktree'>,
  repoUrl: string,
  branch: string,
  baseCommit: string,
  sessionId: string,
  dependencyOptions?: PlanningDependencyPreparationOptions,
): Promise<AcquiredWorktree> {
  const acquired = await pool.acquireWorktree(repoUrl, branch, baseCommit, sessionId);
  await preparePlanningWorktreeDependencies(acquired.worktreePath, dependencyOptions);
  writePlanningMcpConfig(acquired.worktreePath, sessionId);
  acquired.softRelease();
  return acquired;
}

export async function provisionPlanningWorktree(
  pool: PlanningRepoPool,
  binding: PlanningWorktreeBinding,
  dependencyOptions?: PlanningDependencyPreparationOptions,
): Promise<ProvisionedPlanningWorktree> {
  const { repoUrl, baseBranch, sessionId } = binding;
  await pool.ensureCloneThroughRepoQueue(repoUrl);
  const baseCommit = await pool.resolveBaseCommit(repoUrl, baseBranch);
  const branch = resolvePlanningWorktreeBranch(sessionId);
  const acquired = await acquireProvisionAndSoftRelease(pool, repoUrl, branch, baseCommit, sessionId, dependencyOptions);
  return { worktreePath: acquired.worktreePath, baseCommit, branch };
}

export async function ensurePlanningWorktreeReady(
  pool: PlanningRepoPool,
  state: PlanningWorktreeState,
  dependencyOptions?: PlanningDependencyPreparationOptions,
): Promise<{ worktreePath: string; recreated: boolean }> {
  const branch = resolvePlanningWorktreeBranch(state.sessionId);
  const expectedPath = pool.externalWorktreePath(state.repoUrl, branch);
  if (existsSync(expectedPath)) {
    return { worktreePath: expectedPath, recreated: false };
  }
  await pool.ensureCloneThroughRepoQueue(state.repoUrl);
  const acquired = await acquireProvisionAndSoftRelease(pool, state.repoUrl, branch, state.baseCommit, state.sessionId, dependencyOptions);
  return { worktreePath: acquired.worktreePath, recreated: true };
}

export async function releasePlanningWorktree(
  pool: Pick<PlanningRepoPool, 'acquireWorktree'>,
  state: { repoUrl: string; baseCommit: string; sessionId: string },
): Promise<void> {
  const branch = resolvePlanningWorktreeBranch(state.sessionId);
  const acquired = await pool.acquireWorktree(state.repoUrl, branch, state.baseCommit, state.sessionId);
  await acquired.release();
}
