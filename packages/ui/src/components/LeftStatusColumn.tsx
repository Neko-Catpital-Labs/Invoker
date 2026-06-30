import type { QueueStatus } from '@invoker/contracts';
import type { TaskState, WorkflowMeta } from '../types.js';

interface LeftStatusColumnProps {
  workflows: Map<string, WorkflowMeta>;
  tasks: Map<string, TaskState>;
  queueStatus: QueueStatus | null;
  planName: string | null;
  plannerBusy: boolean;
  hasStarted: boolean;
  onTaskClick: (taskId: string) => void;
}

const ATTENTION_STATUS: Record<string, true> = {
  failed: true,
  blocked: true,
  needs_input: true,
  awaiting_approval: true,
  review_ready: true,
};

export function LeftStatusColumn({
  workflows,
  tasks,
  queueStatus,
  planName,
  plannerBusy,
  hasStarted,
  onTaskClick,
}: LeftStatusColumnProps): JSX.Element {
  const workflowCount = workflows.size;
  const taskCount = tasks.size;
  const attentionTasks = [...tasks.values()].filter((task) => ATTENTION_STATUS[task.status]);
  const runningTasks = queueStatus?.running.length
    ? queueStatus.running
    : [...tasks.values()]
      .filter((task) => task.status === 'running' || task.status === 'fixing_with_ai')
      .map((task) => ({ taskId: task.id, description: task.description }));

  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-r border-gray-800 bg-gray-950/80 p-3 text-sm text-gray-200">
      <section className="rounded-lg border border-gray-800 bg-gray-900/80 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Run</div>
        {taskCount === 0 && !planName ? (
          <p className="mt-3 text-sm text-gray-500">No runs yet</p>
        ) : (
          <div className="mt-3 space-y-2">
            <div className="truncate text-sm font-medium text-gray-100" title={planName ?? undefined}>
              {planName ?? `${workflowCount} workflow${workflowCount === 1 ? '' : 's'}`}
            </div>
            <div className="text-xs text-gray-400">
              {plannerBusy ? 'Planning…' : hasStarted ? 'Run started' : `${taskCount} task${taskCount === 1 ? '' : 's'} ready`}
            </div>
          </div>
        )}
      </section>

      <section className="mt-3 rounded-lg border border-gray-800 bg-gray-900/80 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Needs attention</div>
        {attentionTasks.length === 0 ? (
          <p className="mt-3 text-sm text-emerald-300">All clear</p>
        ) : (
          <div className="mt-3 space-y-2">
            {attentionTasks.slice(0, 6).map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => onTaskClick(task.id)}
                className="block w-full rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1.5 text-left hover:bg-amber-950/50"
              >
                <div className="truncate text-xs font-medium text-amber-100">{task.description || task.id}</div>
                <div className="mt-0.5 text-[11px] text-amber-300">{task.status.replaceAll('_', ' ')}</div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="mt-3 rounded-lg border border-gray-800 bg-gray-900/80 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Running task</div>
        {runningTasks.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No tasks running</p>
        ) : (
          <div className="mt-3 space-y-2">
            {runningTasks.slice(0, 6).map((task) => (
              <button
                key={task.taskId}
                type="button"
                onClick={() => onTaskClick(task.taskId)}
                className="block w-full rounded border border-blue-700/40 bg-blue-950/30 px-2 py-1.5 text-left hover:bg-blue-950/50"
              >
                <div className="truncate text-xs font-medium text-blue-100">{task.description || task.taskId}</div>
                <div className="mt-0.5 text-[11px] text-blue-300">Running</div>
              </button>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
