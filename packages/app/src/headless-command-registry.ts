export type HeadlessCommandKind = 'read' | 'write' | 'special';

export interface HeadlessCommandDefinition {
  readonly name: string;
  readonly kind: HeadlessCommandKind;
  readonly aliases?: readonly string[];
}

export const HEADLESS_SET_SUBCOMMANDS = [
  'command',
  'prompt',
  'pool',
  'executor',
  'agent',
  'merge-mode',
  'fix-prompt',
  'fix-context',
  'gate-policy',
  'workflow',
  'task',
] as const;

export function formatHeadlessSetSubcommands(separator: string): string {
  return HEADLESS_SET_SUBCOMMANDS.join(separator);
}

export const HEADLESS_COMMANDS = [
  { name: 'owner-serve', kind: 'special' },
  { name: 'query', kind: 'read' },
  { name: 'set', kind: 'special' },
  { name: 'migrate-compat', kind: 'write' },
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
  { name: 'fork-workflow', kind: 'special' },
  { name: 'detach-workflow', kind: 'write' },
  { name: 'rebase-retry', kind: 'write' },
  { name: 'rebase-recreate', kind: 'write' },
  { name: 'repair-review-gate-ci', kind: 'write' },
  { name: 'repair-review-gate-merge-conflict', kind: 'write' },
  { name: 'fix', kind: 'write' },
  { name: 'resolve-conflict', kind: 'write' },
  { name: 'approve', kind: 'write' },
  { name: 'reject', kind: 'write' },
  { name: 'input', kind: 'write' },
  { name: 'select', kind: 'write' },
  { name: 'cancel', kind: 'write' },
  { name: 'cancel-workflow', kind: 'write' },
  { name: 'delete-task', kind: 'write' },
  { name: 'delete-workflow', kind: 'write', aliases: ['delete'] },
  { name: 'delete-all', kind: 'write' },
  { name: 'open-terminal', kind: 'read' },
  { name: 'query-select', kind: 'read' },
  { name: 'worker', kind: 'read' },
  { name: 'list', kind: 'read' },
  { name: 'status', kind: 'read' },
  { name: 'task-status', kind: 'read' },
  { name: 'queue', kind: 'read' },
  { name: 'audit', kind: 'read' },
  { name: 'session', kind: 'read' },
  { name: 'edit', kind: 'write' },
  { name: 'edit-executor', kind: 'write' },
  { name: 'edit-type', kind: 'write' },
  { name: 'edit-agent', kind: 'write' },
  { name: 'set-merge-mode', kind: 'write' },
] as const satisfies readonly HeadlessCommandDefinition[];

export function findHeadlessCommandDefinition(command: string | undefined): HeadlessCommandDefinition | undefined {
  if (!command) return undefined;
  return HEADLESS_COMMANDS.find((definition) => (
    definition.name === command
      || ('aliases' in definition && (definition.aliases as readonly string[]).includes(command))
  ));
}

export function isMutatingSetSubcommand(subcommand: string | undefined): boolean {
  return HEADLESS_SET_SUBCOMMANDS.includes(subcommand as (typeof HEADLESS_SET_SUBCOMMANDS)[number]);
}
