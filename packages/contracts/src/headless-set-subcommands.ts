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

export function listHeadlessSetSubcommandsForScope(scope: HeadlessSetSubcommandScope): string[] {
  return HEADLESS_SET_SUBCOMMANDS
    .filter((definition) => definition.scope === scope)
    .map((definition) => definition.name);
}
