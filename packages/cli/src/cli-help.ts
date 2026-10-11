import { DEFAULT_DRAFTER_MCP_PACKAGE_SPEC, listHeadlessSetSubcommandsForScope } from '@invoker/contracts';

export class CliHelpSignal extends Error {
  readonly helpText: string;

  constructor(helpText: string) {
    super(helpText);
    this.name = 'CliHelpSignal';
    this.helpText = helpText;
  }
}

export type HelpCommand = {
  readonly id: string;
  readonly usage: string;
  readonly summary: string;
  readonly details?: readonly string[];
  readonly options?: readonly HelpOption[];
};

export type HelpOption = {
  readonly flag: string;
  readonly description: string;
};

export type HelpCommandGroup = {
  readonly title: string;
  readonly commands: readonly HelpCommand[];
};

export type HelpFormatOptions = {
  readonly color?: boolean;
};

type HelpStyle = {
  title: (text: string) => string;
  section: (text: string) => string;
  command: (text: string) => string;
  dim: (text: string) => string;
  flag: (text: string) => string;
};

const SET_FIELDS = listHeadlessSetSubcommandsForScope('task');
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
} as const;

function paint(enabled: boolean, codes: string, text: string): string {
  if (!enabled) return text;
  return `${codes}${text}${ANSI.reset}`;
}

export function shouldUseHelpColor(options: HelpFormatOptions = {}): boolean {
  if (options.color === true) return true;
  if (options.color === false) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '') return true;
  return Boolean(process.stdout.isTTY);
}

function createHelpStyle(color: boolean): HelpStyle {
  return {
    title: (text) => paint(color, `${ANSI.bold}${ANSI.cyan}`, text),
    section: (text) => paint(color, ANSI.bold, text),
    command: (text) => paint(color, ANSI.green, text),
    dim: (text) => paint(color, ANSI.dim, text),
    flag: (text) => paint(color, ANSI.yellow, text),
  };
}

const COMMAND_GROUPS: readonly HelpCommandGroup[] = [
  {
    title: 'Getting started',
    commands: [
      {
        id: 'install',
        usage: 'install [--demo]',
        summary: 'Install the CLI, UI, skills, and default workers.',
        options: [
          { flag: '--demo', description: 'Show a sample install transcript without changing anything.' },
        ],
      },
      {
        id: 'doctor',
        usage: 'doctor [--fix] [--json]',
        summary: 'Check that your tools and config look healthy.',
        options: [
          { flag: '--fix', description: 'Try to install missing tools.' },
          { flag: '--json', description: 'Print JSON instead of text.' },
        ],
      },
      {
        id: 'setup',
        usage: 'setup [planner|slack|machines] [--check|--from-env] [--yes] [--json] [--register-harnesses]',
        summary: 'Configure planner, Slack, machines, or AI harnesses.',
        options: [
          { flag: '--check', description: 'Show status without changing anything.' },
          { flag: '--from-env', description: 'Configure Slack from SLACK_* env vars.' },
          { flag: '--yes', description: 'Skip confirmation prompts.' },
          { flag: '--json', description: 'Print JSON where supported.' },
          { flag: '--register-harnesses', description: 'Wire Cursor/Claude/Codex helpers without asking.' },
          { flag: '--planner-url <url>', description: 'Planner URL for `setup planner`.' },
          { flag: '--access-token <tok>', description: 'Planner access token for `setup planner`.' },
          {
            flag: '--planner-package <spec>',
            description: `Planner package for \`setup planner\` (default ${DEFAULT_DRAFTER_MCP_PACKAGE_SPEC}).`,
          },
          { flag: '--target <path>', description: 'MCP config path (default ~/.invoker/mcp.json).' },
          { flag: '--uninstall', description: 'Remove the experimental planner MCP entry.' },
        ],
      },
      {
        id: 'mcp',
        usage: 'mcp',
        summary: 'Start the MCP server for AI tools.',
      },
    ],
  },
  {
    title: 'Run workflows',
    commands: [
      {
        id: 'run',
        usage: 'run <plan.yaml> [--live|--standalone] [--db-dir <path>] [--config <path>] [--json]',
        summary: 'Run a plan. Uses the open app when possible.',
        options: [
          { flag: '--live', description: 'Require a running Invoker app/owner.' },
          { flag: '--standalone', description: 'Run locally without talking to the app.' },
          { flag: '--db-dir <path>', description: 'Local DB folder (default ~/.invoker-cli).' },
          { flag: '--config <path>', description: 'Optional config file path.' },
          { flag: '--json', description: 'Print JSON instead of text.' },
        ],
      },
      {
        id: 'wait',
        usage: 'wait <workflowId> [--max-wait-ms <ms>] [--poll-interval-ms <ms>]',
        summary: 'Wait until a workflow finishes, then print INVOKER_WAKE.',
        options: [
          { flag: '--max-wait-ms <ms>', description: 'Give up after this many ms (default 24h).' },
          { flag: '--poll-interval-ms <ms>', description: 'How often to check (default 5000).' },
        ],
      },
    ],
  },
  {
    title: 'Look up status',
    commands: [
      {
        id: 'query workflows',
        usage: 'query workflows [--status <status>] [--output text|json] [--standalone]',
        summary: 'List workflows.',
      },
      {
        id: 'query tasks',
        usage: 'query tasks [--workflow <id>] [--status <status>] [--output text|json] [--standalone]',
        summary: 'List tasks.',
      },
      {
        id: 'query workflow',
        usage: 'query workflow <id> [--output text|json]',
        summary: 'Show one workflow.',
      },
      {
        id: 'query task',
        usage: 'query task <id> [--output text|json]',
        summary: 'Show one task.',
      },
      {
        id: 'query capacity',
        usage: 'query capacity [--output text|json]',
        summary: 'Show free slots and queue depth (needs a running owner).',
      },
    ],
  },
  {
    title: 'Manage workflows & tasks',
    commands: [
      {
        id: 'retry',
        usage: 'retry <workflowId>',
        summary: 'Retry a workflow.',
      },
      {
        id: 'resume',
        usage: 'resume <workflowId>',
        summary: 'Resume a paused workflow.',
      },
      {
        id: 'retry-task',
        usage: 'retry-task <taskId>',
        summary: 'Retry one task.',
      },
      {
        id: 'retry-tasks',
        usage: 'retry-tasks --status <status> [--parallel N] [--dry-run]',
        summary: 'Retry every task with a given status.',
        options: [
          { flag: '--status <status>', description: 'Required status filter.' },
          { flag: '--parallel N', description: 'Max concurrent retries (default 8).' },
          { flag: '--dry-run', description: 'List matches without retrying.' },
        ],
      },
      {
        id: 'set',
        usage: 'set <field> <taskId> <value...> [--force] [-- <value...>]',
        summary: `Change a task field (${SET_FIELDS.join(', ')}).`,
        details: [
          'Blocked for finished tasks. Running tasks need --force. Some pool/executor changes are rejected by runner kind.',
        ],
        options: [
          { flag: '--force', description: 'Edit a running task (cancels the current attempt first).' },
          { flag: '--', description: 'Treat later args as values, even if they start with --.' },
        ],
      },
      {
        id: 'delete',
        usage: 'delete <workflowId>',
        summary: 'Delete one workflow.',
      },
      {
        id: 'delete-all',
        usage: 'delete-all',
        summary: 'Delete all workflows (owner snapshots the DB first).',
      },
    ],
  },
  {
    title: 'Owner & workers',
    commands: [
      {
        id: 'owner serve',
        usage: 'owner serve',
        summary: 'Start a headless owner process.',
      },
      {
        id: 'worker',
        usage: 'worker [autofix|list]',
        summary: 'Run a worker, or list kinds.',
      },
      {
        id: 'worker toggles',
        usage: 'worker toggles [--enable <id>|--disable <id> ...]',
        summary: 'Turn background workers on or off.',
      },
      {
        id: 'run-worker',
        usage: 'run-worker <kind> -- <args...>',
        summary: 'Run one worker once.',
      },
    ],
  },
  {
    title: 'Advanced',
    commands: [
      {
        id: 'spend-gate',
        usage: 'spend-gate [status|reset]',
        summary: 'Check or clear the Codex spend shutoff.',
        details: [
          'While tripped, every Codex request fails. Use `reset` after you review sessions.',
        ],
      },
      {
        id: 'auto-approve-authors',
        usage: 'auto-approve-authors [--json] [--set <login...>|--add <login>|--add-current-github-user|--clear]',
        summary: 'Who auto-approve may act for (does not turn the toggle on).',
        options: [
          { flag: '--json', description: 'Print JSON.' },
          { flag: '--set <login...>', description: 'Replace the allowlist.' },
          { flag: '--add <login>', description: 'Add one GitHub login.' },
          { flag: '--add-current-github-user', description: 'Add your current `gh` login.' },
          { flag: '--clear', description: 'Clear the allowlist.' },
        ],
      },
      {
        id: 'agent-login',
        usage: 'agent-login <start <claude|codex> | code <sessionId> <code> | status <sessionId>> [--output text|json]',
        summary: 'Start or finish an agent login.',
        options: [
          { flag: '--output text|json', description: 'Output format (default text).' },
        ],
      },
      {
        id: 'uninstall',
        usage: 'uninstall [--dry-run] [--yes] [--keep-data]',
        summary: 'Remove Invoker installs and integrations. See `uninstall --help`.',
        options: [
          { flag: '--dry-run', description: 'Show what would be removed.' },
          { flag: '--yes', description: 'Skip prompts (required when stdin is not a TTY).' },
          { flag: '--keep-data', description: 'Keep home data; still remove integrations and npm packages.' },
        ],
      },
    ],
  },
];

const ROOT_OPTIONS: readonly HelpOption[] = [
  { flag: '--help', description: 'Show help.' },
  { flag: '--version', description: 'Show version.' },
  { flag: '--json', description: 'Print JSON where supported.' },
  { flag: '--live', description: 'Require a running Invoker app (`run`).' },
  { flag: '--standalone', description: 'Stay local for `run` / `query`.' },
  { flag: '--db-dir <path>', description: 'Local DB folder (default ~/.invoker-cli).' },
  { flag: '--config <path>', description: 'Optional config path.' },
];

const QUERY_OPTIONS: readonly HelpOption[] = [
  { flag: '--workflow <id>', description: 'Limit `query tasks` to one workflow.' },
  { flag: '--status <status>', description: 'Filter by status.' },
  { flag: '--output <fmt>', description: 'text or json (default text).' },
  { flag: '--standalone', description: 'Read a local DB instead of a live owner (list queries).' },
];

const QUERY_GROUP_TITLE = 'Look up status';

function flattenCommands(): HelpCommand[] {
  return COMMAND_GROUPS.flatMap((group) => [...group.commands]);
}

export function listHelpCommandGroups(): readonly HelpCommandGroup[] {
  return COMMAND_GROUPS;
}

export function listRootHelpCommands(): readonly HelpCommand[] {
  return flattenCommands();
}

function formatOptionLines(
  options: readonly HelpOption[],
  style: HelpStyle,
  indent = '  ',
): string[] {
  const width = options.reduce((max, option) => Math.max(max, option.flag.length), 0);
  return options.map((option) => {
    const flag = style.flag(option.flag.padEnd(width));
    return `${indent}${flag}  ${style.dim(option.description)}`;
  });
}

function formatCommandBlock(command: HelpCommand, style: HelpStyle, indent = '    '): string[] {
  const lines = [`${indent}${style.command(command.usage)}`];
  lines.push(`${indent}  ${style.dim(command.summary)}`);
  return lines;
}

export function formatRootHelp(options: HelpFormatOptions = {}): string {
  const style = createHelpStyle(shouldUseHelpColor(options));
  const lines: string[] = [
    style.title('Invoker CLI'),
    '',
    style.section('Usage'),
    style.dim('  invoker-cli <command> [options]'),
    style.dim('  invoker-cli --help'),
    style.dim('  invoker-cli --version'),
    '',
    style.section('Commands'),
  ];

  for (const group of COMMAND_GROUPS) {
    lines.push('');
    lines.push(`  ${style.section(group.title)}`);
    for (const command of group.commands) {
      lines.push(...formatCommandBlock(command, style));
    }
  }

  lines.push('');
  lines.push(style.section('Common options'));
  lines.push(...formatOptionLines(ROOT_OPTIONS, style));
  lines.push('');
  lines.push(style.dim('More detail: invoker-cli <command> --help'));
  return lines.join('\n');
}

function findCommandById(commandId: string): HelpCommand | undefined {
  return flattenCommands().find((command) => command.id === commandId);
}

function findQueryHelp(): HelpCommand {
  return {
    id: 'query',
    usage: 'query <workflows|tasks|workflow <id>|task <id>|capacity> [options]',
    summary: 'Inspect workflows and tasks.',
    options: QUERY_OPTIONS,
    details: COMMAND_GROUPS
      .find((group) => group.title === QUERY_GROUP_TITLE)
      ?.commands
      .map((command) => `${command.usage} — ${command.summary}`) ?? [],
  };
}

export function resolveHelpCommandId(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  const [first, second] = argv;
  if (first === 'query' && second && !second.startsWith('-')) {
    return `query ${second}`;
  }
  if (first === 'owner' && second === 'serve') return 'owner serve';
  if (first === 'worker' && second === 'toggles') return 'worker toggles';
  if (first === 'setup' && second && !second.startsWith('-')) {
    return 'setup';
  }
  return first;
}

function withQueryOptions(command: HelpCommand): HelpCommand {
  if (command.options && command.options.length > 0) return command;
  return { ...command, options: QUERY_OPTIONS };
}

export function formatCommandHelp(
  commandId: string,
  options: HelpFormatOptions = {},
): string | undefined {
  let command: HelpCommand | undefined;
  if (commandId === 'query') {
    command = findQueryHelp();
  } else if (commandId.startsWith('query ')) {
    command = withQueryOptions(findCommandById(commandId) ?? findQueryHelp());
  } else {
    command = findCommandById(commandId);
  }
  if (!command) return undefined;

  const style = createHelpStyle(shouldUseHelpColor(options));
  const lines: string[] = [
    `${style.section('Usage')}: invoker-cli ${style.command(command.usage)}`,
    '',
    command.summary,
  ];
  for (const detail of command.details ?? []) {
    lines.push(style.dim(detail));
  }
  if (command.options && command.options.length > 0) {
    lines.push('');
    lines.push(style.section('Options'));
    lines.push(...formatOptionLines(command.options, style));
  }
  lines.push('');
  lines.push(style.dim('All commands: invoker-cli --help'));
  return lines.join('\n');
}

export function throwCommandHelp(commandId: string): never {
  const text = formatCommandHelp(commandId);
  if (!text) {
    throw new Error(`No help text for command: ${commandId}`);
  }
  throw new CliHelpSignal(text);
}

export function isHelpFlag(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h';
}
