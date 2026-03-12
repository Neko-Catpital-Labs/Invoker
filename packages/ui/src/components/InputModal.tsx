/**
 * InputModal — Modal for providing input to a task that needs it.
 *
 * Shows the task's input prompt and a text area for the response.
 */

import { useState } from 'react';
import type { TaskState } from '../types.js';

interface InputModalProps {
  task: TaskState;
  onSubmit: (taskId: string, input: string) => void;
  onClose: () => void;
}

export function InputModal({ task, onSubmit, onClose }: InputModalProps) {
  const [input, setInput] = useState('');

  const handleSubmit = () => {
    if (!input.trim()) return;
    onSubmit(task.id, input.trim());
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6 border border-gray-700">
        <h2 className="text-lg font-semibold text-gray-100 mb-2">
          Input Required
        </h2>

        <div className="mb-4">
          <p className="text-sm text-gray-300 mb-1">
            Task: <span className="font-mono text-gray-200">{task.id}</span>
          </p>
          {task.execution.inputPrompt && (
            <div className="bg-amber-900/30 border border-amber-700 rounded p-3 mt-2">
              <p className="text-sm text-amber-300">{task.execution.inputPrompt}</p>
            </div>
          )}
        </div>

        <div className="mb-4">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-500"
            rows={5}
            placeholder="Enter your response..."
            autoFocus
          />
          <p className="text-xs text-gray-500 mt-1">Ctrl+Enter to submit</p>
        </div>

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
