/**
 * Invoker GUI launcher — spawns the Slack-free Invoker GUI as a detached process
 * group, matching `run.sh`'s headless-Linux path. Tracks the spawned child so a
 * forced restart can tear down a manager-managed instance before respawning.
 *
 * Slack credentials are stripped from the child env: post-cutover Invoker has no
 * Slack surface, and the manager owns the only Slack connection.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';

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

      const out = openSync(options.logPath, 'a');
      child = spawn(
        'xvfb-run',
        ['--auto-servernum', './scripts/electron.cjs', 'packages/app/dist/main.js', '--no-sandbox'],
        { cwd: options.repoRoot, env, detached: true, stdio: ['ignore', out, out] },
      );
      child.unref();
      options.log('info', `spawned Invoker GUI (pid=${child.pid})`);
    },
  };
}
