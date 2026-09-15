export type AutoFixRecoveryAuditAction = 'wakeup' | 'scan' | 'submit' | 'skip';

export function classifyAutoFixRecoveryPhase(
  phase: string,
  details: Record<string, unknown> = {},
): AutoFixRecoveryAuditAction | undefined {
  if (phase === 'delta-failed') return 'wakeup';
  if (phase === 'poll-failed' || phase === 'schedule-enter') return 'scan';
  if (phase === 'schedule-enqueued' || phase === 'worker-autofix-submitted') return 'submit';
  if (phase === 'schedule-skip' || phase.endsWith('-skip')) return 'skip';
  if (details.reason && (phase.includes('skip') || phase.includes('error'))) return 'skip';
  return undefined;
}
