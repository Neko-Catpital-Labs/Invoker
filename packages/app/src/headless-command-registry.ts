export type HeadlessCommandKind = 'read' | 'write' | 'special';

export interface HeadlessCommandDefinition {
  readonly name: string;
  readonly kind: HeadlessCommandKind;
}

export type HeadlessSetSubcommandScope = 'task' | 'workflow';

export interface HeadlessSetSubcommandDefinition {
  readonly name: string;
  readonly scope: HeadlessSetSubcommandScope;
}

export const HEADLESS_SET_SUBCOMMANDS = [
  { name: 'command', scope: 'task' },
  { name: 'prompt', scope: 'task' },
  { name: 'pool', scope: 'task' },
  { name: 'executor', scope: 'task' },
  { name: 'agent', scope: 'task' },
  { name: 'model', scope: 'task' },
  { name: 'task-pool', scope: 'task' },
  { name: 'merge-mode', scope: 'workflow' },
  { name: 'fix-prompt', scope: 'task' },
  { name: 'fix-context', scope: 'task' },
  { name: 'gate-policy', scope: 'task' },
  { name: 'workflow', scope: 'workflow' },
  { name: 'task', scope: 'task' },
] as const satisfies readonly HeadlessSetSubcommandDefinition[];

export type HeadlessSetSubcommand = (typeof HEADLESS_SET_SUBCOMMANDS)[number]['name'];

export function formatHeadlessSetSubcommands(separator: string): string {
  return HEADLESS_SET_SUBCOMMANDS.map((definition) => definition.name).join(separator);
}

export function findHeadlessSetSubcommandScope(
  subcommand: string | undefined,
): HeadlessSetSubcommandScope | undefined {
  if (!subcommand) return undefined;
  return HEADLESS_SET_SUBCOMMANDS.find((definition) => definition.name === subcommand)?.scope;
}

export const HEADLESS_COMMANDS = [
  { name: 'owner-serve', kind: 'special' },
  { name: 'query', kind: 'read' },
  { name: 'set', kind: 'special' },
  { name: 'migrate-compat', kind: 'write' },
  { name: 'repair-filing', kind: 'write' },
  { name: 'install-skills', kind: 'special' },
  { name: 'watch', kind: 'read' },
  { name: 'run', kind: 'write' },
  { name: 'start-ready', kind: 'write' },
  { name: 'resume', kind: 'write' },
  { name: 'retry', kind: 'write' },
  { name: 'retry-task', kind: 'write' },
  { name: 'recreate', kind: 'write' },
  { name: 'recreate-task', kind: 'write' },
  { name: 'recreate-downstream', kind: 'write' },
  { name: 'replace-task', kind: 'special' },
  { name: 'fork-workflow', kind: 'write' },
  { name: 'detach-workflow', kind: 'write' },
  { name: 'attach-workflow', kind: 'write' },
  { name: 'rebase-retry', kind: 'write' },
  { name: 'rebase-recreate', kind: 'write' },
  { name: 'repair-review-gate-ci', kind: 'write' },
  { name: 'check-pr-status', kind: 'write' },
  { name: 'fix', kind: 'write' },
  { name: 'resolve-conflict', kind: 'write' },
  { name: 'approve', kind: 'write' },
  { name: 'reject', kind: 'write' },
  { name: 'input', kind: 'write' },
  { name: 'select', kind: 'write' },
  { name: 'cancel', kind: 'write' },
  { name: 'cancel-workflow', kind: 'write' },
  { name: 'delete-task', kind: 'write' },
  { name: 'close-task', kind: 'write' },
  { name: 'delete', kind: 'write' },
  { name: 'delete-all', kind: 'write' },
  { name: 'reset-autofix-budget', kind: 'write' },
  { name: 'open-terminal', kind: 'read' },
  { name: 'query-select', kind: 'read' },
  { name: 'worker', kind: 'read' },
] as const satisfies readonly HeadlessCommandDefinition[];

export function findHeadlessCommandDefinition(command: string | undefined): HeadlessCommandDefinition | undefined {
  if (!command) return undefined;
  return HEADLESS_COMMANDS.find((definition) => definition.name === command);
}

export function isHeadlessHelpCommand(command: string | undefined): boolean {
  return command === undefined || command === '--help' || command === '-h';
}

export function isRemovedHeadlessCommandAlias(command: string | undefined): boolean {
  return command === 'set-merge-mode';
}

export function isMutatingSetSubcommand(subcommand: string | undefined): boolean {
  return typeof subcommand === 'string' && subcommand.length > 0;
}
