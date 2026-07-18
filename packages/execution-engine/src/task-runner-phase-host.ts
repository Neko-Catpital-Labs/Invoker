/**
 * Host surface shared by the task-runner execution phases.
 *
 * Each phase module (prepare / dispatch / finalize) takes a
 * `TaskRunnerPhaseHost` — a subset of `TaskRunner`'s capabilities — as its
 * first parameter. Defining it as a `Pick<TaskRunner, …>` keeps the phase
 * signatures locked to the runner's real method shapes (no drift) while the
 * type-only import avoids a runtime cycle with `task-runner.ts`.
 */

import type { TaskRunner } from './task-runner.js';

export type TaskRunnerPhaseHost = Pick<
  TaskRunner,
  // Shared collaborators
  | 'orchestrator'
  | 'persistence'
  | 'callbacks'
  | 'logger'
  | 'defaultBranch'
  // Runner state touched across phases
  | 'freshBaseCommits'
  | 'pendingPoolSelections'
  | 'activeExecutions'
  | 'getExecutionPools'
  | 'getDefaultExecutionAgent'
  | 'getDefaultExecutionModel'
  // Prepare-phase helpers
  | 'buildUpstreamContext'
  | 'collectUpstreamBranches'
  | 'buildAlternatives'
  | 'resolveExternalDependencyTask'
  | 'shouldUseFreshWorkspace'
  | 'determineActionType'
  | 'resolveExecutionAgent'
  | 'resolveExecutionModel'
  // Dispatch-phase helpers
  | 'selectExecutor'
  | 'takeResolvedExecutionSelection'
  | 'acquirePoolSelectionLease'
  | 'renewPoolSelectionLease'
  | 'releasePoolSelectionLease'
  | 'logExecutorSelected'
  | 'selectedRemoteTargetId'
  | 'poolMemberKey'
  | 'recordPoolMemberTransportFailure'
  | 'recordPoolMemberStartSuccess'
  // Shared lifecycle helpers
  | 'isLaunchStale'
  | 'executeNewlyStartedTasks'
  | 'cleanupPerTaskDockerExecutor'
  | 'runSerializedCompletion'
>;
