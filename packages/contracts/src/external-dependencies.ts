export interface ToolRequirement {
  id: string;
  name: string;
  command: string;
  requiredFor: string;
  /** Missing required tools are `error`; missing optional ones are advisory `warn`. */
  required?: boolean;
  installHint?: string;
}

interface ExternalDependencyBase {
  id: string;
  name: string;
  requiredFor: string;
  required?: boolean;
  installHint?: string;
  version?: string;
  versionRange?: string;
}

interface RuntimeDependency extends ExternalDependencyBase {
  kind: 'runtime';
  command: string;
  versionRange: string;
}

interface ToolDependency extends ExternalDependencyBase {
  kind: 'tool';
  command: string;
}

interface PythonMcpDependency extends ExternalDependencyBase {
  kind: 'python-mcp';
  packageName: string;
  version: string;
  commandName: string;
  runner: 'uvx';
  configEnvVar: string;
}

const RUNTIME_DEPENDENCIES = {
  node: {
    id: 'node',
    name: 'Node.js',
    kind: 'runtime',
    command: 'node',
    versionRange: '26.x',
    requiredFor: 'running Invoker packages and the CLI',
    required: true,
    installHint: 'install Node.js 26.x',
  },
} as const satisfies Record<string, RuntimeDependency>;

const TOOL_DEPENDENCIES = {
  git: {
    id: 'git',
    name: 'Git',
    kind: 'tool',
    command: 'git',
    requiredFor: 'repo checkout, branches, merges',
    required: true,
    installHint: 'brew install git (or apt-get install git)',
  },
  pnpm: {
    id: 'pnpm',
    name: 'pnpm',
    kind: 'tool',
    command: 'pnpm',
    version: '10.31.0',
    requiredFor: 'workspace installs and builds',
    required: true,
    installHint: 'npm install -g pnpm',
  },
  gh: {
    id: 'gh',
    name: 'GitHub CLI',
    kind: 'tool',
    command: 'gh',
    requiredFor: 'GitHub PR and release flows',
    installHint: 'brew install gh',
  },
  docker: {
    id: 'docker',
    name: 'Docker',
    kind: 'tool',
    command: 'docker',
    requiredFor: 'container executors',
    installHint: 'brew install docker',
  },
  ssh: {
    id: 'ssh',
    name: 'OpenSSH',
    kind: 'tool',
    command: 'ssh',
    requiredFor: 'remote SSH executors',
    installHint: 'apt-get install openssh-client',
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    kind: 'tool',
    command: 'codex',
    requiredFor: 'codex presets',
    installHint: 'npm install -g @openai/codex',
  },
  claude: {
    id: 'claude',
    name: 'Claude CLI',
    kind: 'tool',
    command: 'claude',
    requiredFor: 'claude-model presets',
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor Agent',
    kind: 'tool',
    command: 'cursor',
    requiredFor: 'cursor presets',
    installHint: 'install Cursor, then enable the agent CLI',
  },
  omp: {
    id: 'omp',
    name: 'omp',
    kind: 'tool',
    command: 'omp',
    requiredFor: 'omp presets',
    installHint: 'install the omp CLI',
  },
} as const satisfies Record<string, ToolDependency>;

const MCP_DEPENDENCIES = {
  drafterMcp: {
    id: 'drafter-mcp',
    name: 'Drafter MCP',
    kind: 'python-mcp',
    packageName: 'drafter-mcp',
    version: '0.1.0',
    commandName: 'drafter-mcp',
    runner: 'uvx',
    configEnvVar: 'INVOKER_MCP_CONFIG_PATH',
    requiredFor: 'conversation-to-plan splitting through the planner MCP',
    installHint: 'uvx --from drafter-mcp==0.1.0 drafter-mcp',
  },
} as const satisfies Record<string, PythonMcpDependency>;

export const EXTERNAL_DEPENDENCIES = {
  ...RUNTIME_DEPENDENCIES,
  ...TOOL_DEPENDENCIES,
  ...MCP_DEPENDENCIES,
} as const;

export const DEFAULT_TOOL_REQUIREMENTS: ToolRequirement[] = Object.values(TOOL_DEPENDENCIES).map((dependency) => ({
  id: dependency.id,
  name: dependency.name,
  command: dependency.command,
  requiredFor: dependency.requiredFor,
  required: 'required' in dependency ? dependency.required : undefined,
  installHint: dependency.installHint,
}));

export const DEFAULT_DRAFTER_MCP_PACKAGE_SPEC = `${EXTERNAL_DEPENDENCIES.drafterMcp.packageName}==${EXTERNAL_DEPENDENCIES.drafterMcp.version}`;
