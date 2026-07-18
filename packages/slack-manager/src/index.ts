/**
 * @invoker/slack-manager — a standalone, independently-supervised daemon that
 * owns the Slack Socket Mode connection and drives a running Invoker over IPC.
 *
 * It survives Invoker dying: a watchdog relaunches Invoker when it's down, and
 * an `@Invoker restart` request relaunches on demand. Sessions and the
 * workflow→channel map live in the manager's OWN SQLite store so they persist
 * while Invoker's DB is owned or its process is down.
 */

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

import { SlackSurface, type SlackSurfaceConfig } from '@invoker/surfaces';
import { ConversationRepository, SQLiteAdapter, WorkflowChannelRepository } from '@invoker/data-store';

import { IpcInvokerClient } from './invoker-client.js';
import { createInvokerLauncher } from './invoker-launcher.js';
import { createRunWorkflowOp } from './workflow-ops.js';
import { createCommandHandler } from './command-handler.js';
import { startEventSubscription } from './event-subscription.js';
import { createPlanningCommandBuilder, createPrepareRepoCheckout, createGatherWorkflowContext } from './host-seams.js';
import { createWatchdog } from './watchdog.js';
import { errMessage } from './util.js';

const VERSION = '0.0.7';

const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_CHANNEL_ID'];

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  console.log(VERSION);
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`invoker-slack ${VERSION}

Usage: invoker-slack [--version] [--help]

Standalone Slack manager daemon. Loads credentials from
~/.invoker/.slack-owner.env (or INVOKER_SLACK_OWNER_ENV) and drives Invoker
over IPC. Install via: npm i -g @neko-catpital-labs/invoker-slack
`);
  process.exit(0);
}

function makeLog(): { log: (level: string, message: string) => void; logFn: (source: string, level: string, message: string) => void } {
  const log = (level: string, message: string): void => {
    const line = `[slack-manager] ${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
    if (level === 'error') console.error(line);
    else console.log(line);
  };
  return { log, logFn: (source, level, message) => log(level, `[${source}] ${message}`) };
}

function detectRepoUrl(repoRoot: string, log: (level: string, message: string) => void): string | undefined {
  if (process.env.INVOKER_REPO_URL) return process.env.INVOKER_REPO_URL;
  try {
    return execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    log('warn', 'could not detect repoUrl from git remote; plans will require repoUrl in YAML');
    return undefined;
  }
}

async function main(): Promise<void> {
  const { log, logFn } = makeLog();

  const ownerEnvPath = process.env.INVOKER_SLACK_OWNER_ENV ?? path.join(homedir(), '.invoker', '.slack-owner.env');
  dotenv.config({ path: ownerEnvPath });

  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    log('error', `missing Slack credentials: ${missing.join(', ')} (looked in ${ownerEnvPath})`);
    process.exit(1);
  }

  const managerHome = process.env.INVOKER_SLACK_MANAGER_DIR ?? path.join(homedir(), '.invoker', 'slack-manager');
  mkdirSync(managerHome, { recursive: true });
  const checkoutsRoot = path.join(managerHome, 'checkouts');
  const plansDir = path.join(homedir(), '.invoker', 'plans');

  // Manager-owned store — survives while Invoker's DB is owned or its process is down.
  const adapter = await SQLiteAdapter.create(path.join(managerHome, 'slack-manager.db'), { ownerCapability: true });
  const conversationRepo = new ConversationRepository(adapter);
  const workflowChannelRepo = new WorkflowChannelRepository(adapter);

  const repoRoot = process.env.INVOKER_REPO_ROOT ?? process.cwd();
  const repoUrl = detectRepoUrl(repoRoot, log);

  const launcher = createInvokerLauncher({
    repoRoot,
    logPath: path.join(homedir(), '.invoker', 'gui.log'),
    log,
  });
  const client = new IpcInvokerClient({ spawnInvoker: launcher.spawnInvoker, log, pingTimeoutMs: 10_000 });

  const runWorkflowOp = createRunWorkflowOp(client, log);
  const gatherWorkflowContext = createGatherWorkflowContext({ client, conversationRepo, workflowChannelRepo, log });

  const config: SlackSurfaceConfig = {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    channelId: process.env.SLACK_CHANNEL_ID!,
    lobbyChannelId: process.env.SLACK_LOBBY_CHANNEL_ID ?? process.env.SLACK_CHANNEL_ID,
    cursorCommand: process.env.CURSOR_COMMAND ?? 'agent',
    model: process.env.CURSOR_MODEL,
    defaultHarnessPreset: process.env.INVOKER_SLACK_DEFAULT_PRESET,
    workingDir: repoRoot,
    conversationRepo,
    workflowChannelRepo,
    planningCommandBuilder: createPlanningCommandBuilder(),
    prepareRepoCheckout: createPrepareRepoCheckout(path.join(managerHome, 'planning-clones')),
    defaultBranch: process.env.INVOKER_DEFAULT_BRANCH ?? 'master',
    repoUrl,
    defaultRepoUrl: repoUrl,
    runWorkflowOp,
    gatherWorkflowContext,
    onRestartInvoker: async () => {
      const healthy = await client.launch({ force: true });
      if (!healthy) throw new Error('Invoker did not become healthy after relaunch');
    },
    log: logFn,
  };
  void checkoutsRoot; // reserved for future per-workflow checkout root

  const slack = new SlackSurface(config);
  const commandHandler = createCommandHandler({ client, slack, plansDir, log });
  const stopEvents = startEventSubscription({ client, slack, log });
  const watchdog = createWatchdog({
    client,
    log,
    alert: (message) => slack.handleEvent({ type: 'error', message }),
  });

  await slack.start(commandHandler);
  watchdog.start();
  // Establish the IPC connection (and re-apply subscriptions) if Invoker is already up.
  void client.ping();
  log('info', `slack-manager started (store=${managerHome})`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `received ${signal}, shutting down`);
    watchdog.stop();
    stopEvents();
    await slack.stop().catch((err) => log('warn', `slack.stop failed: ${errMessage(err)}`));
    client.disconnect();
    adapter.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((err) => {
  console.error(`[slack-manager] fatal: ${errMessage(err)}`);
  process.exit(1);
});
