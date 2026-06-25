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
    process.stdout.write('\nFix the items above, then re-run `invoker-cli doctor`. For Slack, run `invoker-cli setup slack`.\n');
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
  features: { bot_user: { display_name: string; always_online: boolean } };
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
    features: { bot_user: { display_name: name, always_online: true } },
    oauth_config: { scopes: { bot: [...REQUIRED_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: ['app_mention'] },
      interactivity: { is_enabled: false },
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

export async function runSetup(argv: string[], io: SetupIO = defaultIO()): Promise<number> {
  const wantSlack = argv[0] === 'slack';
  const checkOnly = argv.includes('--check');
  const rl = (io as { rl?: { close: () => void } }).rl;
  try {
    if (checkOnly) {
      const checks = await validateSlackCredentials(slackCredsFromEnv());
      const report = buildReport(checks);
      io.print(formatReport(report, { json: argv.includes('--json') }));
      return report.ok ? 0 : 1;
    }

    io.print('Invoker setup\n');
    const core = buildReport(buildDoctorChecks(loadCliConfig()));
    io.print(formatReport(core));
    io.print('');

    let doSlack = wantSlack;
    if (!wantSlack) {
      const answer = (await io.prompt('Set up the Slack integration now? [y/N] ')).toLowerCase();
      doSlack = answer === 'y' || answer === 'yes';
    }
    if (!doSlack) {
      io.print('\nYou are good to go for CLI and UI workflows. Run `invoker-cli setup slack` later to add Slack.');
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
      const proceed = (await io.prompt('\nSome checks failed. Save these values anyway? [y/N] ')).toLowerCase();
      if (proceed !== 'y' && proceed !== 'yes') {
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
