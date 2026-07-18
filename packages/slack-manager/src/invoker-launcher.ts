/**
 * Invoker GUI launcher — spawns the Slack-free Invoker GUI as a detached process
 * group. Tracks the spawned child so a forced restart can tear down a
 * manager-managed instance before respawning.
 *
 * Resolution order:
 *   1. INVOKER_GUI_COMMAND (shell-split argv[0] + args)
 *   2. `invoker-ui` on PATH
 *   3. macOS: `open -a Invoker`
 *   4. monorepo checkout: xvfb-run + ./scripts/electron.cjs (Linux headless)
 *
 * Slack credentials are stripped from the child env: post-cutover Invoker has no
 * Slack surface, and the manager owns the only Slack connection.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { join } from 'node:path';

const SLACK_ENV_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CHANNEL_ID',
  'SLACK_LOBBY_CHANNEL_ID',
];

export interface InvokerLauncherOptions {
  repoRoot: string;
  /** Path the GUI's stdout/stderr is appended to. */
  logPath: string;
  log: (level: string, message: string) => void;
}

export interface InvokerLauncher {
  spawnInvoker: () => void;
}

export interface GuiLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
}

function defaultWhich(command: string): string | undefined {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Exported for unit tests — pure resolution, no spawn. */
export function resolveGuiLaunch(options: {
  repoRoot: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  which?: (command: string) => string | undefined;
  existsSync?: (path: string) => boolean;
}): GuiLaunchSpec {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const which = options.which ?? defaultWhich;
  const fileExists = options.existsSync ?? existsSync;

  const guiCommand = env.INVOKER_GUI_COMMAND?.trim();
  if (guiCommand) {
    const parts = guiCommand.split(/\s+/).filter(Boolean);
    return { command: parts[0]!, args: parts.slice(1) };
  }

  const invokerUi = which('invoker-ui');
  if (invokerUi) {
    return { command: invokerUi, args: [] };
  }

  if (platform === 'darwin') {
    return { command: 'open', args: ['-a', 'Invoker'] };
  }

  const electronCjs = join(options.repoRoot, 'scripts', 'electron.cjs');
  const mainJs = join(options.repoRoot, 'packages', 'app', 'dist', 'main.js');
  if (fileExists(electronCjs) && fileExists(mainJs)) {
    return {
      command: 'xvfb-run',
      args: ['--auto-servernum', './scripts/electron.cjs', 'packages/app/dist/main.js', '--no-sandbox'],
      cwd: options.repoRoot,
    };
  }

  throw new Error(
    'Cannot launch Invoker GUI: set INVOKER_GUI_COMMAND, install invoker-ui, or run from a built monorepo checkout',
  );
}

export function createInvokerLauncher(options: InvokerLauncherOptions): InvokerLauncher {
  let child: ChildProcess | undefined;

  return {
    spawnInvoker: () => {
      // Tear down a previously manager-spawned GUI (force-restart of a managed instance).
      if (child?.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
          options.log('info', `sent SIGTERM to previous Invoker GUI group (pid=${child.pid})`);
        } catch {
          /* already gone */
        }
      }

      const env: NodeJS.ProcessEnv = { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' };
      for (const key of SLACK_ENV_VARS) delete env[key];

      const spec = resolveGuiLaunch({ repoRoot: options.repoRoot });
      const out = openSync(options.logPath, 'a');
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env,
        detached: true,
        stdio: ['ignore', out, out],
      });
      child.unref();
      options.log('info', `spawned Invoker GUI via ${spec.command} (pid=${child.pid})`);
    },
  };
}
