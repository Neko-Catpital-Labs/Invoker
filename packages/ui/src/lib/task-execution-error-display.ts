const SSH_REMOTE_FINALIZE_PREFIX = 'Executor cleanup failed (ssh remote finalize):';
const CLEANUP_TAIL_MARKERS = [
  'pop_var_context',
  'Orphan function call output',
  '[SshExecutor] Recording task result and pushing branch on remote...',
] as const;

function hasCompletedAgentTurn(error: string): boolean {
  return error.includes('"type":"turn.completed"')
    || (error.includes('"type":"item.completed"') && error.includes('"type":"agent_message"'));
}

function normalizeLegacySshCleanupTail(error: string): string | undefined {
  if (error.startsWith(SSH_REMOTE_FINALIZE_PREFIX)) return error;
  if (!hasCompletedAgentTurn(error)) return undefined;
  if (!CLEANUP_TAIL_MARKERS.some((marker) => error.includes(marker))) return undefined;
  if (error.includes('pop_var_context')) {
    return `${SSH_REMOTE_FINALIZE_PREFIX} bash pop_var_context after remote run completed.`;
  }
  if (error.includes('Orphan function call output')) {
    return `${SSH_REMOTE_FINALIZE_PREFIX} orphan function-call output after remote run completed.`;
  }
  return `${SSH_REMOTE_FINALIZE_PREFIX} remote finalize wrapper output after remote run completed.`;
}

export function formatTaskExecutionErrorForDisplay(error?: string): string | undefined {
  if (typeof error !== 'string' || error.length === 0) return error;
  return normalizeLegacySshCleanupTail(error) ?? error;
}
