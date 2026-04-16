/**
 * Shared classifier for headless CLI commands.
 *
 * This is used by both:
 * - main.ts (pre-init routing/delegation decisions)
 * - tests/policy checks to keep command routing behavior consistent
 */

export function isHeadlessReadOnlyCommand(args: string[]): boolean {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') return true;
  if (command === 'query') return true;
  return ['list', 'status', 'task-status', 'queue', 'audit', 'session', 'query-select', 'open-terminal', 'slack'].includes(command);
}

export function isHeadlessMutatingCommand(args: string[]): boolean {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') return false;
  if (command === 'query') return false;

  if (command === 'set') {
    const sub = args[1];
    return ['command', 'executor', 'agent', 'merge-mode', 'gate-policy'].includes(sub ?? '');
  }

  if (['list', 'status', 'task-status', 'queue', 'audit', 'session', 'query-select'].includes(command)) {
    return false;
  }

  if (['open-terminal'].includes(command)) {
    return false;
  }

  return [
    'run', 'resume', 'restart', 'recreate', 'recreate-task', 'rebase', 'fix', 'resolve-conflict',
    'migrate-compat',
    'restart-workflow', 'clean-restart', 'rebase-and-retry',
    'approve', 'reject', 'input', 'select',
    'cancel', 'cancel-workflow',
    'delete', 'delete-workflow', 'delete-all',
    'edit', 'edit-executor', 'edit-type', 'edit-agent', 'set-merge-mode',
  ].includes(command);
}
