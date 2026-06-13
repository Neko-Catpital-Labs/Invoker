#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '__tests__', 'e2e']);
const TEST_FILE_RE = /(?:^|[.\-/])(test|spec)\.[cm]?[jt]sx?$/;

const MUTATING_ORCHESTRATOR_METHODS = [
  'approve',
  'beginConflictResolution',
  'cancelTask',
  'cancelWorkflow',
  'cascadeInvalidationToDownstream',
  'deferTask',
  'deleteAllWorkflows',
  'deleteWorkflow',
  'detachWorkflow',
  'editTaskAgent',
  'editTaskCommand',
  'editTaskPool',
  'editTaskPrompt',
  'editTaskType',
  'forkWorkflow',
  'handleWorkerResponse',
  'loadPlan',
  'markTaskRunningAfterLaunch',
  'prepareTaskForNewAttempt',
  'provideInput',
  'recordTaskHeartbeat',
  'recreateDownstream',
  'recreateTask',
  'recreateWorkflow',
  'reject',
  'replaceTask',
  'resumeWorkflow',
  'retryTask',
  'retryWorkflow',
  'revertConflictResolution',
  'selectExperiment',
  'setBeforeApproveHook',
  'setTaskAwaitingApproval',
  'setTaskExternalGatePolicies',
  'startExecution',
  'syncAllFromDb',
  'syncFromDb',
];

const SCAN_ROOTS = ['packages'];
const APP_SURFACE_CLI_RE = /^(?:packages\/(?:app|surfaces|cli)\/src)\//;

const CHECKS = [
  {
    id: 'raw-persistence-updateTask',
    pattern: /\.updateTask\s*\(/g,
    appliesTo: () => true,
    guidance: 'Route task mutations through CommandService or add a narrow owner-internal allowlist entry.',
  },
  {
    id: 'raw-persistence-updateWorkflow',
    pattern: /\.updateWorkflow\s*\(/g,
    appliesTo: () => true,
    guidance: 'Route workflow mutations through CommandService or add a narrow owner-internal allowlist entry.',
  },
  {
    id: 'app-layer-orchestrator-mutation',
    pattern: new RegExp(`\\borchestrator\\.(?:${MUTATING_ORCHESTRATOR_METHODS.join('|')})\\s*\\(`, 'g'),
    appliesTo: (file) => APP_SURFACE_CLI_RE.test(file),
    guidance: 'App, surface, and CLI layers should normally call CommandService or the workflow mutation facade. If this is a migration seam, add a narrow allowlist entry with a reason.',
  },
];

const DEFAULT_ALLOWLIST = [
  {
    file: 'packages/data-store/src/sqlite-adapter.ts',
    match: '\\bthis\\.updateTask\\s*\\(',
    reason: 'SQLite adapter owner-internal transaction helper reuses its public update method while persisting task and attempt state together.',
  },
  {
    file: 'packages/data-store/src/sqlite-task-repository.ts',
    match: '\\bthis\\.adapter\\.update(?:Task|Workflow)\\s*\\(',
    reason: 'SQLite task repository is the data-store owner boundary over adapter update methods.',
  },
  {
    file: 'packages/workflow-core/src/orchestrator.ts',
    match: '\\.(?:updateTask|updateWorkflow)\\s*\\(',
    reason: 'Workflow-core orchestrator is the current mutation owner and persists graph state through repository/persistence ports.',
  },
  {
    file: 'packages/workflow-core/src/task-repository.ts',
    match: '\\.(?:updateTask|updateWorkflow)\\s*\\(',
    reason: 'Workflow-core task repository is the persistence boundary used by orchestrator internals.',
  },
  {
    file: 'packages/workflow-core/src/command-service.ts',
    match: '\\.(?:updateTask|updateWorkflow)\\s*\\(',
    reason: 'CommandService owns serialized workflow mutations during the boundary migration.',
  },
  {
    file: 'packages/workflow-core/src/invalidation-policy.ts',
    match: '\\.(?:updateTask|updateWorkflow)\\s*\\(',
    reason: 'Workflow-core invalidation internals own task reset writes.',
  },
  {
    file: 'packages/workflow-core/src/invalidation-plan.ts',
    match: '\\.(?:updateTask|updateWorkflow)\\s*\\(',
    reason: 'Workflow-core invalidation plan internals own task reset writes.',
  },
  {
    file: 'packages/app/src/workflow-mutation-facade.ts',
    match: '\\borchestrator\\.(?:cancelTask|deleteWorkflow|deleteAllWorkflows|detachWorkflow|forkWorkflow)\\s*\\(',
    reason: 'Workflow mutation facade is the app-layer owner boundary that currently delegates to orchestrator.',
  },
  {
    match: '\\b(?:deps\\.)?orchestrator\\.(?:recreateWorkflow|revertConflictResolution|reject|provideInput|retryTask|recreateTask|retryWorkflow|recreateDownstream|cancelWorkflow|deleteAllWorkflows|forkWorkflow|cascadeInvalidationToDownstream|editTaskCommand|editTaskPrompt|editTaskType|editTaskAgent|setTaskExternalGatePolicies|selectExperiment|beginConflictResolution)\\s*\\(',
    reason: 'Legacy workflow action helpers are the current GUI mutation seam pending CommandService/facade migration.',
    file: 'packages/app/src/workflow-actions.ts',
  },
  {
    match: '\\b(?:deps\\.)?persistence\\.update(?:Task|Workflow)\\s*\\(',
    reason: 'Legacy workflow action helpers still patch generation, attempt, and autofix metadata directly around orchestrator retries.',
    file: 'packages/app/src/workflow-actions.ts',
  },
  {
    file: 'packages/app/src/metadata-setter.ts',
    match: '\\bdeps\\.(?:persistence\\.update(?:Task|Workflow)|orchestrator\\.syncFromDb)\\s*\\(',
    reason: 'Metadata setter serializes through CommandService today but still performs direct persistence writes inside that lock.',
  },
  {
    match: '\\borchestrator\\.(?:syncAllFromDb|selectExperiment|provideInput|loadPlan|startExecution|resumeWorkflow|handleWorkerResponse|retryTask|syncFromDb|prepareTaskForNewAttempt)\\s*\\(',
    reason: 'Legacy Electron/headless IPC seams still call orchestrator directly pending facade migration.',
    file: 'packages/app/src/main.ts',
  },
  {
    file: 'packages/app/src/main.ts',
    match: '\\bpersistence\\.update(?:Task|Workflow)\\s*\\(',
    reason: 'Legacy Electron command handlers still patch persisted task/workflow metadata directly pending migration.',
  },
  {
    file: 'packages/app/src/headless.ts',
    match: '\\b(?:deps\\.)?orchestrator\\.(?:recordTaskHeartbeat|prepareTaskForNewAttempt|syncFromDb|setBeforeApproveHook|loadPlan|startExecution|resumeWorkflow)\\s*\\(',
    reason: 'Legacy headless CLI seams still drive orchestrator directly pending facade migration.',
  },
  {
    file: 'packages/app/src/global-topup.ts',
    match: '\\borchestrator\\.startExecution\\s*\\(',
    reason: 'Legacy global top-up helper still asks orchestrator for runnable tasks pending launch-boundary migration.',
  },
  {
    file: 'packages/app/src/ipc-read-handlers.ts',
    match: '\\borchestrator\\.sync(?:All)?FromDb\\s*\\(',
    reason: 'Legacy read IPC handlers refresh orchestrator memory from DB pending read-model migration.',
  },
  {
    file: 'packages/app/src/execution/task-runner-wiring.ts',
    match: '\\bdeps\\.orchestrator\\.(?:setBeforeApproveHook|recordTaskHeartbeat)\\s*\\(',
    reason: 'Legacy execution wiring installs orchestrator hooks and heartbeats pending runtime facade migration.',
  },
  {
    file: 'packages/cli/src/index.ts',
    match: '\\borchestrator\\.(?:loadPlan|startExecution)\\s*\\(',
    reason: 'Standalone CLI currently drives orchestrator directly pending CommandService/facade migration.',
  },
  {
    file: 'packages/execution-engine/src/task-runner.ts',
    match: '\\bthis\\.persistence\\.updateTask\\s*\\(',
    reason: 'Execution engine owns runtime task result/status persistence during task execution.',
  },
  {
    file: 'packages/execution-engine/src/merge-runner.ts',
    match: '\\bhost\\.persistence\\.updateTask\\s*\\(',
    reason: 'Merge runner owns review metadata persistence during merge task execution.',
  },
  {
    file: 'packages/execution-engine/src/merge-gate-executor.ts',
    match: '\\bthis\\.host\\.persistence\\.updateTask\\s*\\(',
    reason: 'Merge gate executor owns review status persistence while polling merge gates.',
  },
  {
    file: 'packages/test-kit/src/test-harness.ts',
    match: '\\bpersistence\\.updateTask\\s*\\(',
    reason: 'Test-kit source provides reusable test harness helpers; production package scans exclude tests but not harness support code.',
  },
];

function usage() {
  return `Usage: node scripts/check-mutation-boundary.mjs [--root <path>] [--allowlist <json>]\n\nScans non-test source files for raw workflow mutation boundary bypasses.\n`;
}

function parseArgs(argv) {
  const opts = { root: process.cwd(), allowlistPath: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root requires a path');
      opts.root = value;
      i += 1;
    } else if (arg === '--allowlist') {
      const value = argv[i + 1];
      if (!value) throw new Error('--allowlist requires a path');
      opts.allowlistPath = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  opts.root = resolve(opts.root);
  return opts;
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function extensionOf(file) {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot);
}

function isSkippedSource(rel) {
  const parts = rel.split('/');
  if (parts.some((part) => SKIP_DIRS.has(part))) return true;
  return TEST_FILE_RE.test(rel);
}

function collectFiles(root) {
  const files = [];
  const starts = SCAN_ROOTS.map((dir) => resolve(root, dir)).filter((dir) => existsSync(dir));
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = resolve(dir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(abs);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extensionOf(entry.name)) && !isSkippedSource(rel)) {
        files.push({ abs, rel });
      }
    }
  };
  for (const start of starts) {
    if (statSync(start).isDirectory()) visit(start);
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function stripCommentsAndStrings(text) {
  let out = '';
  let state = 'code';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'lineComment') {
      if (ch === '\n') {
        state = 'code';
        out += ch;
      } else {
        out += ' ';
      }
      continue;
    }
    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 1;
        state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state === 'string') {
      if (ch === '\\') {
        out += ' ';
        if (next !== undefined) {
          out += next === '\n' ? '\n' : ' ';
          i += 1;
        }
      } else if (ch === quote) {
        out += ' ';
        state = 'code';
      } else {
        out += ch === '\n' && quote === '`' ? '\n' : ' ';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      state = 'lineComment';
    } else if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      state = 'blockComment';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ' ';
      state = 'string';
    } else {
      out += ch;
    }
  }
  return out;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineForIndex(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function loadAllowlist(root, allowlistPath) {
  const entries = [...DEFAULT_ALLOWLIST];
  if (allowlistPath) {
    const abs = resolve(root, allowlistPath);
    const parsed = JSON.parse(readFileSync(abs, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('--allowlist JSON must be an array');
    entries.push(...parsed);
  }
  return entries.map((entry, index) => {
    if (!entry || typeof entry.file !== 'string' || typeof entry.match !== 'string' || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`Allowlist entry ${index + 1} must include file, match, and reason`);
    }
    return { file: entry.file, match: new RegExp(entry.match), reason: entry.reason };
  });
}

function allowedBy(allowlist, finding) {
  return allowlist.find((entry) => entry.file === finding.file && entry.match.test(finding.source));
}

function scanFile(file) {
  const text = readFileSync(file.abs, 'utf8');
  const stripped = stripCommentsAndStrings(text);
  const starts = lineStarts(stripped);
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (const check of CHECKS) {
    if (!check.appliesTo(file.rel)) continue;
    check.pattern.lastIndex = 0;
    for (let match = check.pattern.exec(stripped); match !== null; match = check.pattern.exec(stripped)) {
      const line = lineForIndex(starts, match.index);
      findings.push({
        file: file.rel,
        line,
        check: check.id,
        pattern: match[0].trim(),
        source: lines[line - 1]?.trim() ?? '',
        guidance: check.guidance,
      });
    }
  }
  return findings;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  const allowlist = loadAllowlist(opts.root, opts.allowlistPath);
  const findings = collectFiles(opts.root).flatMap(scanFile);
  const blocked = findings.filter((finding) => !allowedBy(allowlist, finding));

  if (blocked.length === 0) {
    console.log(`mutation boundary check passed (${findings.length} allowlisted mutation boundary hit${findings.length === 1 ? '' : 's'})`);
    return;
  }

  console.error(`mutation boundary check failed: ${blocked.length} non-allowlisted bypass${blocked.length === 1 ? '' : 'es'} found`);
  for (const finding of blocked) {
    console.error(`- ${finding.file}:${finding.line} [${finding.check}] ${finding.pattern}`);
    console.error(`  ${finding.source}`);
    console.error(`  ${finding.guidance}`);
    console.error('  Allowlist format: { "file": "' + finding.file + '", "match": "<narrow regex>", "reason": "<why this owner may bypass the boundary>" }');
  }
  process.exit(1);
}

main();
