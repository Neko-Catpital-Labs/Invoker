/**
 * ApprovalModal — Modal for approving or rejecting a task.
 *
 * Shows task summary and approve/reject buttons.
 * Reject optionally collects a reason.
 */

import { useState, useEffect } from 'react';
import type { TaskState, ClaudeMessage } from '../types.js';

interface ApprovalModalProps {
  task: TaskState;
  onApprove: (taskId: string) => void;
  onReject: (taskId: string, reason?: string) => void;
  onClose: () => void;
  initialAction?: 'approve' | 'reject';
  onFinish?: string;
}

export function ApprovalModal({
  task,
  onApprove,
  onReject,
  onClose,
  initialAction = 'approve',
  onFinish,
}: ApprovalModalProps) {
  const extractSessionFromEvents = (
    events: Array<{ payload?: string }>,
  ): { sessionId?: string; agentName?: string } => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const raw = events[i]?.payload;
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const exec = parsed?.execution;
        if (exec?.agentSessionId) {
          return {
            sessionId: String(exec.agentSessionId),
            agentName: typeof exec.agentName === 'string' ? exec.agentName : undefined,
          };
        }
      } catch {
        // Ignore malformed event payloads
      }
    }
    return {};
  };

  const extractSessionIdFromError = (err?: string): string | undefined => {
    if (!err) return undefined;
    const m = err.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    return m?.[0];
  };

  const isFixApproval = Boolean(task.execution.pendingFixError);
  const isMergeNode = Boolean(task.config.isMergeNode);
  const fallbackSessionId = extractSessionIdFromError(task.execution.pendingFixError);
  const [eventSessionId, setEventSessionId] = useState<string | undefined>(undefined);
  const [eventAgentName, setEventAgentName] = useState<string | undefined>(undefined);
  const sessionId = task.execution.agentSessionId
    ?? task.execution.lastAgentSessionId
    ?? fallbackSessionId
    ?? eventSessionId;
  const effectiveAgentName = task.execution.agentName
    ?? task.execution.lastAgentName
    ?? eventAgentName;

  const agentLabel = effectiveAgentName
    ? effectiveAgentName.charAt(0).toUpperCase() + effectiveAgentName.slice(1)
    : 'Claude';

  const defaultReason = [
    sessionId && `${agentLabel} session: ${sessionId}`,
    isFixApproval && `Original error: ${task.execution.pendingFixError}`,
  ].filter(Boolean).join('\n');

  const [reason, setReason] = useState(defaultReason);
  const [reasonTouched, setReasonTouched] = useState(false);
  const [showRejectInput, setShowRejectInput] = useState(initialAction === 'reject');
  const [sessionMessages, setSessionMessages] = useState<ClaudeMessage[] | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState(false);

  useEffect(() => {
    if (task.execution.agentSessionId || task.execution.lastAgentSessionId || fallbackSessionId) return;
    let cancelled = false;
    window.invoker
      .getEvents(task.id)
      .then((events) => {
        if (cancelled) return;
        const recovered = extractSessionFromEvents(events as Array<{ payload?: string }>);
        if (recovered.sessionId) {
          setEventSessionId(recovered.sessionId);
        }
        if (recovered.agentName) {
          setEventAgentName(recovered.agentName);
        }
      })
      .catch(() => {
        // Best-effort fallback only
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.execution.agentSessionId, task.execution.lastAgentSessionId, fallbackSessionId]);

  useEffect(() => {
    if (!reasonTouched) {
      setReason(defaultReason);
    }
  }, [defaultReason, reasonTouched]);

  useEffect(() => {
    if (!sessionId) return;
    setSessionLoading(true);
    setSessionError(false);
    window.invoker
      .getAgentSession(sessionId, effectiveAgentName)
      .then((msgs) => {
        setSessionMessages(msgs);
        setSessionLoading(false);
      })
      .catch(() => {
        setSessionError(true);
        setSessionLoading(false);
      });
  }, [sessionId, effectiveAgentName]);

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

  const heading = isFixApproval
    ? 'Approve AI Fix'
    : isMergeNode
      ? onFinish === 'merge'
        ? 'Confirm Merge'
        : onFinish === 'pull_request'
          ? 'Confirm Pull Request'
          : 'Approve Merge'
      : 'Manual Approval Required';

  const approveButtonLabel = isFixApproval
    ? 'Approve Fix'
    : isMergeNode
      ? onFinish === 'pull_request'
        ? 'Confirm Create PR'
        : 'Approve Merge'
      : 'Approve';

  const rejectButtonLabel = showRejectInput
    ? (isFixApproval ? 'Confirm Reject Fix' : isMergeNode ? 'Confirm Reject Merge' : 'Confirm Reject')
    : (isFixApproval ? 'Reject Fix' : isMergeNode ? 'Reject Merge' : 'Reject');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-gray-700">
        {/* Header */}
        <div className="p-6 pb-0 shrink-0">
          <h2 className="text-lg font-semibold text-gray-100 mb-2 shrink-0">
            {heading}
          </h2>
          <p className="text-sm text-gray-300 mb-1">
            Task: <span className="font-mono text-gray-200">{task.id}</span>
          </p>
          <p className="text-sm text-gray-400">{task.description}</p>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
          {sessionId && (
            <div className="bg-gray-700/50 rounded p-3" data-testid="claude-session-context">
              <h3 className="text-sm font-medium text-gray-300 mb-2">{agentLabel} Session</h3>
              <p className="text-xs text-gray-500 mb-2 font-mono">{sessionId}</p>
              {sessionLoading && <p className="text-xs text-gray-500" data-testid="session-loading">Loading conversation...</p>}
              {sessionMessages && (
                <div className="space-y-2" data-testid="session-messages">
                  {sessionMessages.map((msg, i) => (
                    <div key={i} className="text-xs">
                      <span className={msg.role === 'user' ? 'text-blue-400' : 'text-green-400'}>
                        {msg.role === 'user' ? 'Human' : agentLabel}:
                      </span>
                      <pre className="text-gray-300 whitespace-pre-wrap mt-0.5">{msg.content}</pre>
                    </div>
                  ))}
                </div>
              )}
              {sessionError && <p className="text-xs text-red-400" data-testid="session-error">Could not load session</p>}
            </div>
          )}

          {task.config.summary && (
            <div className="bg-gray-700/50 rounded p-3">
              <h3 className="text-sm font-medium text-gray-300 mb-1">Summary</h3>
              <p className="text-xs text-gray-400 whitespace-pre-wrap max-h-[20vh] overflow-y-auto">
                {task.config.summary}
              </p>
            </div>
          )}

          {showRejectInput && (
            <div>
              <label className="block text-sm text-gray-300 mb-1">
                Rejection reason (optional)
              </label>
              <textarea
                value={reason}
                onChange={(e) => {
                  setReasonTouched(true);
                  setReason(e.target.value);
                }}
                className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-500"
                rows={3}
                placeholder="Why is this being rejected?"
                autoFocus
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 pt-4 shrink-0 border-t border-gray-700">
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
              {rejectButtonLabel}
            </button>
            {!showRejectInput && (
              <button
                onClick={handleApprove}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded text-sm font-medium transition-colors"
              >
                {approveButtonLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
