import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  assembleReadinessChecks,
  buildReport,
  formatReport,
  DEFAULT_TOOL_REQUIREMENTS,
  type IsInstalled,
  type PlanningPresetSpec,
  type PrerequisiteCheck,
} from '@invoker/contracts';

// ── Paths ────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

const EXPERIMENTAL_PLANNER_SERVER_KEY = 'experimental-planner';
const EXPERIMENTAL_PLANNER_SERVER_SPEC = { type: 'stdio', command: 'uvx', args: ['invoker-planner-redirect'] } as const;

export function invokerHomeDir(): string {
  return join(homedir(), '.invoker');
}
export function defaultConfigPath(): string {
  return process.env.INVOKER_REPO_CONFIG_PATH ?? join(invokerHomeDir(), 'config.json');
}
export function envFilePath(): string {
  return join(invokerHomeDir(), '.env');
}
export function manifestFilePath(): string {
  return join(invokerHomeDir(), 'slack-app-manifest.json');
}
export function experimentalPlannerMcpPath(): string {
  return join(homedir(), '.omp', 'agent', 'mcp.json');
}

// ── Tool probing & install ───────────────────────────────────

export function commandExists(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${command} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

const INSTALL_SPECS: Record<string, { brew?: string[]; apt?: string[]; npm?: string[] }> = {
  git: { brew: ['git'], apt: ['git'] },
  pnpm: { npm: ['pnpm'] },
  gh: { brew: ['gh'], apt: ['gh'] },
  docker: { brew: ['docker'], apt: ['docker.io'] },
  ssh: { apt: ['openssh-client'] },
  codex: { npm: ['@openai/codex'] },
  claude: { npm: ['@anthropic-ai/claude-code'] },
};

/** Best-effort install of a tool by check id; returns the command attempted, or undefined when unsupported. */
export function installTool(id: string): string | undefined {
  const spec = INSTALL_SPECS[id];
  if (!spec) return undefined;
  const run = (cmd: string, args: string[]) => (spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1) === 0;
  if (process.platform === 'darwin' && commandExists('brew') && spec.brew?.length) {
    return run('brew', ['install', ...spec.brew]) ? `brew install ${spec.brew.join(' ')}` : undefined;
  }
  if (process.platform === 'linux' && commandExists('apt-get') && spec.apt?.length) {
    const sudo = typeof process.getuid === 'function' && process.getuid() === 0 ? [] : commandExists('sudo') ? ['sudo'] : null;
    if (sudo) return run(sudo[0] ?? 'apt-get', [...(sudo[0] ? ['apt-get'] : []), 'install', '-y', ...spec.apt]) ? `apt-get install ${spec.apt.join(' ')}` : undefined;
  }
  if (commandExists('npm') && spec.npm?.length) {
    return run('npm', ['install', '-g', ...spec.npm]) ? `npm install -g ${spec.npm.join(' ')}` : undefined;
  }
  return undefined;
}

// ── Config ───────────────────────────────────────────────────

export interface CliConfigState {
  path: string;
  exists: boolean;
  error?: string;
  presets: Record<string, PlanningPresetSpec>;
  defaultPreset?: string;
}

export function loadCliConfig(configPath: string = defaultConfigPath()): CliConfigState {
  if (!existsSync(configPath)) return { path: configPath, exists: false, presets: {} };
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
      slackHarnessPresets?: Record<string, PlanningPresetSpec>;
      defaultSlackHarnessPreset?: string;
    };
    return { path: configPath, exists: true, presets: cfg.slackHarnessPresets ?? {}, defaultPreset: cfg.defaultSlackHarnessPreset };
  } catch (err) {
    return { path: configPath, exists: true, error: err instanceof Error ? err.message : String(err), presets: {} };
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMutableJson(filePath: string, fallback: JsonRecord): JsonRecord {
  if (!existsSync(filePath)) return { ...fallback };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (isJsonRecord(parsed)) return parsed;
  } catch {
    // Throw the same public error for invalid JSON and non-object JSON.
  }
  throw new Error(`Invalid JSON object at ${filePath}`);
}

function isExperimentalPlannerServer(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  return value.type === EXPERIMENTAL_PLANNER_SERVER_SPEC.type
    && value.command === EXPERIMENTAL_PLANNER_SERVER_SPEC.command
    && Array.isArray(value.args)
    && value.args.length === EXPERIMENTAL_PLANNER_SERVER_SPEC.args.length
    && value.args.every((arg, index) => arg === EXPERIMENTAL_PLANNER_SERVER_SPEC.args[index]);
}

export interface ExperimentalPlannerSetupOptions {
  targetPath?: string;
  configPath?: string;
  plannerUrl?: string;
  accessToken?: string;
  uninstall?: boolean;
}

export interface ExperimentalPlannerSetupState {
  targetPath: string;
  configPath: string;
  installed: boolean;
  experimentalPlanner: boolean;
}

export function setExperimentalPlannerFlag(enabled: boolean, configPath: string = defaultConfigPath()): string {
  const config = readMutableJson(configPath, {});
  config.experimentalPlanner = enabled;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

export function readExperimentalPlannerSetup(options: ExperimentalPlannerSetupOptions = {}): ExperimentalPlannerSetupState {
  const targetPath = options.targetPath ?? experimentalPlannerMcpPath();
  const configPath = options.configPath ?? defaultConfigPath();
  const invokerConfig = existsSync(configPath) ? readMutableJson(configPath, {}) : {};
  const mcpConfig = existsSync(targetPath) ? readMutableJson(targetPath, {}) : {};
  const servers = isJsonRecord(mcpConfig.mcpServers) ? mcpConfig.mcpServers : {};
  return {
    targetPath,
    configPath,
    installed: isExperimentalPlannerServer(servers[EXPERIMENTAL_PLANNER_SERVER_KEY]),
    experimentalPlanner: Boolean(invokerConfig.experimentalPlanner),
  };
}

export function installExperimentalPlannerMcp(options: ExperimentalPlannerSetupOptions = {}): ExperimentalPlannerSetupState {
  const targetPath = options.targetPath ?? experimentalPlannerMcpPath();
  const configPath = options.configPath ?? defaultConfigPath();
  const mcpConfig = readMutableJson(targetPath, { $schema: 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json' });
  const existingServers = isJsonRecord(mcpConfig.mcpServers) ? mcpConfig.mcpServers : {};
  const servers: JsonRecord = { ...existingServers };

  if (options.uninstall) {
    delete servers[EXPERIMENTAL_PLANNER_SERVER_KEY];
  } else {
    const env: JsonRecord = {};
    if (options.plannerUrl) env.PLANNER_URL = options.plannerUrl;
    if (options.accessToken) env.PLANNER_ACCESS_TOKEN = options.accessToken;
    servers[EXPERIMENTAL_PLANNER_SERVER_KEY] = Object.keys(env).length > 0
      ? { ...EXPERIMENTAL_PLANNER_SERVER_SPEC, env }
      : { ...EXPERIMENTAL_PLANNER_SERVER_SPEC };
  }

  mcpConfig.mcpServers = servers;
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
  setExperimentalPlannerFlag(!options.uninstall, configPath);
  return readExperimentalPlannerSetup({ targetPath, configPath });
}

export function buildDoctorChecks(cfg: CliConfigState, isInstalled: IsInstalled = commandExists): PrerequisiteCheck[] {
  return assembleReadinessChecks({
    tools: DEFAULT_TOOL_REQUIREMENTS,
    isInstalled,
    config: { path: cfg.path, exists: cfg.exists, error: cfg.error },
    presets: cfg.presets,
    defaultPreset: cfg.defaultPreset,
  });
}

// ── doctor command ───────────────────────────────────────────

export function runDoctor(argv: string[]): number {
  let fix = false;
  let json = false;
  for (const arg of argv) {
    if (arg === '--fix') fix = true;
    else if (arg === '--json') json = true;
    else throw new Error(`Unknown doctor option: ${arg}`);
  }

  let checks = buildDoctorChecks(loadCliConfig());
  if (fix) {
    for (const check of checks) {
      if (check.status !== 'ok' && INSTALL_SPECS[check.id]) installTool(check.id);
    }
    checks = buildDoctorChecks(loadCliConfig());
  }

  const report = buildReport(checks);
  process.stdout.write(`${formatReport(report, { json })}\n`);
  if (!json && !report.ok) {
    process.stdout.write('\nFix the items above, then re-run `invoker-cli doctor`. For planner MCP, run `invoker-cli setup planner`; for Slack, run `invoker-cli setup slack`.\n');
  }
  return report.ok ? 0 : 1;
}

// ── Slack manifest ───────────────────────────────────────────

export const REQUIRED_BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'channels:history',
  'groups:write',
  'groups:history',
  'users:read',
] as const;

export interface SlackAppManifest {
  display_information: { name: string };
  features: {
    bot_user: { display_name: string; always_online: boolean };
    slash_commands?: { command: string; description: string; usage_hint?: string; should_escape?: boolean }[];
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { bot_events: string[] };
    interactivity: { is_enabled: boolean };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export function generateSlackManifest(name = 'Invoker'): SlackAppManifest {
  return {
    display_information: { name },
    features: {
      bot_user: { display_name: name, always_online: true },
      slash_commands: [
        {
          command: '/invoker',
          description: 'Invoker workflow commands',
          usage_hint: '<status|recreate|rebase|retry|cancel|submit> [all|<workflow>]',
          should_escape: false,
        },
      ],
    },
    oauth_config: { scopes: { bot: [...REQUIRED_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: ['app_mention'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

// ── Slack credential validation ──────────────────────────────

export interface SlackCredentials {
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  channelId?: string;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  json: () => Promise<any>;
  headers: { get: (name: string) => string | null };
}>;

/** Validate Slack credentials against the live Web API. `fetchImpl` is injectable for tests. */
export async function validateSlackCredentials(
  creds: SlackCredentials,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<PrerequisiteCheck[]> {
  const checks: PrerequisiteCheck[] = [];

  if (!creds.botToken) {
    checks.push({ id: 'slack-bot-token', name: 'Bot token', status: 'error', detail: 'SLACK_BOT_TOKEN is not set', remediation: 'Paste the xoxb- bot token from OAuth & Permissions' });
  } else {
    const res = await fetchImpl('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${creds.botToken}` } });
    const body = await res.json();
    if (body.ok) {
      checks.push({ id: 'slack-bot-token', name: 'Bot token', status: 'ok', detail: `Authenticated as ${body.user} in ${body.team}` });
      const granted = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const missing = REQUIRED_BOT_SCOPES.filter((s) => !granted.includes(s));
      checks.push(missing.length === 0
        ? { id: 'slack-scopes', name: 'Bot scopes', status: 'ok', detail: 'All required scopes granted' }
        : { id: 'slack-scopes', name: 'Bot scopes', status: 'error', detail: `Missing scopes: ${missing.join(', ')}`, remediation: 'Add the scopes in OAuth & Permissions, then Reinstall to Workspace to activate them' });
    } else {
      checks.push({ id: 'slack-bot-token', name: 'Bot token', status: 'error', detail: `auth.test failed: ${body.error}`, remediation: 'Recheck the xoxb- token; reinstall the app if it was revoked' });
    }
  }

  if (!creds.appToken) {
    checks.push({ id: 'slack-app-token', name: 'App token', status: 'error', detail: 'SLACK_APP_TOKEN is not set', remediation: 'Create an app-level token with connections:write (Basic Information)' });
  } else {
    const res = await fetchImpl('https://slack.com/api/apps.connections.open', { method: 'POST', headers: { Authorization: `Bearer ${creds.appToken}` } });
    const body = await res.json();
    checks.push(body.ok
      ? { id: 'slack-app-token', name: 'App token', status: 'ok', detail: 'Socket Mode connection authorized' }
      : { id: 'slack-app-token', name: 'App token', status: 'error', detail: `apps.connections.open failed: ${body.error}`, remediation: 'Recheck the xapp- token; it needs the connections:write scope' });
  }

  checks.push(creds.signingSecret
    ? { id: 'slack-signing-secret', name: 'Signing secret', status: 'ok', detail: 'Present' }
    : { id: 'slack-signing-secret', name: 'Signing secret', status: 'warn', detail: 'SLACK_SIGNING_SECRET is not set', remediation: 'Copy it from Basic Information > App Credentials' });

  if (creds.channelId && creds.botToken) {
    const res = await fetchImpl(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(creds.channelId)}`, { headers: { Authorization: `Bearer ${creds.botToken}` } });
    const body = await res.json();
    checks.push(body.ok
      ? { id: 'slack-channel', name: 'Lobby channel', status: 'ok', detail: `#${body.channel?.name ?? creds.channelId}` }
      : { id: 'slack-channel', name: 'Lobby channel', status: body.error === 'channel_not_found' ? 'error' : 'warn', detail: `conversations.info: ${body.error}`, remediation: 'Invite the bot to the lobby channel and use its channel ID (starts with C)' });
  } else if (!creds.channelId) {
    checks.push({ id: 'slack-channel', name: 'Lobby channel', status: 'error', detail: 'SLACK_CHANNEL_ID is not set', remediation: 'Use the lobby channel ID (starts with C) where you @mention Invoker' });
  }

  return checks;
}

// ── .env writing ─────────────────────────────────────────────

const SLACK_ENV_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_CHANNEL_ID'] as const;

/** Upsert KEY=VALUE pairs into existing .env content, preserving unrelated lines. */
export function upsertEnvLines(existing: string, values: Record<string, string>): string {
  const keys = new Set(Object.keys(values));
  const kept = existing
    .split('\n')
    .filter((line) => {
      const eq = line.indexOf('=');
      return eq === -1 ? line.trim() !== '' || false : !keys.has(line.slice(0, eq).trim());
    });
  const added = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  return [...kept.filter((l) => l.trim() !== ''), ...added].join('\n') + '\n';
}

export function writeSlackEnv(creds: Required<Pick<SlackCredentials, 'botToken' | 'appToken' | 'signingSecret' | 'channelId'>>): string {
  const path = envFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = upsertEnvLines(existing, {
    SLACK_BOT_TOKEN: creds.botToken,
    SLACK_APP_TOKEN: creds.appToken,
    SLACK_SIGNING_SECRET: creds.signingSecret,
    SLACK_CHANNEL_ID: creds.channelId,
  });
  writeFileSync(path, next, { mode: 0o600 });
  return path;
}

// ── setup command ────────────────────────────────────────────

export interface SetupIO {
  print: (line: string) => void;
  prompt: (question: string) => Promise<string>;
}

function defaultIO(): SetupIO & { rl: ReturnType<typeof createInterface> } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    rl,
    print: (line) => process.stdout.write(`${line}\n`),
    prompt: async (q) => (await rl.question(q)).trim(),
  };
}

function manifestSteps(manifestPath: string): string {
  return [
    'Slack app setup (guided):',
    `  1. A manifest was written to ${manifestPath}`,
    '  2. Open https://api.slack.com/apps → Create New App → From a manifest',
    '  3. Pick your workspace, paste the manifest JSON, and create the app',
    '  4. Install to Workspace (OAuth & Permissions) → copy the Bot User OAuth Token (xoxb-...)',
    '  5. Basic Information → App-Level Tokens → Generate a token with connections:write → copy it (xapp-...)',
    '  6. Basic Information → App Credentials → copy the Signing Secret',
    '  7. Invite the bot to your lobby channel and copy that channel ID (starts with C)',
    '',
    'After adding scopes you MUST click "Reinstall to Workspace" or the tokens stay stale.',
  ].join('\n');
}

/** Read Slack credentials from the environment (after .env load) for non-interactive checks. */
export function slackCredsFromEnv(): SlackCredentials {
  return {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    channelId: process.env.SLACK_CHANNEL_ID,
  };
}

/** Apply KEY=VALUE pairs from a dotenv-style file to process.env without overriding existing vars. */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Load secrets from ~/.invoker/.env (canonical) then <cwd>/.env (fallback), mirroring the app's
 * startup loader, so `setup slack --check` validates the saved file. Existing env vars always win.
 */
export function loadInvokerEnv(): void {
  loadEnvFile(envFilePath());
  loadEnvFile(join(process.cwd(), '.env'));
}

type SetupSubcommand = 'slack' | 'planner';

interface ParsedSetupArgs {
  subcommand?: SetupSubcommand;
  checkOnly: boolean;
  json: boolean;
  uninstall: boolean;
  targetPath?: string;
  plannerUrl?: string;
  accessToken?: string;
}

function parseSetupArgs(argv: string[]): ParsedSetupArgs {
  const parsed: ParsedSetupArgs = { checkOnly: false, json: false, uninstall: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'slack' || arg === 'planner') {
      if (parsed.subcommand) throw new Error(`Unexpected setup argument: ${arg}`);
      parsed.subcommand = arg;
    } else if (arg === '--check') {
      parsed.checkOnly = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--uninstall') {
      parsed.uninstall = true;
    } else if (arg === '--target') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --target');
      parsed.targetPath = value;
    } else if (arg === '--planner-url') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --planner-url');
      parsed.plannerUrl = value;
    } else if (arg === '--access-token') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --access-token');
      parsed.accessToken = value;
    } else {
      throw new Error(`Unknown setup option: ${arg}`);
    }
  }
  return parsed;
}

function formatExperimentalPlannerState(state: ExperimentalPlannerSetupState, json: boolean): string {
  if (json) return JSON.stringify(state);
  return [
    `Experimental planner MCP: ${state.installed ? 'installed' : 'missing'}`,
    `MCP config: ${state.targetPath}`,
    `experimentalPlanner flag: ${state.experimentalPlanner ? 'on' : 'off'}`,
    `Invoker config: ${state.configPath}`,
  ].join('\n');
}

async function maybeInstallPlanner(parsed: ParsedSetupArgs, io: SetupIO): Promise<number> {
  if (parsed.checkOnly) {
    const state = readExperimentalPlannerSetup({ targetPath: parsed.targetPath });
    io.print(formatExperimentalPlannerState(state, parsed.json));
    return state.installed && state.experimentalPlanner ? 0 : 1;
  }

  const state = installExperimentalPlannerMcp({
    targetPath: parsed.targetPath,
    plannerUrl: parsed.plannerUrl,
    accessToken: parsed.accessToken ?? process.env.PLANNER_ACCESS_TOKEN,
    uninstall: parsed.uninstall,
  });
  if (parsed.json) {
    io.print(JSON.stringify(state));
  } else if (parsed.uninstall) {
    io.print(`Removed experimental planner MCP from ${state.targetPath}.`);
    io.print(`Disabled experimentalPlanner in ${state.configPath}.`);
  } else {
    io.print(`Installed experimental planner MCP into ${state.targetPath}.`);
    io.print(`Enabled experimentalPlanner in ${state.configPath}.`);
    io.print('Restart any running planning agent sessions so they reload MCP tools.');
  }
  return 0;
}

async function promptYes(io: SetupIO, question: string): Promise<boolean> {
  const answer = (await io.prompt(question)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

export async function runSetup(argv: string[], io: SetupIO = defaultIO()): Promise<number> {
  const parsed = parseSetupArgs(argv);
  const wantSlack = parsed.subcommand === 'slack';
  const rl = (io as { rl?: { close: () => void } }).rl;
  try {
    if (parsed.subcommand === 'planner') {
      return await maybeInstallPlanner(parsed, io);
    }

    if (parsed.checkOnly) {
      loadInvokerEnv();
      const checks = await validateSlackCredentials(slackCredsFromEnv());
      const report = buildReport(checks);
      io.print(formatReport(report, { json: parsed.json }));
      return report.ok ? 0 : 1;
    }

    io.print('Invoker setup\n');
    const core = buildReport(buildDoctorChecks(loadCliConfig()));
    io.print(formatReport(core));
    io.print('');

    if (!wantSlack && await promptYes(io, 'Set up the experimental planner MCP now? [y/N] ')) {
      await maybeInstallPlanner(parsed, io);
      io.print('');
    }

    let doSlack = wantSlack;
    if (!wantSlack) {
      doSlack = await promptYes(io, 'Set up the Slack integration now? [y/N] ');
    }
    if (!doSlack) {
      io.print('\nYou are good to go for CLI and UI workflows. Run `invoker-cli setup planner` to add the experimental planner, or `invoker-cli setup slack` to add Slack.');
      return core.ok ? 0 : 1;
    }

    const manifestPath = manifestFilePath();
    mkdirSync(invokerHomeDir(), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(generateSlackManifest(), null, 2)}\n`);
    io.print(`\n${manifestSteps(manifestPath)}\n`);

    const botToken = await io.prompt('Bot User OAuth Token (xoxb-...): ');
    const appToken = await io.prompt('App-Level Token (xapp-...): ');
    const signingSecret = await io.prompt('Signing Secret: ');
    const channelId = await io.prompt('Lobby channel ID (C...): ');

    const checks = await validateSlackCredentials({ botToken, appToken, signingSecret, channelId });
    const report = buildReport(checks);
    io.print(`\n${formatReport(report)}`);

    if (!report.ok) {
      const proceed = await promptYes(io, '\nSome checks failed. Save these values anyway? [y/N] ');
      if (!proceed) {
        io.print('Nothing written. Fix the items above and re-run `invoker-cli setup slack`.');
        return 1;
      }
    }

    const envPath = writeSlackEnv({ botToken, appToken, signingSecret, channelId });
    io.print(`\nWrote Slack credentials to ${envPath}. Restart Invoker (or it picks them up on next launch).`);
    return report.ok ? 0 : 1;
  } finally {
    rl?.close();
  }
}
