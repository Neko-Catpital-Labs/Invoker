/**
 * Invoker owner launcher — spawns the Slack-free headless owner as a detached
 * process group. Tracks the spawned child so a forced restart can tear down a
 * manager-managed instance before respawning.
 *
 * Resolution order:
 *   1. INVOKER_GUI_COMMAND (explicit override command)
 *   2. `invoker-ui --headless owner-serve`
 *   3. monorepo checkout: repo Electron `--headless owner-serve`
 *
 * Slack credentials are stripped from the child env: post-cutover Invoker has no
 * Slack surface, and the manager owns the only Slack connection.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';

import {
  resolveHeadlessOwnerLaunchSpec,
  type HeadlessOwnerLaunchSpec,
} from '@invoker/contracts';

const SLACK_ENV_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CHANNEL_ID',
  'SLACK_LOBBY_CHANNEL_ID',
] as const;

export interface InvokerLauncherOptions {
  repoRoot: string;
  /** Path the owner stdout/stderr is appended to. */
  logPath: string;
  log: (level: string, message: string) => void;
}

export interface InvokerLauncher {
  spawnInvoker: () => void;
}

export type OwnerLaunchSpec = HeadlessOwnerLaunchSpec;
export { resolveHeadlessOwnerLaunchSpec as resolveOwnerLaunch };

export function createInvokerLauncher(options: InvokerLauncherOptions): InvokerLauncher {
  let child: ChildProcess | undefined;

  return {
    spawnInvoker: () => {
      if (child?.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
          options.log('info', `sent SIGTERM to previous Invoker owner group (pid=${child.pid})`);
        } catch {
          /* already gone */
        }
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LIBGL_ALWAYS_SOFTWARE: process.platform === 'linux' ? '1' : process.env.LIBGL_ALWAYS_SOFTWARE,
      };
      for (const key of SLACK_ENV_VARS) delete env[key];

      const spec = resolveHeadlessOwnerLaunchSpec({ repoRoot: options.repoRoot });
      const out = openSync(options.logPath, 'a');
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env,
        detached: true,
        stdio: ['ignore', out, out],
      });
      child.unref();
      options.log('info', `spawned Invoker owner via ${spec.command} (pid=${child.pid})`);
    },
  };
}
