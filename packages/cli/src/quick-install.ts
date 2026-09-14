import { spawnSync } from 'node:child_process';
import {
  buildReport,
  formatReport,
  readInvokerConfigFile,
  writeInvokerConfigFile,
} from '@invoker/contracts';
import {
  collectGithubAndSmokeChecks,
  defaultConfigPath,
  installSetupBundledSkills,
  runDoctor,
  type SetupDeps,
  type SetupIO,
} from './onboarding.js';
import {
  applyDesiredStateWorkerToggle,
  applyWorkerToggle,
  findWorkerToggle,
  isDesiredStateWorkerToggle,
  isPolicyWorkerToggle,
  openWorkerDesiredStateStore,
} from './worker-toggles.js';

export const REQUIRED_NODE_MAJOR = 26;

export const QUICK_INSTALL_NPM_PACKAGES = [
  '@neko-catpital-labs/invoker-cli',
  '@neko-catpital-labs/invoker-ui',
] as const;

/** Forced-on worker toggle ids for quick-install. */
export const QUICK_INSTALL_WORKER_IDS = ['pr-status', 'autofix', 'auto-approve'] as const;

export type InstallIO = Pick<SetupIO, 'print'>;

export type InstallDeps = SetupDeps & {
  nodeMajor?: () => number;
  npmInstallGlobal?: (packages: readonly string[]) => { status: number; stderr: string; stdout: string };
  runDoctorFix?: () => number;
  enableQuickInstallWorkers?: () => Promise<readonly string[]>;
  collectGithubAndSmoke?: () => ReturnType<typeof collectGithubAndSmokeChecks>;
};

function defaultIO(): InstallIO {
  return {
    print: (line) => process.stdout.write(`${line}\n`),
  };
}

function readNodeMajor(): number {
  return Number(process.versions.node.split('.')[0] ?? '0');
}

function defaultNpmInstallGlobal(packages: readonly string[]): { status: number; stderr: string; stdout: string } {
  const result = spawnSync('npm', ['install', '-g', ...packages], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

export async function enableQuickInstallWorkers(): Promise<readonly string[]> {
  const configPath = defaultConfigPath();
  let config = readInvokerConfigFile(configPath);
  let configChanged = false;
  const enabled: string[] = [];
  const desiredStore = await openWorkerDesiredStateStore();
  try {
    for (const id of QUICK_INSTALL_WORKER_IDS) {
      const spec = findWorkerToggle(id);
      if (!spec) {
        throw new Error(`Unknown quick-install worker toggle: ${id}`);
      }
      if (isDesiredStateWorkerToggle(spec)) {
        applyDesiredStateWorkerToggle(desiredStore, spec, true);
      } else if (isPolicyWorkerToggle(spec)) {
        config = applyWorkerToggle(config, spec, true);
        configChanged = true;
      } else {
        throw new Error(`Worker toggle "${id}" has no write path`);
      }
      enabled.push(id);
    }
  } finally {
    desiredStore.close?.();
  }
  if (configChanged) {
    writeInvokerConfigFile(configPath, config);
  }
  return enabled;
}

export function formatQuickInstallDemoTranscript(): string {
  return [
    '==> Invoker quick-install',
    '',
    '==> Checking Node.js...',
    `    OK: Node.js v${REQUIRED_NODE_MAJOR}.x`,
    '',
    '==> Installing npm packages...',
    `    OK: ${QUICK_INSTALL_NPM_PACKAGES.join(' ')}`,
    '',
    '==> Running doctor --fix...',
    '    Doctor finished (optional tools may still be missing).',
    '',
    '==> Installing skills + local MCP...',
    '    Skills/MCP: installed for detected harnesses.',
    '    Slack: skipped (optional: invoker-cli setup slack)',
    '    Remote machines: skipped (optional: invoker-cli setup machines)',
    '',
    '==> Enabling default workers...',
    `    Workers on: ${QUICK_INSTALL_WORKER_IDS.join(', ')}`,
    '',
    '==> GitHub auth + smoke (report only)...',
    '    Report-only checks finished (install continues even if red).',
    '',
    '============================================',
    '  Quick-install complete.',
    '',
    '  Default Invoker owner: local (invoker-cli mcp).',
    '',
    '  Optional next:',
    '    invoker-cli auto-approve-authors --add-current-github-user',
    '    invoker-cli setup slack',
    '    invoker-cli setup machines',
    '    invoker-ui',
    '============================================',
    '',
  ].join('\n');
}

export async function runInstall(
  argv: string[] = [],
  io: InstallIO = defaultIO(),
  deps: InstallDeps = {},
): Promise<number> {
  const demo = argv.includes('--demo');
  for (const arg of argv) {
    if (arg === '--demo') continue;
    if (arg === '-h' || arg === '--help') {
      io.print('Usage: invoker-cli install [--demo]');
      io.print('');
      io.print('Quick-install: global cli+ui, doctor --fix, skills+MCP, enable pr-status/autofix/auto-approve.');
      io.print('Skips Slack credentials and remote machines.');
      return 0;
    }
    throw new Error(`Unknown install option: ${arg}`);
  }

  if (demo) {
    io.print(formatQuickInstallDemoTranscript().trimEnd());
    return 0;
  }

  const nodeMajor = (deps.nodeMajor ?? readNodeMajor)();
  io.print('==> Invoker quick-install');
  io.print('');
  io.print('==> Checking Node.js...');
  if (nodeMajor !== REQUIRED_NODE_MAJOR) {
    io.print(`    ERROR: Node.js ${REQUIRED_NODE_MAJOR}.x is required (found major ${nodeMajor}).`);
    io.print(`    Install Node ${REQUIRED_NODE_MAJOR} (e.g. brew install node@${REQUIRED_NODE_MAJOR}), then re-run:`);
    io.print('      npx @neko-catpital-labs/invoker-cli@latest install');
    return 1;
  }
  io.print(`    OK: Node.js v${process.versions.node}`);
  io.print('');

  io.print('==> Installing npm packages...');
  const npmInstall = deps.npmInstallGlobal ?? defaultNpmInstallGlobal;
  const npmResult = npmInstall(QUICK_INSTALL_NPM_PACKAGES);
  if (npmResult.status !== 0) {
    io.print('    ERROR: npm install -g failed.');
    if (npmResult.stderr.trim()) {
      io.print(npmResult.stderr.trimEnd());
    }
    return 1;
  }
  io.print(`    OK: ${QUICK_INSTALL_NPM_PACKAGES.join(' ')}`);
  io.print('');

  io.print('==> Running doctor --fix...');
  const doctorFix = deps.runDoctorFix ?? (() => runDoctor(['--fix']));
  const doctorStatus = doctorFix();
  if (doctorStatus !== 0) {
    io.print('    Doctor finished with gaps (optional tools may still be missing). Continuing.');
  } else {
    io.print('    Doctor finished.');
  }
  io.print('');

  io.print('==> Installing skills + local MCP...');
  installSetupBundledSkills(io, deps);
  io.print('    Slack: skipped (optional: invoker-cli setup slack)');
  io.print('    Remote machines: skipped (optional: invoker-cli setup machines)');
  io.print('');

  io.print('==> Enabling default workers...');
  const enableWorkers = deps.enableQuickInstallWorkers ?? enableQuickInstallWorkers;
  const enabled = await enableWorkers();
  io.print(`    Workers on: ${enabled.join(', ')}`);
  io.print('');

  io.print('==> GitHub auth + smoke (report only)...');
  const collect = deps.collectGithubAndSmoke ?? (() => collectGithubAndSmokeChecks(deps));
  const extras = await collect();
  io.print(formatReport(buildReport(extras)));
  io.print('    Report-only: install succeeds even if the checks above are red.');
  io.print('');

  io.print('============================================');
  io.print('  Quick-install complete.');
  io.print('');
  io.print('  Default Invoker owner: local (invoker-cli mcp).');
  io.print('');
  io.print('  Optional next:');
  io.print('    invoker-cli auto-approve-authors --add-current-github-user');
  io.print('    invoker-cli setup slack');
  io.print('    invoker-cli setup machines');
  io.print('    invoker-ui');
  io.print('============================================');
  return 0;
}
