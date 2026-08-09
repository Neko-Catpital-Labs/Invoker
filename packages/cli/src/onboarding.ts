import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  addRemoteTarget,
  assembleReadinessChecks,
  buildReport,
  checkRemoteTargetConnectivity,
  DEFAULT_DRAFTER_MCP_PACKAGE_SPEC,
  DEFAULT_TOOL_REQUIREMENTS,
  EXTERNAL_DEPENDENCIES,
  formatReport,
  readInvokerConfigFile,
  resolveRepoRoot,
  type RemoteTargetConnectivityImpl,
  type RemoteTargetInput,
  type IsInstalled,
  type PlanningPresetSpec,
  type PrerequisiteCheck,
  updateInvokerConfigFile,
  writeInvokerConfigFile,
} from '@invoker/contracts';
import { commandExists } from '@invoker/shell';
import { parsePlanFile } from '@invoker/workflow-core';
import { formatCaughtException, logCaughtException } from './logging.js';
import { installBundledSkills } from './bundled-skills.js';
import { runRemoteDoctorChecks } from './remote-doctor.js';
import { applyWorkerToggle, ONBOARDING_WORKER_TOGGLES, readWorkerToggleValue } from './worker-toggles.js';

// ── Paths ────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

const EXPERIMENTAL_PLANNER_SERVER_KEY = 'experimental-planner';
const EXPERIMENTAL_PLANNER_PACKAGE_NAME = DEFAULT_DRAFTER_MCP_PACKAGE_SPEC;
const EXPERIMENTAL_PLANNER_COMMAND_NAME = EXTERNAL_DEPENDENCIES.drafterMcp.commandName;
function experimentalPlannerServerSpec(packageSpec: string = EXPERIMENTAL_PLANNER_PACKAGE_NAME): JsonRecord {
  return {
    type: 'stdio',
    command: 'uvx',
    args: ['--from', packageSpec, EXPERIMENTAL_PLANNER_COMMAND_NAME],
  };
}

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
export function defaultExperimentalPlannerMcpPath(configPath: string = defaultConfigPath()): string {
  return join(dirname(configPath), 'mcp.json');
}

export function experimentalPlannerMcpPath(configPath: string = defaultConfigPath()): string {
  return process.env.INVOKER_MCP_CONFIG_PATH ?? defaultExperimentalPlannerMcpPath(configPath);
}

function resolveExperimentalPlannerMcpPath(targetPath: string | undefined, configPath: string): string {
  return targetPath ?? experimentalPlannerMcpPath(configPath);
}

// ── Tool probing & install ───────────────────────────────────

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
  contents?: JsonRecord;
}

export function loadCliConfig(configPath: string = defaultConfigPath()): CliConfigState {
  if (!existsSync(configPath)) return { path: configPath, exists: false, presets: {} };
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
      slackHarnessPresets?: Record<string, PlanningPresetSpec>;
      defaultSlackHarnessPreset?: string;
    };
    return {
      path: configPath,
      exists: true,
      presets: cfg.slackHarnessPresets ?? {},
      defaultPreset: cfg.defaultSlackHarnessPreset,
      contents: cfg as JsonRecord,
    };
  } catch (err) {
    logCaughtException(`Failed to read Invoker config at ${configPath}`, err);
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
  } catch (err) {
    logCaughtException(`Failed to parse JSON object at ${filePath}`, err);
    throw new Error(`Invalid JSON object at ${filePath}: ${formatCaughtException(err)}`);
  }
  throw new Error(`Invalid JSON object at ${filePath}`);
}

function mutableMcpServers(mcpConfig: JsonRecord, targetPath: string): JsonRecord {
  if (mcpConfig.mcpServers === undefined) return {};
  if (!isJsonRecord(mcpConfig.mcpServers)) {
    throw new Error(`Invalid mcpServers object at ${targetPath}`);
  }
  return mcpConfig.mcpServers;
}

function isExperimentalPlannerServer(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  const args = value.args;
  return value.type === 'stdio'
    && value.command === 'uvx'
    && Array.isArray(args)
    && args.length === 3
    && args[0] === '--from'
    && typeof args[1] === 'string'
    && args[2] === EXPERIMENTAL_PLANNER_COMMAND_NAME;
}

export interface ExperimentalPlannerSetupOptions {
  targetPath?: string;
  configPath?: string;
  plannerUrl?: string;
  accessToken?: string;
  uninstall?: boolean;
  plannerPackage?: string;
}

export interface ExperimentalPlannerSetupState {
  targetPath: string;
  configPath: string;
  installed: boolean;
  experimentalPlanner: boolean;
}

export function setExperimentalPlannerFlag(enabled: boolean, configPath: string = defaultConfigPath()): string {
  return updateInvokerConfigFile(configPath, (config) => {
    config.experimentalPlanner = enabled;
  });
}

export function readExperimentalPlannerSetup(options: ExperimentalPlannerSetupOptions = {}): ExperimentalPlannerSetupState {
  const configPath = options.configPath ?? defaultConfigPath();
  const targetPath = resolveExperimentalPlannerMcpPath(options.targetPath, configPath);
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

function writeExperimentalPlannerMcpEntry(options: ExperimentalPlannerSetupOptions = {}): ExperimentalPlannerSetupState {
  const configPath = options.configPath ?? defaultConfigPath();
  const targetPath = resolveExperimentalPlannerMcpPath(options.targetPath, configPath);
  const mcpConfig = readMutableJson(targetPath, { $schema: 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json' });
  const existingServers = mutableMcpServers(mcpConfig, targetPath);
  const servers: JsonRecord = { ...existingServers };

  if (options.uninstall) {
    delete servers[EXPERIMENTAL_PLANNER_SERVER_KEY];
  } else {
    const env: JsonRecord = {};
    if (options.plannerUrl) env.PLANNER_URL = options.plannerUrl;
    if (options.accessToken) env.PLANNER_ACCESS_TOKEN = options.accessToken;
    const spec = experimentalPlannerServerSpec(options.plannerPackage);
    servers[EXPERIMENTAL_PLANNER_SERVER_KEY] = Object.keys(env).length > 0 ? { ...spec, env } : spec;
  }

  mcpConfig.mcpServers = servers;
  mkdirSync(dirname(targetPath), { recursive: true });
  const writesPlannerAccessToken = Boolean(options.accessToken);
  if (writesPlannerAccessToken && existsSync(targetPath)) chmodSync(targetPath, 0o600);
  writeFileSync(targetPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, writesPlannerAccessToken ? { mode: 0o600 } : undefined);
  if (writesPlannerAccessToken) chmodSync(targetPath, 0o600);
  return readExperimentalPlannerSetup({ targetPath, configPath });
}

export function ensureExperimentalPlannerMcp(options: ExperimentalPlannerSetupOptions = {}): ExperimentalPlannerSetupState {
  return writeExperimentalPlannerMcpEntry(options);
}

export function installExperimentalPlannerMcp(options: ExperimentalPlannerSetupOptions = {}): ExperimentalPlannerSetupState {
  const state = writeExperimentalPlannerMcpEntry(options);
  setExperimentalPlannerFlag(!options.uninstall, state.configPath);
  return readExperimentalPlannerSetup({ targetPath: state.targetPath, configPath: state.configPath });
}

export function buildDoctorChecks(cfg: CliConfigState, isInstalled: IsInstalled = commandExists): PrerequisiteCheck[] {
  return assembleReadinessChecks({
    tools: DEFAULT_TOOL_REQUIREMENTS,
    isInstalled,
    config: { path: cfg.path, exists: cfg.exists, error: cfg.error },
    configContents: cfg.contents,
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

// ── setup readiness extras (GitHub auth + smoke + oneshot ending) ─

export interface CommandRunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}

export type CommandRunner = (command: string, args: readonly string[]) => CommandRunnerResult;

export function defaultCommandRunner(command: string, args: readonly string[]): CommandRunnerResult {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  };
}

export function skippedGithubAuthCheck(): PrerequisiteCheck {
  return {
    id: 'github-auth',
    name: 'GitHub auth',
    status: 'warn',
    detail: 'gh not installed; skipped auth check',
    remediation: 'Install GitHub CLI (`brew install gh` or `apt-get install gh`), then run `gh auth login`',
  };
}

/** Probe `gh auth status`. Injectable `runner` keeps tests offline. */
export function checkGithubAuth(runner: CommandRunner = defaultCommandRunner): PrerequisiteCheck {
  let result: CommandRunnerResult;
  try {
    result = runner('gh', ['auth', 'status']);
  } catch (error) {
    if (isMissingCommandError(error)) return skippedGithubAuthCheck();
    return {
      id: 'github-auth',
      name: 'GitHub auth',
      status: 'error',
      detail: formatCaughtException(error),
      remediation: 'Run `gh auth login` and re-run `invoker-cli setup`',
    };
  }
  if (commandRunnerResultIsMissing(result)) return skippedGithubAuthCheck();
  if (result.status === 0) {
    return {
      id: 'github-auth',
      name: 'GitHub auth',
      status: 'ok',
      detail: 'gh is authenticated',
    };
  }
  const detail = (result.stderr || result.stdout || 'gh auth status failed').trim().split('\n')[0]
    || 'gh auth status failed';
  return {
    id: 'github-auth',
    name: 'GitHub auth',
    status: 'error',
    detail,
    remediation: 'Run `gh auth login` and re-run `invoker-cli setup`',
  };
}

function isMissingCommandError(error: unknown): boolean {
  const code = isJsonRecord(error) && typeof error.code === 'string' ? error.code : undefined;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return code === 'ENOENT'
    || /\bENOENT\b|command not found|\bgh(?::|\b).*not found|no such file or directory/i.test(message);
}

function commandRunnerResultIsMissing(result: CommandRunnerResult): boolean {
  if (isMissingCommandError(result.error)) return true;
  const output = `${result.stderr}\n${result.stdout}`;
  return (result.status === null || result.status === 127)
    && /command not found|\bgh(?::|\b).*not found|no such file or directory|\bENOENT\b/i.test(output);
}

const SETUP_SMOKE_PLAN = `name: Setup Smoke
description: Tiny offline plan used by invoker-cli setup.
repoUrl: .
onFinish: none
tasks:
  - id: smoke
    description: Validate plan parsing during setup.
    command: echo setup-smoke
`;
const SETUP_SMOKE_CHECK_NAME = 'smoke: plan validation';

/** Parse a one-task temp plan with no network. Confirms the local plan pipeline works. */
export async function runPlanValidationSmoke(): Promise<PrerequisiteCheck> {
  const dir = mkdtempSync(join(tmpdir(), 'invoker-setup-smoke-'));
  const planPath = join(dir, 'smoke.yaml');
  try {
    writeFileSync(planPath, SETUP_SMOKE_PLAN);
    const plan = await parsePlanFile(planPath);
    if (!plan.tasks.length) {
      return {
        id: 'smoke-plan',
        name: SETUP_SMOKE_CHECK_NAME,
        status: 'error',
        detail: 'Parsed plan has no tasks',
        remediation: 'Reinstall invoker-cli; plan parsing returned an empty task list',
      };
    }
    return {
      id: 'smoke-plan',
      name: SETUP_SMOKE_CHECK_NAME,
      status: 'ok',
      detail: `Parsed ${plan.tasks.length} task(s) from a local smoke plan`,
    };
  } catch (error) {
    return {
      id: 'smoke-plan',
      name: SETUP_SMOKE_CHECK_NAME,
      status: 'error',
      detail: formatCaughtException(error),
      remediation: 'Reinstall invoker-cli or report a plan-parser regression',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** First hard failure — the single thing setup tells the user to fix. */
export function firstSetupFailure(checks: readonly PrerequisiteCheck[]): PrerequisiteCheck | undefined {
  return checks.find((check) => check.status === 'error');
}

export function formatSetupEnding(checks: readonly PrerequisiteCheck[]): string {
  const failure = firstSetupFailure(checks);
  if (!failure) return "You're ready.";
  const remediation = failure.remediation ? ` ${failure.remediation}` : '';
  return `Fix this first: ${failure.name}: ${failure.detail}.${remediation}`;
}

export interface SetupDeps {
  isInstalled?: IsInstalled;
  commandRunner?: CommandRunner;
  githubAuthCheck?: (runner: CommandRunner) => PrerequisiteCheck | Promise<PrerequisiteCheck>;
  smokePlanValidation?: () => Promise<PrerequisiteCheck>;
  remoteTargetConnectivity?: RemoteTargetConnectivityImpl;
  remoteDoctorChecks?: typeof runRemoteDoctorChecks;
  bundledSkillsInstall?: typeof installBundledSkills;
  resolveSkillsRepoRoot?: typeof resolveRepoRoot;
  resolveStandaloneSkillsRoot?: typeof resolveStandaloneSkillsRoot;
}

// ── Slack manifest ───────────────────────────────────────────

export const REQUIRED_BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'files:write',
  'pins:write',
  'channels:history',
  'channels:read',
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
    if (body.ok) {
      checks.push({ id: 'slack-channel', name: 'Lobby channel', status: 'ok', detail: `#${body.channel?.name ?? creds.channelId}` });
    } else if (body.error === 'missing_scope') {
      checks.push({
        id: 'slack-channel',
        name: 'Lobby channel',
        status: 'error',
        detail: `conversations.info: missing_scope (needed ${body.needed ?? 'channels:read'})`,
        remediation: 'Add channels:read in OAuth & Permissions, then Reinstall to Workspace so the bot token picks up the scope',
      });
    } else {
      checks.push({
        id: 'slack-channel',
        name: 'Lobby channel',
        status: body.error === 'channel_not_found' ? 'error' : 'warn',
        detail: `conversations.info: ${body.error}`,
        remediation: 'Invite the bot to the lobby channel and use its channel ID (starts with C)',
      });
    }
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
  readStdin?: () => Promise<string>;
  interactive?: boolean;
}

export class NonInteractiveSetupError extends Error {
  constructor(question: string) {
    super(
      `Cannot ask "${question.trim()}" because stdin is not a TTY.\n`
      + 'Re-run with --yes to accept the guided defaults, or use a non-interactive path: '
      + '`invoker-cli setup planner`, `invoker-cli setup machines --json`, or '
      + '`invoker-cli setup slack --from-env` with SLACK_* set.',
    );
    this.name = 'NonInteractiveSetupError';
  }
}

function defaultIO(): SetupIO & { rl: ReturnType<typeof createInterface> } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    rl,
    interactive: Boolean(process.stdin.isTTY),
    print: (line) => process.stdout.write(`${line}\n`),
    prompt: async (q) => (await rl.question(q)).trim(),
  };
}

function askLine(io: SetupIO, question: string): Promise<string> {
  if (io.interactive === false) throw new NonInteractiveSetupError(question);
  return io.prompt(question);
}

async function readAllStdin(io: SetupIO): Promise<string> {
  if (io.readStdin) return io.readStdin();
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
  }
  return input;
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

type SetupSubcommand = 'slack' | 'planner' | 'machines';

interface ParsedSetupArgs {
  subcommand?: SetupSubcommand;
  checkOnly: boolean;
  json: boolean;
  uninstall: boolean;
  targetPath?: string;
  plannerUrl?: string;
  accessToken?: string;
  plannerPackage?: string;
  fromEnv: boolean;
  assumeYes: boolean;
}

function parseSetupArgs(argv: string[]): ParsedSetupArgs {
  const parsed: ParsedSetupArgs = { checkOnly: false, json: false, uninstall: false, fromEnv: false, assumeYes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'slack' || arg === 'planner' || arg === 'machines') {
      if (parsed.subcommand) throw new Error(`Unexpected setup argument: ${arg}`);
      parsed.subcommand = arg;
    } else if (arg === '--check') {
      parsed.checkOnly = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--from-env') {
      parsed.fromEnv = true;
    } else if (arg === '--yes' || arg === '-y') {
      parsed.assumeYes = true;
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
    } else if (arg === '--planner-package') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --planner-package');
      parsed.plannerPackage = value;
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
    plannerPackage: parsed.plannerPackage ?? process.env.INVOKER_PLANNER_PACKAGE,
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

async function promptYes(io: SetupIO, question: string, assumeYes = false): Promise<boolean> {
  if (assumeYes) {
    io.print(`${question}y`);
    return true;
  }
  const answer = (await askLine(io, question)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

interface MachineSetupSuccessResult {
  name: string;
  reachable: boolean;
  written: boolean;
  message: string;
  doctorChecks?: PrerequisiteCheck[];
}

interface MachineSetupErrorResult {
  name?: string;
  reachable?: boolean;
  written: false;
  message: string;
  error: {
    code: string;
    message: string;
    conflictingTargetId?: string;
  };
  doctorChecks?: PrerequisiteCheck[];
}

type MachineSetupResult = MachineSetupSuccessResult | MachineSetupErrorResult;

function parseOptionalPositiveInteger(value: string, fieldName: string, max?: number): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) throw new Error(`${fieldName} must be a positive integer`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new Error(`${fieldName} must be ${max === undefined ? 'a positive integer' : `between 1 and ${max}`}`);
  }
  return parsed;
}

/**
 * Repo URL used only to run the remote doctor's push-credential check
 * (`git ls-remote` on the box) — deliberately not part of `RemoteTargetInput`,
 * so it never gets written into `remoteTargets` config.
 */
function extractRepoUrl(value: unknown): string {
  if (!isJsonRecord(value)) throw new Error('machine must be an object');
  const raw = value.repoUrl;
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('repoUrl is required');
  return raw.trim();
}

function normalizeRemoteTargetInput(value: unknown): RemoteTargetInput {
  if (!isJsonRecord(value)) throw new Error('machine must be an object');

  const stringField = (field: keyof RemoteTargetInput): string => {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`${field} is required`);
    return raw.trim();
  };

  const input: RemoteTargetInput = {
    name: stringField('name'),
    host: stringField('host'),
    user: stringField('user'),
    sshKeyPath: stringField('sshKeyPath'),
  };

  if (value.port !== undefined) {
    if (typeof value.port !== 'number' || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) {
      throw new Error('port must be an integer between 1 and 65535');
    }
    input.port = value.port;
  }
  if (value.maxConcurrentTasks !== undefined) {
    if (typeof value.maxConcurrentTasks !== 'number' || !Number.isSafeInteger(value.maxConcurrentTasks) || value.maxConcurrentTasks < 1) {
      throw new Error('maxConcurrentTasks must be a positive integer');
    }
    input.maxConcurrentTasks = value.maxConcurrentTasks;
  }
  if (value.provisionCommand !== undefined) {
    if (typeof value.provisionCommand !== 'string') throw new Error('provisionCommand must be a string');
    const trimmed = value.provisionCommand.trim();
    if (trimmed !== '') input.provisionCommand = trimmed;
  }

  return input;
}

interface RemoteTargetDraft {
  input: RemoteTargetInput;
  repoUrl: string;
}

async function askRemoteTargetInput(io: SetupIO): Promise<RemoteTargetDraft> {
  const name = await askLine(io, 'Machine name: ');
  const host = await askLine(io, 'Host: ');
  const user = await askLine(io, 'User: ');
  const sshKeyPath = await askLine(io, 'SSH key path: ');
  const repoUrl = await askLine(io, 'Repo URL (used to verify this box can push code back): ');
  const port = parseOptionalPositiveInteger(await askLine(io, 'SSH port [22]: '), 'port', 65535);
  const maxConcurrentTasks = parseOptionalPositiveInteger(
    await askLine(io, 'Max concurrent tasks [1]: '),
    'maxConcurrentTasks',
  );
  const provisionCommand = (await askLine(io, 'Provision command (optional): ')).trim();

  const input = normalizeRemoteTargetInput({
    name,
    host,
    user,
    sshKeyPath,
    ...(port !== undefined ? { port } : {}),
    ...(maxConcurrentTasks !== undefined ? { maxConcurrentTasks } : {}),
    ...(provisionCommand !== '' ? { provisionCommand } : {}),
  });

  return { input, repoUrl: extractRepoUrl({ repoUrl }) };
}

async function checkAndMaybeWriteRemoteTarget(
  input: RemoteTargetInput,
  repoUrl: string,
  write: boolean,
  options: SetupDeps,
): Promise<MachineSetupResult> {
  const target = {
    host: input.host,
    user: input.user,
    sshKeyPath: input.sshKeyPath,
    port: input.port,
  };

  const connectivity = await checkRemoteTargetConnectivity(target, { impl: options.remoteTargetConnectivity });

  if (!connectivity.reachable) {
    return {
      name: input.name,
      reachable: false,
      written: false,
      message: connectivity.message,
      error: { code: 'connectivity-failed', message: connectivity.message },
    };
  }

  const runDoctorChecks = options.remoteDoctorChecks ?? runRemoteDoctorChecks;
  const doctorChecks = await runDoctorChecks({ target, repoUrl });
  const failedCheck = doctorChecks.find((check) => check.status === 'error');

  if (failedCheck) {
    const message = `Remote readiness check failed: ${failedCheck.name} — ${failedCheck.detail}`;
    return {
      name: input.name,
      reachable: true,
      written: false,
      message,
      error: { code: 'doctor-check-failed', message },
      doctorChecks,
    };
  }

  if (!write) {
    return {
      name: input.name,
      reachable: true,
      written: false,
      message: connectivity.message,
      doctorChecks,
    };
  }

  return { ...writeRemoteTarget(input), doctorChecks };
}

function writeRemoteTarget(input: RemoteTargetInput): MachineSetupResult {
  const configPath = defaultConfigPath();
  const addResult = addRemoteTarget(readInvokerConfigFile(configPath), input);
  if (!addResult.ok) {
    return {
      name: input.name,
      reachable: true,
      written: false,
      message: addResult.error.message,
      error: addResult.error,
    };
  }

  writeInvokerConfigFile(configPath, addResult.config);
  return {
    name: input.name,
    reachable: true,
    written: true,
    message: `Wrote machine "${input.name}" to ${configPath}`,
  };
}

function formatMachineConnectivity(result: MachineSetupResult): string {
  if (result.reachable) return `Connectivity check passed: ${result.message}`;
  return `Connectivity check failed: ${result.message}`;
}

async function runMachinesSetupInteractive(io: SetupIO, options: SetupDeps): Promise<void> {
  let addAnother = true;
  while (addAnother) {
    let repeatThisMachine = true;
    while (repeatThisMachine) {
      let draft: RemoteTargetDraft;
      try {
        draft = await askRemoteTargetInput(io);
      } catch (error) {
        io.print(`Invalid machine input: ${formatCaughtException(error)}`);
        repeatThisMachine = await promptYes(io, 'Try this machine again? [y/N] ');
        continue;
      }

      const checked = await checkAndMaybeWriteRemoteTarget(draft.input, draft.repoUrl, false, options);
      io.print(formatMachineConnectivity(checked));

      if (!checked.reachable) {
        repeatThisMachine = await promptYes(io, 'Try this machine again? [y/N] ');
        continue;
      }

      if (checked.doctorChecks) {
        io.print('');
        io.print(formatReport(buildReport(checked.doctorChecks)));
      }

      if ('error' in checked && checked.error.code === 'doctor-check-failed') {
        repeatThisMachine = await promptYes(io, 'Try this machine again? [y/N] ');
        continue;
      }

      const keep = await promptYes(io, 'Keep this machine? [y/N] ');
      if (!keep) {
        io.print('Nothing written.');
        repeatThisMachine = await promptYes(io, 'Try this machine again? [y/N] ');
        continue;
      }

      const written = writeRemoteTarget(draft.input);
      if (written.written) {
        io.print(written.message);
      } else {
        io.print(`Nothing written: ${written.message}`);
      }
      repeatThisMachine = false;
    }

    addAnother = await promptYes(io, 'Add another machine? [y/N] ');
  }
}

async function runMachinesSetupJson(io: SetupIO, options: SetupDeps): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readAllStdin(io));
  } catch (error) {
    io.print(JSON.stringify([{
      written: false,
      message: `Invalid JSON input: ${formatCaughtException(error)}`,
      error: { code: 'invalid-json', message: formatCaughtException(error) },
    } satisfies MachineSetupErrorResult]));
    return 1;
  }

  if (!Array.isArray(parsed)) {
    io.print(JSON.stringify([{
      written: false,
      message: 'Invalid JSON input: expected an array',
      error: { code: 'invalid-json', message: 'expected an array' },
    } satisfies MachineSetupErrorResult]));
    return 1;
  }

  const results: MachineSetupResult[] = [];
  for (const item of parsed) {
    let input: RemoteTargetInput;
    let repoUrl: string;
    try {
      input = normalizeRemoteTargetInput(item);
      repoUrl = extractRepoUrl(item);
    } catch (error) {
      results.push({
        written: false,
        message: `Invalid machine input: ${formatCaughtException(error)}`,
        error: { code: 'invalid-input', message: formatCaughtException(error) },
      });
      continue;
    }
    results.push(await checkAndMaybeWriteRemoteTarget(input, repoUrl, true, options));
  }

  io.print(JSON.stringify(results));
  return results.every((result) => result.written) ? 0 : 1;
}

async function runWorkerTogglesInteractive(io: SetupIO, assumeYes: boolean): Promise<void> {
  const configPath = defaultConfigPath();
  let config = readInvokerConfigFile(configPath);
  let changed = false;
  const summary: string[] = [];

  for (const spec of ONBOARDING_WORKER_TOGGLES) {
    io.print(`\n${spec.label}: ${spec.description}`);
    const current = readWorkerToggleValue(config, spec) ?? spec.defaultEnabled ?? false;
    const enable = assumeYes ? current : await promptYes(io, `Enable ${spec.label}? [y/N] `);
    if (enable !== current) {
      config = applyWorkerToggle(config, spec, enable);
      changed = true;
    }
    summary.push(`${spec.label}: ${enable ? 'on' : 'off'}`);
  }

  if (changed) {
    writeInvokerConfigFile(configPath, config);
  }

  io.print('');
  io.print(`Worker toggles — ${summary.join(', ')}`);
}

/**
 * Prefers an Invoker checkout (dev, or a repo clone) reachable from the
 * current directory. The standalone release binary and the npm-cli install
 * both ship a `skills/` directory next to the running executable
 * (scripts/archive-cli-binary.sh, packages/npm-cli/scripts/install.js), so
 * this falls back to that location when `setup` isn't run from a checkout.
 * Fails soft: if neither is found, this skips with a note instead of
 * breaking the rest of `setup`.
 */
function resolveStandaloneSkillsRoot(): string | null {
  let execPath: string;
  try {
    execPath = realpathSync(process.execPath);
  } catch {
    execPath = process.execPath;
  }
  const candidate = dirname(execPath);
  return existsSync(join(candidate, 'skills')) ? candidate : null;
}

function installSetupBundledSkills(io: SetupIO, options: SetupDeps): void {
  const resolveSkillsRepoRoot = options.resolveSkillsRepoRoot ?? resolveRepoRoot;
  const resolveStandaloneRoot = options.resolveStandaloneSkillsRoot ?? resolveStandaloneSkillsRoot;
  const install = options.bundledSkillsInstall ?? installBundledSkills;
  let repoRoot: string;
  try {
    repoRoot = resolveSkillsRepoRoot(process.cwd());
  } catch {
    const standaloneRoot = resolveStandaloneRoot();
    if (!standaloneRoot) {
      io.print('Skills: skipped (not running from an Invoker checkout, and no bundled skills next to this binary).');
      return;
    }
    repoRoot = standaloneRoot;
  }

  try {
    const status = install({ isPackaged: false, repoRoot });
    const installedTargets = status.targets.filter((target) => target.installed).map((target) => target.name);
    const installedMcp = status.mcpTargets.filter((target) => target.installed).map((target) => target.name);
    io.print(`Skills: installed ${status.bundledSkillNames.length} bundled skill(s) for ${installedTargets.join(', ') || 'no targets'}.`);
    io.print(`Skills MCP: registered invoker-cli mcp for ${installedMcp.join(', ') || 'no detected harnesses'}.`);
  } catch (error) {
    io.print(`Skills: install skipped — ${formatCaughtException(error)}`);
  }
}

async function collectGithubAndSmokeChecks(options: SetupDeps): Promise<PrerequisiteCheck[]> {
  const isInstalled = options.isInstalled ?? commandExists;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const runGithubAuth = options.githubAuthCheck ?? checkGithubAuth;
  const runSmokePlanValidation = options.smokePlanValidation ?? (() => runPlanValidationSmoke());

  const checks: PrerequisiteCheck[] = [];
  checks.push(isInstalled('gh') ? await runGithubAuth(commandRunner) : skippedGithubAuthCheck());
  checks.push(await runSmokePlanValidation());
  return checks;
}

function printSetupEnding(io: SetupIO, checks: readonly PrerequisiteCheck[]): number {
  const report = buildReport([...checks]);
  io.print('');
  io.print(formatSetupEnding(report.checks));
  return report.ok ? 0 : 1;
}

export async function runSetup(
  argv: string[],
  io: SetupIO = defaultIO(),
  options: SetupDeps = {},
): Promise<number> {
  const parsed = parseSetupArgs(argv);
  const wantSlack = parsed.subcommand === 'slack';
  const wantMachines = parsed.subcommand === 'machines';
  const fromEnv = parsed.fromEnv;
  const rl = (io as { rl?: { close: () => void } }).rl;
  const isInstalled = options.isInstalled ?? commandExists;
  try {
    if (parsed.subcommand === 'planner') {
      return await maybeInstallPlanner(parsed, io);
    }

    if (wantMachines && parsed.json) {
      return await runMachinesSetupJson(io, options);
    }

    if (wantMachines && parsed.checkOnly) {
      throw new Error('setup machines does not support --check');
    }

    if (parsed.checkOnly) {
      loadInvokerEnv();
      const checks = await validateSlackCredentials(slackCredsFromEnv());
      const report = buildReport(checks);
      io.print(formatReport(report, { json: parsed.json }));
      return report.ok ? 0 : 1;
    }

    io.print('Invoker setup\n');
    const doctorChecks = buildDoctorChecks(loadCliConfig(), isInstalled);
    const checks: PrerequisiteCheck[] = [...doctorChecks];
    io.print(formatReport(buildReport(doctorChecks)));
    io.print('');

    installSetupBundledSkills(io, options);
    io.print('');

    let doSlack = wantSlack || fromEnv;
    if (!wantSlack && !wantMachines && !fromEnv) {
      doSlack = parsed.assumeYes ? false : await promptYes(io, 'Set up the Slack integration now? [y/N] ');
    }

    if (doSlack && fromEnv) {
      loadInvokerEnv();
      const creds = slackCredsFromEnv();
      const slackChecks = await validateSlackCredentials(creds);
      checks.push(...slackChecks);
      const report = buildReport(slackChecks);
      io.print(`\n${formatReport(report, { json: parsed.json })}`);
      if (!creds.botToken || !creds.appToken || !creds.signingSecret || !creds.channelId || !report.ok) {
        io.print('Nothing written.');
        checks.push(...await collectGithubAndSmokeChecks(options));
        return printSetupEnding(io, checks);
      }
      const envPath = writeSlackEnv({
        botToken: creds.botToken,
        appToken: creds.appToken,
        signingSecret: creds.signingSecret,
        channelId: creds.channelId,
      });
      io.print(`\nWrote Slack credentials to ${envPath}. Restart Invoker (or it picks them up on next launch).`);
    } else if (doSlack) {
      const manifestPath = manifestFilePath();
      mkdirSync(invokerHomeDir(), { recursive: true });
      writeFileSync(manifestPath, `${JSON.stringify(generateSlackManifest(), null, 2)}\n`);
      io.print(`\n${manifestSteps(manifestPath)}\n`);

      const botToken = await askLine(io, 'Bot User OAuth Token (xoxb-...): ');
      const appToken = await askLine(io, 'App-Level Token (xapp-...): ');
      const signingSecret = await askLine(io, 'Signing Secret: ');
      const channelId = await askLine(io, 'Lobby channel ID (C...): ');

      const slackChecks = await validateSlackCredentials({ botToken, appToken, signingSecret, channelId });
      checks.push(...slackChecks);
      const report = buildReport(slackChecks);
      io.print(`\n${formatReport(report)}`);

      if (!report.ok) {
        const proceed = await promptYes(io, '\nSome checks failed. Save these values anyway? [y/N] ', parsed.assumeYes);
        if (!proceed) {
          io.print('Nothing written.');
          checks.push(...await collectGithubAndSmokeChecks(options));
          return printSetupEnding(io, checks);
        }
      }

      const envPath = writeSlackEnv({ botToken, appToken, signingSecret, channelId });
      io.print(`\nWrote Slack credentials to ${envPath}. Restart Invoker (or it picks them up on next launch).`);
    }

    let doMachines = wantMachines;
    if (!wantSlack && !wantMachines && !fromEnv) {
      doMachines = parsed.assumeYes ? false : await promptYes(io, 'Set up remote machines now? [y/N] ');
    }
    if (doMachines) {
      await runMachinesSetupInteractive(io, options);
    }

    if (!wantSlack && !wantMachines && !fromEnv) {
      await runWorkerTogglesInteractive(io, parsed.assumeYes);
    }

    const extras = await collectGithubAndSmokeChecks(options);
    checks.push(...extras);
    io.print('');
    io.print(formatReport(buildReport(extras)));

    return printSetupEnding(io, checks);
  } catch (error) {
    if (!(error instanceof NonInteractiveSetupError)) throw error;
    io.print(error.message);
    return 1;
  } finally {
    rl?.close();
  }
}
