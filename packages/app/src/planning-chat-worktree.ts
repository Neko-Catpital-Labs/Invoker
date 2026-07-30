import { existsSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AcquiredWorktree, RepoPool } from '@invoker/execution-engine';

const execFileAsync = promisify(execFile);

const PLANNING_WORKTREE_INSTALL_TIMEOUT_MS = 120_000;

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

async function runBestEffortInstall(worktreePath: string): Promise<void> {
  try {
    await execFileAsync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: worktreePath,
      timeout: PLANNING_WORKTREE_INSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    console.warn(
      `[planning-chat-worktree] pnpm install --frozen-lockfile failed in ${worktreePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
): Promise<AcquiredWorktree> {
  const acquired = await pool.acquireWorktree(repoUrl, branch, baseCommit, sessionId);
  await runBestEffortInstall(acquired.worktreePath);
  writePlanningMcpConfig(acquired.worktreePath, sessionId);
  acquired.softRelease();
  return acquired;
}

export async function provisionPlanningWorktree(
  pool: PlanningRepoPool,
  binding: PlanningWorktreeBinding,
): Promise<ProvisionedPlanningWorktree> {
  const { repoUrl, baseBranch, sessionId } = binding;
  await pool.ensureCloneThroughRepoQueue(repoUrl);
  const baseCommit = await pool.resolveBaseCommit(repoUrl, baseBranch);
  const branch = resolvePlanningWorktreeBranch(sessionId);
  const acquired = await acquireProvisionAndSoftRelease(pool, repoUrl, branch, baseCommit, sessionId);
  return { worktreePath: acquired.worktreePath, baseCommit, branch };
}

export async function ensurePlanningWorktreeReady(
  pool: PlanningRepoPool,
  state: PlanningWorktreeState,
): Promise<{ worktreePath: string; recreated: boolean }> {
  const branch = resolvePlanningWorktreeBranch(state.sessionId);
  const expectedPath = pool.externalWorktreePath(state.repoUrl, branch);
  if (existsSync(expectedPath)) {
    return { worktreePath: expectedPath, recreated: false };
  }
  await pool.ensureCloneThroughRepoQueue(state.repoUrl);
  const acquired = await acquireProvisionAndSoftRelease(pool, state.repoUrl, branch, state.baseCommit, state.sessionId);
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
