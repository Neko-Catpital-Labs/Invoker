/**
 * ReplaceTaskModal — Modal for replacing a broken/failed task with a new subgraph.
 */

import { useState } from 'react';
import type { TaskState, TaskReplacementDef } from '../types.js';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './primitives/index.js';

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
    } else if (current && line.startsWith('runnerKind:')) {
      current.runnerKind = line.slice('runnerKind:'.length).trim();
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Replace Task</DialogTitle>
        </DialogHeader>

        <div>
          <p className="text-sm text-muted-foreground mb-1">
            Replacing: <span className="font-mono text-foreground">{task.id}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Define replacement tasks in YAML format. Root tasks (no internal deps) will
            inherit the original task&apos;s upstream dependencies.
          </p>
        </div>

        <div>
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-background border border-border-strong rounded p-3 text-sm text-foreground font-mono placeholder:text-muted-foreground focus:outline-none focus:border-ring"
            rows={10}
            placeholder={`- id: fix-step1\n  description: First fix step\n  command: echo "step 1"\n- id: fix-step2\n  description: Second fix step\n  command: echo "step 2"\n  dependencies: [fix-step1]`}
            autoFocus
          />
          <p className="text-xs text-muted-foreground mt-1">Ctrl+Enter to submit</p>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded p-3">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit}>
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
