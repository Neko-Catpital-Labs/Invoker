/**
 * InputModal — Modal for providing input to a task that needs it.
 *
 * Shows the task's input prompt and a text area for the response.
 */

import { useEffect, useState } from 'react';
import type { TaskState } from '../types.js';

interface InputModalProps {
  task: TaskState;
  onSubmit: (taskId: string, input: string) => void;
  onClose: () => void;
}

export function InputModal({ task, onSubmit, onClose }: InputModalProps) {
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [onClose]);

  const handleSubmit = () => {
    if (submitting) return;
    if (!input.trim()) return;
    setSubmitting(true);
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
      <div className="bg-secondary rounded-lg shadow-xl w-full max-w-md p-6 border border-border">
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Input Required
        </h2>

        <div className="mb-4">
          <p className="text-sm text-muted-foreground mb-1">
            Task: <span className="font-mono text-foreground">{task.id}</span>
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
            className="w-full bg-muted border border-border-strong rounded p-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
            rows={5}
            placeholder="Enter your response..."
            autoFocus
          />
          <p className="text-xs text-muted-foreground mt-1">Ctrl+Enter to submit</p>
        </div>

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || submitting}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-muted disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
