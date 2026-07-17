import type { TaskState, WorkerActionSummary, WorkerStatusEntry, WorkflowMeta } from '../types.js';
import {
  displayWorkerTaskId,
  formatWorkerValue,
  getActiveWorkerAction,
  getWorkerDisplayCopy,
  resolveWorkerActionTarget,
} from '../lib/worker-display.js';
import { WorkerDecisionsSection } from './WorkerDecisionsSection.js';

interface WorkerDetailsPanelProps {
  worker: WorkerStatusEntry | null;
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onTaskClick: (task: TaskState) => void;
}

function processClass(worker: WorkerStatusEntry): string {
  if (worker.lifecycle === 'running') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
  if (worker.lifecycle === 'exited') return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  return 'border-border-strong bg-muted/60 text-muted-foreground';
}

function activityClass(worker: WorkerStatusEntry): string {
  if (getActiveWorkerAction(worker)) return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  if (worker.lifecycle === 'running') return 'border-border-strong bg-muted/60 text-muted-foreground';
  if (worker.lifecycle === 'exited') return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  return 'border-border-strong bg-muted/60 text-muted-foreground';
}

function activityLabel(worker: WorkerStatusEntry): string {
  if (getActiveWorkerAction(worker)) return 'Active work';
  if (worker.lifecycle === 'running') return 'Idle';
  if (worker.lifecycle === 'exited') return 'Exited';
  return 'Stopped';
}

function idleExplanation(worker: WorkerStatusEntry): string {
  if (worker.lifecycle === 'running') return getWorkerDisplayCopy(worker.kind).idleText;
  if (worker.lifecycle === 'exited') return 'Process exited. Start it to create a fresh runtime.';
  return 'Process stopped. Start it to listen for work.';
}

function TargetLine({ action, tasks, workflows, onTaskClick }: {
  action: WorkerActionSummary;
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  onTaskClick: (task: TaskState) => void;
}) {
  const target = resolveWorkerActionTarget(action, tasks, workflows);
  const workflowSuffix = target.workflowName ? ` · ${target.workflowName}` : '';

  if (target.task) {
    return (
      <button
        type="button"
        className="mt-2 rounded border border-emerald-600/60 bg-emerald-900/40 px-2 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-800/60"
        onClick={() => onTaskClick(target.task!)}
      >
        Open task: {target.taskTitle}{workflowSuffix}
      </button>
    );
  }

  if (action.taskId) {
    return (
      <div className="mt-2 text-xs text-muted-foreground">
        Target task: {target.taskTitle}{workflowSuffix}
      </div>
    );
  }

  return (
    <div className="mt-2 text-xs text-muted-foreground">
      Target: {target.taskTitle}{workflowSuffix}
    </div>
  );
}

function ActionDetails({ title, action, tasks, workflows, onTaskClick }: {
  title: string;
  action: WorkerActionSummary;
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  onTaskClick: (task: TaskState) => void;
}) {
  const target = resolveWorkerActionTarget(action, tasks, workflows);

  return (
    <section className="rounded border border-border bg-card/60 p-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Task</dt>
        <dd className="text-foreground">{target.taskTitle}</dd>
        {target.workflowName ? (
          <>
            <dt className="text-muted-foreground">Workflow</dt>
            <dd className="text-foreground">{target.workflowName}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Action</dt>
        <dd className="text-foreground">{formatWorkerValue(action.actionType)}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="text-foreground">{formatWorkerValue(action.status)}</dd>
        {action.summary ? (
          <>
            <dt className="text-muted-foreground">Summary</dt>
            <dd className="text-foreground">{action.summary}</dd>
          </>
        ) : null}
      </dl>
      <TargetLine action={action} tasks={tasks} workflows={workflows} onTaskClick={onTaskClick} />
    </section>
  );
}

export function WorkerDetailsPanel({
  worker,
  tasks,
  workflows,
  collapsed,
  onToggleCollapsed,
  onTaskClick,
}: WorkerDetailsPanelProps) {
  if (collapsed) {
    return (
      <aside className="flex h-full w-full items-start justify-center border-l border-border bg-background pt-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Show details"
          data-sidebar-nav-item
          data-sidebar-nav-order="10"
          className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
        >
          Show details
        </button>
      </aside>
    );
  }

  const copy = worker ? getWorkerDisplayCopy(worker.kind) : null;
  const activeAction = worker ? getActiveWorkerAction(worker) : undefined;
  const latestAction = worker?.recentActions[0];

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 data-testid="worker-details-title" className="max-w-[270px] truncate text-sm font-medium text-foreground">
            {copy?.name ?? 'Worker details'}
          </h2>
          <div className="max-w-[270px] truncate text-[11px] text-muted-foreground">
            {worker ? `Kind: ${worker.kind}` : 'Select a worker to see details.'}
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Minimize inspector"
          data-sidebar-nav-item
          data-sidebar-nav-order="10"
          className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary"
        >
          Minimize
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-auto p-3 text-sm">
        {!worker ? (
          <div className="rounded border border-border bg-card/60 p-3 text-sm text-muted-foreground">
            Select a worker process to inspect its current work and last recorded action.
          </div>
        ) : (
          <>
            <section className="rounded border border-border bg-card/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-[11px] ${processClass(worker)}`}>
                  Process: {formatWorkerValue(worker.lifecycle)}
                </span>
                <span className={`rounded-full border px-2 py-0.5 text-[11px] ${activityClass(worker)}`}>
                  {activityLabel(worker)}
                </span>
              </div>
            </section>

            {activeAction ? (
              <ActionDetails
                title="Current work"
                action={activeAction}
                tasks={tasks}
                workflows={workflows}
                onTaskClick={onTaskClick}
              />
            ) : (
              <section className="rounded border border-border bg-card/60 p-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Current work</h3>
                <div className="mt-2 text-sm text-muted-foreground">{idleExplanation(worker)}</div>
              </section>
            )}

            {latestAction ? (
              <ActionDetails
                title="Last recorded action"
                action={latestAction}
                tasks={tasks}
                workflows={workflows}
                onTaskClick={onTaskClick}
              />
            ) : (
              <section className="rounded border border-border bg-card/60 p-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Last recorded action</h3>
                <div className="mt-2 text-sm text-muted-foreground">{copy?.noActionText}</div>
              </section>
            )}

            {worker.kind === 'autofix' && worker.recovery ? (
              <section className="rounded border border-border bg-card/60 p-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Autofix history</h3>
                <div className="mt-2 text-sm text-muted-foreground">
                  Scanned {worker.recovery.scans} · submitted {worker.recovery.submissions} · skipped {worker.recovery.skips}
                  {worker.recovery.lastSkipReason ? ` · last skip: ${worker.recovery.lastSkipReason}` : ''}
                  {worker.recovery.lastSkipTaskId ? ` on task ${displayWorkerTaskId(worker.recovery.lastSkipTaskId)}` : ''}
                </div>
              </section>
            ) : null}

            <WorkerDecisionsSection workerKind={worker.kind} />
          </>
        )}
      </div>
    </aside>
  );
}
