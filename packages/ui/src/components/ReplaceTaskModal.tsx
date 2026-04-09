/**
 * ReplaceTaskModal — Modal for replacing a broken/failed task with a new subgraph.
 *
 * Accepts YAML task definitions (same format as plan tasks) and calls
 * window.invoker.replaceTask() to splice the replacement into the graph.
 */

import { useState } from 'react';
import type { TaskState, TaskReplacementDef } from '../types.js';

interface ReplaceTaskModalProps {
  task: TaskState;
  onSubmit: (taskId: string, replacements: TaskReplacementDef[]) => void;
  onClose: () => void;
}

function parseYamlTasks(yaml: string): TaskReplacementDef[] {
  const tasks: TaskReplacementDef[] = [];
  let current: Partial<TaskReplacementDef> | null = null;

  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('- id:')) {
      if (current?.id) tasks.push(current as TaskReplacementDef);
      current = { id: line.slice('- id:'.length).trim() };
    } else if (current && line.startsWith('description:')) {
      current.description = line.slice('description:'.length).trim();
    } else if (current && line.startsWith('command:')) {
      current.command = line.slice('command:'.length).trim();
    } else if (current && line.startsWith('prompt:')) {
      current.prompt = line.slice('prompt:'.length).trim();
    } else if (current && line.startsWith('executorType:')) {
      current.executorType = line.slice('executorType:'.length).trim();
    } else if (current && line.startsWith('dependencies:')) {
      const depsStr = line.slice('dependencies:'.length).trim();
      if (depsStr.startsWith('[') && depsStr.endsWith(']')) {
        current.dependencies = depsStr
          .slice(1, -1)
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean);
      }
    }
  }
  if (current?.id) tasks.push(current as TaskReplacementDef);

  return tasks;
}

export function ReplaceTaskModal({ task, onSubmit, onClose }: ReplaceTaskModalProps) {
  const [yaml, setYaml] = useState(
    `- id: ${task.id}-fix\n  description: Fix for ${task.id}\n  command: echo "fix"`,
  );
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    setError(null);
    try {
      const tasks = parseYamlTasks(yaml);
      if (tasks.length === 0) {
        setError('No tasks defined. Each task must start with "- id: <name>".');
        return;
      }
      for (const t of tasks) {
        if (!t.description) {
          setError(`Task "${t.id}" is missing a description.`);
          return;
        }
      }
      onSubmit(task.id, tasks);
      onClose();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg p-6 border border-gray-700">
        <h2 className="text-lg font-semibold text-gray-100 mb-2">
          Replace Task
        </h2>

        <div className="mb-4">
          <p className="text-sm text-gray-300 mb-1">
            Replacing: <span className="font-mono text-gray-200">{task.id}</span>
          </p>
          <p className="text-xs text-gray-500">
            Define replacement tasks in YAML format. Root tasks (no internal deps) will
            inherit the original task&apos;s upstream dependencies.
          </p>
        </div>

        <div className="mb-4">
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-gray-900 border border-gray-600 rounded p-3 text-sm text-gray-100 font-mono placeholder-gray-500 focus:outline-none focus:border-gray-500"
            rows={10}
            placeholder={`- id: fix-step1\n  description: First fix step\n  command: echo "step 1"\n- id: fix-step2\n  description: Second fix step\n  command: echo "step 2"\n  dependencies: [fix-step1]`}
            autoFocus
          />
          <p className="text-xs text-gray-500 mt-1">Ctrl+Enter to submit</p>
        </div>

        {error && (
          <div className="mb-4 bg-red-900/30 border border-red-700 rounded p-3">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium transition-colors"
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}
