/**
 * InputModal — Modal for providing input to a task that needs it.
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

interface InputModalProps {
  task: TaskState;
  onSubmit: (taskId: string, input: string) => void;
  onClose: () => void;
}

export function InputModal({ task, onSubmit, onClose }: InputModalProps) {
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Input Required</DialogTitle>
        </DialogHeader>

        <div>
          <p className="text-sm text-muted-foreground mb-1">
            Task: <span className="font-mono text-foreground">{task.id}</span>
          </p>
          {task.execution.inputPrompt && (
            <div className="bg-amber-900/30 border border-amber-700 rounded p-3 mt-2">
              <p className="text-sm text-amber-300">{task.execution.inputPrompt}</p>
            </div>
          )}
        </div>

        <div>
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

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!input.trim() || submitting}
            className="bg-amber-600 text-white hover:bg-amber-500"
            onClick={handleSubmit}
          >
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
