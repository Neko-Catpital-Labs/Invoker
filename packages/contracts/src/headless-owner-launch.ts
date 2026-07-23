import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const LINUX_HEADLESS_ELECTRON_FLAGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-gpu-sandbox',
  '--disable-software-rasterizer',
] as const;

export interface HeadlessOwnerLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
}

export interface ResolveHeadlessOwnerLaunchOptions {
  repoRoot: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  which?: (command: string) => string | undefined;
  existsSync?: (path: string) => boolean;
}

function defaultWhich(command: string): string | undefined {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function splitCommand(commandText: string): HeadlessOwnerLaunchSpec {
  const parts = commandText.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('INVOKER_GUI_COMMAND is set but empty');
  }
  return { command: parts[0]!, args: parts.slice(1) };
}

function ensureHeadlessOwnerArgs(spec: HeadlessOwnerLaunchSpec): HeadlessOwnerLaunchSpec {
  const argsWithoutOwnerServe = spec.args.filter((arg) => arg !== 'owner-serve');
  const headlessIndex = argsWithoutOwnerServe.indexOf('--headless');
  if (headlessIndex === -1) {
    return {
      command: spec.command,
      args: [...argsWithoutOwnerServe, '--headless', 'owner-serve'],
    };
  }
  return {
    command: spec.command,
    args: [
      ...argsWithoutOwnerServe.slice(0, headlessIndex + 1),
      'owner-serve',
      ...argsWithoutOwnerServe.slice(headlessIndex + 1),
    ],
  };
}

export function buildElectronHeadlessArgs(
  mainJsPath: string,
  headlessArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    ...(platform === 'linux' ? LINUX_HEADLESS_ELECTRON_FLAGS : []),
    mainJsPath,
    '--headless',
    ...headlessArgs,
  ];
}

export function resolveHeadlessOwnerLaunchSpec(
  options: ResolveHeadlessOwnerLaunchOptions,
): HeadlessOwnerLaunchSpec {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const which = options.which ?? defaultWhich;
  const fileExists = options.existsSync ?? existsSync;

  const overrideCommand = env.INVOKER_GUI_COMMAND?.trim();
  if (overrideCommand) {
    return ensureHeadlessOwnerArgs(splitCommand(overrideCommand));
  }

  const invokerUi = which('invoker-ui');
  if (invokerUi) {
    return { command: invokerUi, args: ['--headless', 'owner-serve'] };
  }

  const electronCjs = join(options.repoRoot, 'scripts', 'electron.cjs');
  const mainJs = join(options.repoRoot, 'packages', 'app', 'dist', 'main.js');
  if (fileExists(electronCjs) && fileExists(mainJs)) {
    const launchArgs = buildElectronHeadlessArgs('packages/app/dist/main.js', ['owner-serve'], platform);
    if (platform === 'linux') {
      return {
        command: 'xvfb-run',
        args: ['--auto-servernum', './scripts/electron.cjs', ...launchArgs],
        cwd: options.repoRoot,
      };
    }
    return {
      command: './scripts/electron.cjs',
      args: launchArgs,
      cwd: options.repoRoot,
    };
  }

  throw new Error(
    'Cannot launch Invoker headless owner: set INVOKER_GUI_COMMAND, install invoker-ui, or run from a built monorepo checkout',
  );
}
