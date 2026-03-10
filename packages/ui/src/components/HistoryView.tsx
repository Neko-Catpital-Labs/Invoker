import { useState, useEffect } from 'react';
import type { TaskState } from '../types.js';

type HistoryTask = TaskState & { workflowName: string };

/** Groups tasks by workflowName, preserving insertion order. */
export function groupByWorkflow(tasks: HistoryTask[]): Map<string, HistoryTask[]> {
  const map = new Map<string, HistoryTask[]>();
  for (const task of tasks) {
    const group = map.get(task.workflowName);
    if (group) {
      group.push(task);
    } else {
      map.set(task.workflowName, [task]);
    }
  }
  return map;
}

interface HistoryViewProps {
  onTaskClick: (task: TaskState) => void;
  selectedTaskId: string | null;
}

export function HistoryView({ onTaskClick, selectedTaskId }: HistoryViewProps) {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.invoker?.getAllCompletedTasks().then((t) => {
      setTasks(t);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Loading history...
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        No completed tasks
      </div>
    );
  }

  const grouped = groupByWorkflow(tasks);

  return (
    <div className="h-full overflow-y-auto p-4">
      {Array.from(grouped.entries()).map(([workflowName, workflowTasks]) => (
        <div key={workflowName} className="mb-6">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            {workflowName}
          </h3>
          <div className="space-y-1">
            {workflowTasks.map((task) => (
              <button
                key={task.id}
                onClick={() => onTaskClick(task)}
                className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                  selectedTaskId === task.id
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className="truncate mr-2">{task.description}</span>
                  <span className="text-xs text-gray-400 shrink-0">
                    {task.completedAt
                      ? new Date(task.completedAt).toLocaleDateString()
                      : ''}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
