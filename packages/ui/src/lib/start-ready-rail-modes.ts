import type { StartReadyFreshBaseScope, StartReadyRequest, StartReadyResult } from '@invoker/contracts';
import type { TaskState } from '../types.js';

export type StartReadyRailModeId =
  | 'recreateFailed'
  | 'recreateFailedAndPending'
  | 'recreateFailedPendingAndRunning'
  | 'freshBaseFailed'
  | 'freshBaseFailedAndPending'
  | 'freshBaseFailedPendingAndRunning';

export type StartReadyRailMode = {
  id: StartReadyRailModeId;
  kind: 'recreate' | 'freshBase';
  testId: string;
  label: string;
  title: string;
  confirmLabel: string;
  request: StartReadyRequest;
  includesPending: boolean;
  includesRunning: boolean;
  freshBaseScope?: StartReadyFreshBaseScope;
};

export const START_READY_RAIL_MODES: readonly StartReadyRailMode[] = [
  {
    id: 'recreateFailed',
    kind: 'recreate',
    testId: 'rail-start-ready-recreate-failed',
    label: 'Start and recreate failed…',
    title: 'Start and recreate failed',
    confirmLabel: 'Start and recreate',
    request: { recreateFailed: true },
    includesPending: false,
    includesRunning: false,
  },
  {
    id: 'recreateFailedAndPending',
    kind: 'recreate',
    testId: 'rail-start-ready-recreate-failed-and-pending',
    label: 'Start and recreate failed and pending…',
    title: 'Start and recreate failed and pending',
    confirmLabel: 'Start and recreate',
    request: { recreateFailedAndPending: true },
    includesPending: true,
    includesRunning: false,
  },
  {
    id: 'recreateFailedPendingAndRunning',
    kind: 'recreate',
    testId: 'rail-start-ready-recreate-failed-pending-and-running',
    label: 'Start and recreate failed, pending, and running…',
    title: 'Start and recreate failed, pending, and running',
    confirmLabel: 'Start and recreate',
    request: { recreateFailedPendingAndRunning: true },
    includesPending: true,
    includesRunning: true,
  },
  {
    id: 'freshBaseFailed',
    kind: 'freshBase',
    testId: 'rail-start-ready-fresh-base-failed',
    label: 'Recreate failed from fresh base…',
    title: 'Start and recreate failed from fresh base',
    confirmLabel: 'Start and recreate from fresh base',
    request: { freshBaseScope: 'failed' },
    includesPending: false,
    includesRunning: false,
    freshBaseScope: 'failed',
  },
  {
    id: 'freshBaseFailedAndPending',
    kind: 'freshBase',
    testId: 'rail-start-ready-fresh-base-failed-and-pending',
    label: 'Recreate failed and pending from fresh base…',
    title: 'Start and recreate failed and pending from fresh base',
    confirmLabel: 'Start and recreate from fresh base',
    request: { freshBaseScope: 'failed-and-pending' },
    includesPending: true,
    includesRunning: false,
    freshBaseScope: 'failed-and-pending',
  },
  {
    id: 'freshBaseFailedPendingAndRunning',
    kind: 'freshBase',
    testId: 'rail-start-ready-fresh-base-failed-pending-and-running',
    label: 'Recreate failed, pending, and running from fresh base…',
    title: 'Start and recreate failed, pending, and running from fresh base',
    confirmLabel: 'Start and recreate from fresh base',
    request: { freshBaseScope: 'failed-pending-and-running' },
    includesPending: true,
    includesRunning: true,
    freshBaseScope: 'failed-pending-and-running',
  },
];

const START_READY_RAIL_MODE_BY_ID = new Map(
  START_READY_RAIL_MODES.map((mode) => [mode.id, mode]),
);

export function getStartReadyRailMode(id: StartReadyRailModeId): StartReadyRailMode {
  return START_READY_RAIL_MODE_BY_ID.get(id) ?? START_READY_RAIL_MODES[0];
}

export function startReadyRequestForMode(mode: StartReadyRailMode, dryRun = false): StartReadyRequest {
  return dryRun ? { dryRun: true, ...mode.request } : { ...mode.request };
}

export function isPendingOrQueuedStatus(status: TaskState['status']): boolean {
  return status === 'pending' || (status as string) === 'queued';
}

export function freshBaseModeHasVisibleTargets(
  mode: StartReadyRailMode,
  targetCounts: { failed: number; pending: number; running: number },
): boolean {
  if (mode.kind !== 'freshBase') return true;
  switch (mode.freshBaseScope) {
    case 'failed':
      return targetCounts.failed > 0;
    case 'failed-and-pending':
      return targetCounts.pending > 0;
    case 'failed-pending-and-running':
      return targetCounts.running > 0;
    default:
      return false;
  }
}

export function startReadyPreviewRows(mode: StartReadyRailMode, result: StartReadyResult): Array<[string, number]> {
  const rows: Array<[string, number]> = [
    ['Ready tasks', result.preview.readyTaskIds.length],
    ['Recoverable tasks', result.preview.recoverableTaskIds.length],
    ['Failed workflows', result.preview.failedWorkflowIds.length],
  ];

  if (mode.includesPending) {
    rows.push(
      ['Pending workflows', result.preview.pendingWorkflowIds.length],
      ['Pending tasks', result.preview.skipped.pendingTasks],
    );
  }
  if (mode.includesRunning) {
    rows.push(
      ['Running workflows', result.preview.runningWorkflowIds.length],
      ['Running tasks', result.preview.skipped.runningTasks],
    );
  }
  if (mode.kind === 'freshBase' && result.preview.freshBase) {
    rows.push(
      ['Fresh-base workflows', result.preview.freshBase.workflowIds.length],
      ['Fresh-base failed workflows', result.preview.freshBase.failedWorkflowIds.length],
    );
    if (mode.includesPending) {
      rows.push(['Fresh-base pending workflows', result.preview.freshBase.pendingWorkflowIds.length]);
    }
    if (mode.includesRunning) {
      rows.push(['Fresh-base running workflows', result.preview.freshBase.runningWorkflowIds.length]);
    }
  }

  rows.push(
    ['Awaiting approval', result.preview.skipped.awaitingApproval],
    ['Review ready', result.preview.skipped.reviewReady],
    ['Blocked', result.preview.skipped.blocked],
  );
  return rows;
}
