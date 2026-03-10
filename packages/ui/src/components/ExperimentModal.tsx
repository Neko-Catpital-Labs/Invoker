/**
 * ExperimentModal — Modal for selecting which experiment to use.
 *
 * Shows experiment results and lets the user pick one.
 * Used for reconciliation tasks.
 */

import { useState } from 'react';
import type { TaskState } from '../types.js';

interface ExperimentModalProps {
  task: TaskState;
  onSelect: (taskId: string, experimentId: string) => void;
  onClose: () => void;
}

export function ExperimentModal({
  task,
  onSelect,
  onClose,
}: ExperimentModalProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const results = task.experimentResults ?? [];

  const handleConfirm = () => {
    if (!selected) return;
    onSelect(task.id, selected);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg p-6 border border-gray-700">
        <h2 className="text-lg font-semibold text-gray-100 mb-2">
          Select Experiment
        </h2>

        <p className="text-sm text-gray-400 mb-4">
          Choose which experiment result to use for reconciliation.
        </p>

        {results.length === 0 ? (
          <p className="text-sm text-gray-500 py-4">
            No experiment results available yet.
          </p>
        ) : (
          <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
            {results.map((result) => (
              <button
                key={result.id}
                onClick={() => setSelected(result.id)}
                className={`w-full text-left p-3 rounded border transition-colors ${
                  selected === result.id
                    ? 'border-purple-500 bg-purple-900/30'
                    : 'border-gray-600 bg-gray-700/50 hover:bg-gray-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-200">
                    {result.id}
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
                  <p className="text-xs text-gray-400 mt-1">{result.summary}</p>
                )}
                {result.exitCode !== undefined && (
                  <p className="text-xs text-gray-500 mt-1">
                    Exit code: {result.exitCode}
                  </p>
                )}
              </button>
            ))}
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
            onClick={handleConfirm}
            disabled={!selected}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
          >
            Confirm Selection
          </button>
        </div>
      </div>
    </div>
  );
}
