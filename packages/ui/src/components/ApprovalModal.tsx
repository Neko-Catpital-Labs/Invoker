/**
 * ApprovalModal — Modal for approving or rejecting a task.
 *
 * Shows task summary and approve/reject buttons.
 * Reject optionally collects a reason.
 */

import { useState } from 'react';
import type { TaskState } from '../types.js';

interface ApprovalModalProps {
  task: TaskState;
  onApprove: (taskId: string) => void;
  onReject: (taskId: string, reason?: string) => void;
  onClose: () => void;
}

export function ApprovalModal({
  task,
  onApprove,
  onReject,
  onClose,
}: ApprovalModalProps) {
  const [reason, setReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);

  const handleApprove = () => {
    onApprove(task.id);
    onClose();
  };

  const handleReject = () => {
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    onReject(task.id, reason || undefined);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6 border border-gray-700">
        <h2 className="text-lg font-semibold text-gray-100 mb-2">
          Manual Approval Required
        </h2>

        <div className="mb-4">
          <p className="text-sm text-gray-300 mb-1">
            Task: <span className="font-mono text-gray-200">{task.id}</span>
          </p>
          <p className="text-sm text-gray-400">{task.description}</p>
        </div>

        {task.config.summary && (
          <div className="mb-4 bg-gray-700/50 rounded p-3">
            <h3 className="text-sm font-medium text-gray-300 mb-1">Summary</h3>
            <p className="text-xs text-gray-400 whitespace-pre-wrap">
              {task.config.summary}
            </p>
          </div>
        )}

        {showRejectInput && (
          <div className="mb-4">
            <label className="block text-sm text-gray-300 mb-1">
              Rejection reason (optional)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-500"
              rows={3}
              placeholder="Why is this being rejected?"
              autoFocus
            />
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
            onClick={handleReject}
            className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded text-sm font-medium transition-colors"
          >
            {showRejectInput ? 'Confirm Reject' : 'Reject'}
          </button>
          {!showRejectInput && (
            <button
              onClick={handleApprove}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded text-sm font-medium transition-colors"
            >
              Approve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
