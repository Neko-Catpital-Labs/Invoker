/**
 * ExperimentModal — Modal for selecting which experiment to use.
 */

import { useState } from 'react';
import type { TaskState } from '../types.js';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './primitives/index.js';

interface ExperimentModalProps {
  task: TaskState;
  onSelect: (taskId: string, experimentIds: string[]) => void;
  onClose: () => void;
}

export function ExperimentModal({
  task,
  onSelect,
  onClose,
}: ExperimentModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const results = task.execution.experimentResults ?? [];

  const toggleExperiment = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    if (selected.size === 0) return;
    onSelect(task.id, Array.from(selected));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Experiments</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Choose one or more experiment results to use for reconciliation.
        </p>

        {results.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No experiment results available yet.
          </p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {results.map((result) => (
              <button
                key={result.id}
                type="button"
                onClick={() => toggleExperiment(result.id)}
                className={`w-full text-left p-3 rounded border transition-colors ${
                  selected.has(result.id)
                    ? 'border-purple-500 bg-purple-900/30'
                    : 'border-border-strong bg-muted/50 hover:bg-muted'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-foreground">
                    {selected.has(result.id) ? '\u2611 ' : '\u2610 '}{result.id}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      result.status === 'completed'
                        ? 'bg-green-900/50 text-green-400'
                        : 'bg-red-900/50 text-red-400'
                    }`}
                  >
                    {result.status}
                  </span>
                </div>
                {result.summary && (
                  <p className="text-xs text-muted-foreground mt-1">{result.summary}</p>
                )}
                {result.exitCode !== undefined && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Exit code: {result.exitCode}
                  </p>
                )}
              </button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selected.size === 0}
            className="bg-purple-600 text-white hover:bg-purple-500"
            onClick={handleConfirm}
          >
            Confirm Selection ({selected.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
