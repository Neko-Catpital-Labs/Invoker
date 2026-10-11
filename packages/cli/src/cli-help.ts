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

export type HelpOptionGroup = {
  readonly title: string;
  readonly options: readonly HelpOption[];
};

const SET_FIELDS = listHeadlessSetSubcommandsForScope('task');

const COMMAND_GROUPS: readonly HelpCommandGroup[] = [
  {
    title: 'Workflow execution',
    commands: [
      {
        id: 'run',
        usage: 'run <plan.yaml> [--live|--standalone] [--db-dir <path>] [--config <path>] [--json]',
        summary: 'Submit to a live Invoker owner when available, otherwise run standalone.',
        options: [
          { flag: '--live', description: 'Require a running Invoker owner and submit over IPC.' },
          { flag: '--standalone', description: 'Skip IPC and use an isolated/configured CLI database.' },
          { flag: '--db-dir <path>', description: 'Runtime database directory. Defaults to ~/.invoker-cli.' },
          { flag: '--config <path>', description: 'Optional config path reserved for CLI runtime configuration.' },
          { flag: '--json', description: 'Emit only a machine-readable result summary on stdout.' },
        ],
      },
      {
        id: 'wait',
        usage: 'wait <workflowId> [--max-wait-ms <ms>] [--poll-interval-ms <ms>]',
        summary: 'Park until a live-owner workflow settles, then print one INVOKER_WAKE line.',
        options: [
          { flag: '--max-wait-ms <ms>', description: 'Maximum park time. Defaults to 86400000 (24h).' },
          { flag: '--poll-interval-ms <ms>', description: 'Query interval. Defaults to 5000.' },
        ],
      },
    ],
  },
  {
    title: 'Workflow and task queries',
    commands: [
      {
        id: 'query workflows',
        usage: 'query workflows [--status <status>] [--output text|json] [--standalone]',
        summary: 'Read workflows from a live owner, or from a read-only database view with --standalone.',
      },
      {
        id: 'query tasks',
        usage: 'query tasks [--workflow <id>] [--status <status>] [--output text|json] [--standalone]',
        summary: 'Read tasks from a live owner, or from a read-only database view with --standalone.',
      },
      {
        id: 'query workflow',
        usage: 'query workflow <id> [--output text|json]',
        summary: 'Read one workflow from a live owner.',
      },
      {
        id: 'query task',
        usage: 'query task <id> [--output text|json]',
        summary: 'Read one task from a live owner.',
      },
      {
        id: 'query capacity',
        usage: 'query capacity [--output text|json]',
        summary: 'Show live pool/member slot usage, queue depth by workflow, and the oldest-waiting task. Requires a live owner.',
      },
    ],
  },
  {
    title: 'Workflow and task management',
    commands: [
      {
        id: 'retry',
        usage: 'retry <workflowId>',
        summary: 'Ask a live Invoker owner to retry a workflow.',
      },
      {
        id: 'resume',
        usage: 'resume <workflowId>',
        summary: 'Ask a live Invoker owner to resume a workflow.',
      },
      {
        id: 'retry-task',
        usage: 'retry-task <taskId>',
        summary: 'Ask a live Invoker owner to retry one task.',
      },
      {
        id: 'retry-tasks',
        usage: 'retry-tasks --status <status> [--parallel N] [--dry-run]',
        summary: 'Retry all tasks matching a status through a live owner.',
        options: [
          { flag: '--status <status>', description: 'Required. Status filter for matching tasks.' },
          { flag: '--parallel N', description: 'Maximum concurrent mutation requests. Defaults to 8.' },
          { flag: '--dry-run', description: 'Print matching task IDs without mutating.' },
        ],
      },
      {
        id: 'set',
        usage: 'set <field> <taskId> <value...> [--force] [-- <value...>]',
        summary: `Edit one task field through a live owner. Fields: ${SET_FIELDS.join(', ')}.`,
        details: [
          'Refuses terminal tasks, running tasks without --force, and pool or executor changes the task\'s runner kind cannot take.',
        ],
        options: [
          { flag: '--force', description: 'Edit a running task; the owner cancels the launched attempt first.' },
          { flag: '--', description: 'End options; later arguments are passed as values even if they start with --.' },
        ],
      },
      {
        id: 'delete',
        usage: 'delete <workflowId>',
        summary: 'Ask a live Invoker owner to delete one workflow.',
      },
      {
        id: 'delete-all',
        usage: 'delete-all',
        summary: 'Ask a live Invoker owner to delete all workflows. Runs unconditionally; the owner snapshots the DB first.',
      },
      {
        id: 'agent-login',
        usage: 'agent-login <start <claude|codex> | code <sessionId> <code> | status <sessionId>> [--output text|json]',
        summary: 'Start or complete an agent login session through a live Invoker owner.',
        options: [
          { flag: '--output text|json', description: 'Output format. Defaults to text.' },
        ],
      },
    ],
  },
  {
    title: 'Owner and workers',
    commands: [
      {
        id: 'owner serve',
        usage: 'owner serve',
        summary: 'Start a headless Invoker owner process.',
      },
      {
        id: 'worker',
        usage: 'worker [autofix|list]',
        summary: 'Run a registry-selected worker or list available worker kinds.',
      },
      {
        id: 'worker toggles',
        usage: 'worker toggles [--enable <id>|--disable <id> ...]',
        summary: 'Show or set owner worker on/off (pr-status, autofix, PR maintenance, e2e auto-fix, worker-session-mine, codex-spend-clamp, idle-task-cleanup) and policy flags (auto-approve, disk-headroom cleanup).',
      },
      {
        id: 'run-worker',
        usage: 'run-worker <kind> -- <args...>',
        summary: 'Run one worker kind once with optional forwarded arguments.',
      },
    ],
  },
  {
    title: 'Runtime controls',
    commands: [
      {
        id: 'spend-gate',
        usage: 'spend-gate [status|reset]',
        summary: 'Show or clear the Codex daily-spend shutoff. While tripped, every Codex request fails; `reset` reopens it after you review the sessions.',
      },
      {
        id: 'auto-approve-authors',
        usage: 'auto-approve-authors [--json] [--set <login...>|--add <login>|--add-current-github-user|--clear]',
        summary: 'Show or set GitHub logins in config.json that auto-approve may act on. Does not enable the auto-approve toggle.',
        options: [
          { flag: '--json', description: 'Emit a machine-readable allowlist snapshot.' },
          { flag: '--set <login...>', description: 'Replace the allowlist with the given logins.' },
          { flag: '--add <login>', description: 'Add one login to the allowlist.' },
          { flag: '--add-current-github-user', description: 'Add the login from `gh api user`.' },
          { flag: '--clear', description: 'Clear the allowlist.' },
        ],
      },
    ],
  },
  {
    title: 'Installation and diagnostics',
    commands: [
      {
        id: 'install',
        usage: 'install [--demo]',
        summary: 'Quick-install: global cli+ui, doctor --fix, skills+MCP, default workers. Skips Slack/machines.',
        options: [
          { flag: '--demo', description: 'Print the expected install transcript without mutating the machine.' },
        ],
      },
      {
        id: 'uninstall',
        usage: 'uninstall [--dry-run] [--yes] [--keep-data]',
        summary: 'Remove Invoker-owned integrations, home data, and global npm packages. Run `invoker-cli uninstall --help` for exit codes and coverage.',
        options: [
          { flag: '--dry-run', description: 'Print the deletion plan and coverage without mutating disk.' },
          { flag: '--yes', description: 'Skip confirmation prompts (required when stdin is not a TTY).' },
          { flag: '--keep-data', description: 'Skip Invoker home data purge; still remove integrations and global npm packages.' },
        ],
      },
      {
        id: 'doctor',
        usage: 'doctor [--fix] [--json]',
        summary: 'Validate tools, config, and your default planning preset.',
        options: [
          { flag: '--fix', description: 'Best-effort install of missing doctor tools.' },
          { flag: '--json', description: 'Emit only a machine-readable doctor report on stdout.' },
        ],
      },
    ],
  },
  {
    title: 'Setup and integrations',
    commands: [
      {
        id: 'setup',
        usage: 'setup [planner|slack|machines] [--check|--from-env] [--yes] [--json] [--register-harnesses]',
        summary: 'Run the setup wizard, or directly configure planner MCP, Slack, or machines.',
        options: [
          { flag: '--check', description: 'Report planner/setup state without writing changes.' },
          { flag: '--from-env', description: 'Run Slack setup from SLACK_* environment values without prompts.' },
          { flag: '--yes', description: 'Skip confirmation prompts.' },
          { flag: '--json', description: 'Emit machine-readable setup output where supported.' },
          { flag: '--register-harnesses', description: 'Opt in to harness MCP/skill registration without a prompt.' },
          { flag: '--planner-url <url>', description: 'Planner service URL for `setup planner`.' },
          { flag: '--access-token <tok>', description: 'Planner service access token for `setup planner`.' },
          {
            flag: '--planner-package <spec>',
            description: `Planner MCP package spec for \`setup planner\`. Defaults to ${DEFAULT_DRAFTER_MCP_PACKAGE_SPEC}.`,
          },
          { flag: '--target <path>', description: 'MCP config path for planner setup. Defaults to ~/.invoker/mcp.json.' },
          { flag: '--uninstall', description: 'Remove the experimental planner MCP entry and disable its Invoker flag.' },
        ],
      },
      {
        id: 'mcp',
        usage: 'mcp',
        summary: 'Start the Invoker MCP stdio server.',
      },
    ],
  },
];

const GLOBAL_OPTIONS: readonly HelpOption[] = [
  { flag: '--help', description: 'Show this help text (or `invoker-cli <command> --help` for command details).' },
  { flag: '--version', description: 'Show the CLI version.' },
  { flag: '--json', description: 'Emit only a machine-readable result summary on stdout (where supported).' },
  { flag: '--live', description: 'Require a running Invoker owner and submit over IPC (`run`).' },
  { flag: '--standalone', description: 'Skip IPC for `run` or `query` and use an isolated/configured CLI database.' },
  { flag: '--db-dir <path>', description: 'Runtime database directory. Defaults to ~/.invoker-cli.' },
  { flag: '--config <path>', description: 'Optional config path reserved for CLI runtime configuration.' },
];

const QUERY_OPTIONS: readonly HelpOption[] = [
  { flag: '--workflow <id>', description: 'Restrict `query tasks` to one workflow.' },
  { flag: '--status <status>', description: 'Restrict `query workflows` or `query tasks` to one status.' },
  { flag: '--output <fmt>', description: 'Query output format. Supported values: text, json. Defaults to text.' },
];

const EXECUTION_MUTATION_OPTIONS: readonly HelpOption[] = [
  { flag: '--max-wait-ms <ms>', description: 'Maximum park time for `wait`. Defaults to 86400000 (24h).' },
  { flag: '--poll-interval-ms <ms>', description: 'Query interval for `wait`. Defaults to 5000.' },
  { flag: '--parallel N', description: 'Maximum concurrent mutation requests for `retry-tasks`. Defaults to 8.' },
  {
    flag: '--dry-run',
    description: 'For `retry-tasks`: print matching task IDs without mutating. For `uninstall`: print the deletion plan and coverage without mutating disk.',
  },
  { flag: '--force', description: 'Let `set` edit a running task; the owner cancels the launched attempt first.' },
  { flag: '--', description: 'End `set` options; later arguments are passed as values even if they start with --.' },
];

const INSTALL_SETUP_OPTIONS: readonly HelpOption[] = [
  { flag: '--demo', description: 'For `install`: print the expected transcript without mutating the machine.' },
  { flag: '--yes', description: 'For `uninstall` / `setup`: skip confirmation prompts (`uninstall` requires this when stdin is not a TTY).' },
  { flag: '--keep-data', description: 'For `uninstall`: skip Invoker home data purge; still remove integrations and global npm packages.' },
  { flag: '--fix', description: 'For `doctor`: best-effort install of missing tools.' },
  { flag: '--from-env', description: 'For `setup slack`: run from SLACK_* environment values without prompts.' },
  { flag: '--check', description: 'For `setup`: report state without writing changes.' },
];

const PLANNER_SETUP_OPTIONS: readonly HelpOption[] = [
  { flag: '--planner-url <url>', description: 'Planner service URL for `setup planner`.' },
  { flag: '--access-token <tok>', description: 'Planner service access token for `setup planner`.' },
  {
    flag: '--planner-package <spec>',
    description: `Planner MCP package spec for \`setup planner\`. Defaults to ${DEFAULT_DRAFTER_MCP_PACKAGE_SPEC}.`,
  },
  { flag: '--target <path>', description: 'MCP config path for planner setup. Defaults to ~/.invoker/mcp.json.' },
  { flag: '--uninstall', description: 'Remove the experimental planner MCP entry and disable its Invoker flag.' },
];

const ROOT_OPTION_GROUPS: readonly HelpOptionGroup[] = [
  { title: 'Global options', options: GLOBAL_OPTIONS },
  { title: 'Query options', options: QUERY_OPTIONS },
  { title: 'Execution and mutation options', options: EXECUTION_MUTATION_OPTIONS },
  { title: 'Installation and setup options', options: INSTALL_SETUP_OPTIONS },
  { title: 'Planner setup options', options: PLANNER_SETUP_OPTIONS },
];

const QUERY_COMMAND_OPTIONS: readonly HelpOption[] = [
  ...QUERY_OPTIONS,
  { flag: '--standalone', description: 'Read from a configured/isolated CLI database instead of a live owner (list queries only).' },
];

function flattenCommands(): HelpCommand[] {
  return COMMAND_GROUPS.flatMap((group) => [...group.commands]);
}

export function listHelpCommandGroups(): readonly HelpCommandGroup[] {
  return COMMAND_GROUPS;
}

export function listRootHelpCommands(): readonly HelpCommand[] {
  return flattenCommands();
}

function formatOptionLines(options: readonly HelpOption[], indent = '  '): string[] {
  const width = options.reduce((max, option) => Math.max(max, option.flag.length), 0);
  return options.map((option) => `${indent}${option.flag.padEnd(width)}  ${option.description}`);
}

function formatCommandBlock(command: HelpCommand, indent = '    '): string[] {
  const lines = [`${indent}${command.usage}`];
  lines.push(`${indent}  ${command.summary}`);
  for (const detail of command.details ?? []) {
    lines.push(`${indent}  ${detail}`);
  }
  return lines;
}

export function formatRootHelp(): string {
  const lines: string[] = [
    'Invoker CLI',
    '',
    'Usage:',
    '  invoker-cli <command> [options]',
    '  invoker-cli --help',
    '  invoker-cli --version',
    '',
    'Commands:',
  ];

  for (const group of COMMAND_GROUPS) {
    lines.push('');
    lines.push(`  ${group.title}`);
    for (const command of group.commands) {
      lines.push(...formatCommandBlock(command));
    }
  }

  for (const group of ROOT_OPTION_GROUPS) {
    lines.push('');
    lines.push(`${group.title}:`);
    lines.push(...formatOptionLines(group.options));
  }

  lines.push('');
  lines.push('Run \'invoker-cli <command> --help\' for command-specific options and details.');
  return lines.join('\n');
}

function findCommandById(commandId: string): HelpCommand | undefined {
  return flattenCommands().find((command) => command.id === commandId);
}

function findQueryHelp(): HelpCommand {
  return {
    id: 'query',
    usage: 'query <workflows|tasks|workflow <id>|task <id>|capacity> [options]',
    summary: 'Read workflow and task state from a live owner, or from a read-only database view with --standalone.',
    options: QUERY_COMMAND_OPTIONS,
    details: COMMAND_GROUPS
      .find((group) => group.title === 'Workflow and task queries')
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
  return { ...command, options: QUERY_COMMAND_OPTIONS };
}

export function formatCommandHelp(commandId: string): string | undefined {
  let command: HelpCommand | undefined;
  if (commandId === 'query') {
    command = findQueryHelp();
  } else if (commandId.startsWith('query ')) {
    command = withQueryOptions(findCommandById(commandId) ?? findQueryHelp());
  } else {
    command = findCommandById(commandId);
  }
  if (!command) return undefined;

  const lines: string[] = [
    `Usage: invoker-cli ${command.usage}`,
    '',
    command.summary,
  ];
  for (const detail of command.details ?? []) {
    lines.push(detail);
  }
  if (command.options && command.options.length > 0) {
    lines.push('');
    lines.push('Options:');
    lines.push(...formatOptionLines(command.options));
  }
  lines.push('');
  lines.push('Run \'invoker-cli --help\' for all commands.');
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
