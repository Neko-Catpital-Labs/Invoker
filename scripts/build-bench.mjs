#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cpus, freemem, hostname, platform, release, totalmem, arch, tmpdir } from 'node:os';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), '..');
const DEFAULT_CASES = join(ROOT, 'scripts/build-bench-cases.json');
const DEFAULT_RESULT = join(ROOT, 'scripts/build-bench-results/01-benchmark.json');
const BLOCKING_STATUSES = new Set(['failed', 'timed_out', 'missing_report', 'zero_tests', 'stale_output']);
const NON_SCORING_STATUSES = new Set([...BLOCKING_STATUSES, 'skipped', 'no_tests', 'incomparable']);

function usage() {
  return `usage:
  node scripts/build-bench.mjs inventory [--root DIR] [--cases FILE] [--suite NAME]
  node scripts/build-bench.mjs baseline --ref SHA [--suite NAME] [--repetitions N] [--cases FILE] [--out FILE]
  node scripts/build-bench.mjs stage [--ref SHA] [--suite NAME] [--repetitions N] [--cases FILE] [--out FILE] [--root DIR] [--no-clone] [--strict]
  node scripts/build-bench.mjs compare --baseline FILE --candidate FILE [--out FILE]
  node scripts/build-bench.mjs self-test`;
}

function parseArgs(argv) {
  const command = argv[2];
  const opts = { _: [] };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (['no-clone', 'strict', 'keep-workdir'].includes(key)) {
      opts[key] = true;
    } else {
      opts[key] = argv[++i];
    }
  }
  return { command, opts };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hashString(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashFile(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stableHostname() {
  return hashString(hostname()).slice(0, 16);
}

function runSync(args, cwd, allowFailure = false) {
  const res = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
  if (!allowFailure && res.status !== 0) {
    throw new Error(`${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res;
}

function gitValue(root, args, fallback = null) {
  const res = runSync(['git', ...args], root, true);
  return res.status === 0 ? res.stdout.trim() : fallback;
}

function currentSha(root) {
  return gitValue(root, ['rev-parse', 'HEAD'], null);
}

function dirtyStatus(root) {
  const res = runSync(['git', 'status', '--short'], root, true);
  if (res.status !== 0) return { known: false, dirty: null, entries: [] };
  const entries = res.stdout.split('\n').filter(Boolean);
  return { known: true, dirty: entries.length > 0, entries };
}

function assertDescendsFrom(root, ref) {
  const res = runSync(['git', 'merge-base', '--is-ancestor', ref, 'HEAD'], root, true);
  if (res.status !== 0) {
    throw new Error(`execution base ${currentSha(root) ?? '<unknown>'} does not descend from ${ref}`);
  }
}

function listFilesForDigest(root) {
  const res = runSync(['git', 'ls-files', '-z'], root, true);
  if (res.status === 0) {
    return res.stdout.split('\0').filter(Boolean);
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', 'build'].includes(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) files.push(relative(root, abs));
    }
  };
  walk(root);
  return files.sort();
}

function treeDigest(root) {
  const h = createHash('sha256');
  for (const file of listFilesForDigest(root)) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    h.update(file);
    h.update('\0');
    h.update(readFileSync(abs));
    h.update('\0');
  }
  return h.digest('hex');
}

function commandDigest(root, cases) {
  const h = createHash('sha256');
  for (const c of cases) {
    h.update(c.id);
    h.update(JSON.stringify(c.argv ?? c.steps ?? []));
  }
  h.update(hashFile(join(root, 'package.json')) ?? '');
  return h.digest('hex');
}

function workspacePackages(root) {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir)
    .sort()
    .map((name) => {
      const packageJson = join(packagesDir, name, 'package.json');
      if (!existsSync(packageJson)) return null;
      const json = readJson(packageJson);
      return {
        name: json.name,
        dir: `packages/${name}`,
        packageJson: `packages/${name}/package.json`,
        scripts: json.scripts ?? {}
      };
    })
    .filter(Boolean);
}

function isLiteralNoopTest(script) {
  const normalized = script.trim();
  return /^echo\b/i.test(normalized)
    && /\b(no tests|tests moved|utility-only package)\b/i.test(normalized)
    && !/\b(vitest|node --test|playwright|tsx)\b/i.test(normalized);
}

function discoverTestIds(root, relDir) {
  const base = join(root, relDir);
  if (!existsSync(base)) return [];
  const ids = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'build', '.turbo'].includes(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        ids.push(relative(root, abs).split(sep).join('/'));
      }
    }
  };
  walk(base);
  return ids.sort();
}

function loadCases(root, casesPath, suite) {
  const manifest = readJson(casesPath);
  const cases = (manifest.cases ?? [])
    .filter((c) => !suite || c.suite === suite)
    .map((c) => {
      if (c.kind !== 'workspace-package-test') return { ...c, source: relative(root, casesPath) || casesPath };
      const packages = workspacePackages(root);
      return {
        ...c,
        source: relative(root, casesPath) || casesPath,
        discoveredTestIds: packages.flatMap((pkg) => discoverTestIds(root, pkg.dir)).sort(),
        noTestPackages: packages
          .filter((pkg) => pkg.scripts.test && isLiteralNoopTest(pkg.scripts.test))
          .map((pkg) => ({ name: pkg.name, dir: pkg.dir, testScript: pkg.scripts.test }))
      };
    });

  for (const generated of manifest.generatedCases ?? []) {
    if (suite && generated.suite !== suite) continue;
    if (generated.selector !== 'workspace-packages-with-test-script') continue;
    for (const pkg of workspacePackages(root)) {
      if (!pkg.scripts.test) continue;
      const testIds = discoverTestIds(root, pkg.dir);
      const noop = isLiteralNoopTest(pkg.scripts.test);
      cases.push({
        id: `package-vitest:${pkg.name}`,
        suite: generated.suite,
        kind: 'package-test',
        description: `${pkg.name} package test command.`,
        cwd: '.',
        argv: ['pnpm', '--filter', pkg.name, 'test'],
        packageName: pkg.name,
        packageDir: pkg.dir,
        testScript: pkg.scripts.test,
        literalNoopTestScript: noop,
        discoveredTestIds: testIds,
        artifacts: [],
        source: `${pkg.packageJson}:scripts.test`
      });
    }
  }
  return { manifest, cases };
}

function artifactState(root, artifact) {
  if (artifact.includes('*')) return { path: artifact, exists: null, digest: null, glob: true };
  const abs = join(root, artifact);
  if (!existsSync(abs)) return { path: artifact, exists: false, digest: null };
  const st = statSync(abs);
  if (st.isDirectory()) {
    const h = createHash('sha256');
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absEntry = join(dir, entry.name);
        if (entry.isDirectory()) walk(absEntry);
        else if (entry.isFile()) {
          h.update(relative(root, absEntry));
          h.update(readFileSync(absEntry));
        }
      }
    };
    walk(abs);
    return { path: artifact, exists: true, digest: h.digest('hex') };
  }
  return { path: artifact, exists: true, digest: hashFile(abs) };
}

function toolVersions(root) {
  const read = (args) => {
    const res = spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8', timeout: 5000 });
    return res.status === 0 ? (res.stdout || res.stderr).trim().split('\n')[0] : null;
  };
  const hasInstall = existsSync(join(root, 'node_modules'));
  return {
    node: process.version,
    pnpm: read(['pnpm', '--version']),
    npm: read(['npm', '--version']),
    git: read(['git', '--version']),
    tsc: hasInstall ? read(['pnpm', 'exec', 'tsc', '--version']) : null,
    vitest: hasInstall ? read(['pnpm', 'exec', 'vitest', '--version']) : null,
    tsup: hasInstall ? read(['pnpm', 'exec', 'tsup', '--version']) : null
  };
}

function platformInfo() {
  const cpu = cpus()[0] ?? {};
  return {
    os: platform(),
    arch: arch(),
    release: release(),
    cpuModel: cpu.model ?? null,
    cpuCount: cpus().length,
    totalRamBytes: totalmem(),
    freeRamBytesAtStart: freemem(),
    hostIdentifier: stableHostname()
  };
}

function taskEnv(cacheRoot) {
  const env = { ...process.env };
  env.XDG_CACHE_HOME = join(cacheRoot, 'xdg-cache');
  env.npm_config_cache = join(cacheRoot, 'npm-cache');
  env.PNPM_HOME = join(cacheRoot, 'pnpm-home');
  env.ELECTRON_CACHE = join(cacheRoot, 'electron-cache');
  env.PLAYWRIGHT_BROWSERS_PATH = join(cacheRoot, 'playwright-browsers');
  env.INVOKER_USER_DATA_DIR = join(cacheRoot, 'invoker-user-data');
  env.INVOKER_DB_DIR = join(cacheRoot, 'invoker-db');
  env.CI = env.CI || '1';
  for (const dir of [
    env.XDG_CACHE_HOME,
    env.npm_config_cache,
    env.PNPM_HOME,
    env.ELECTRON_CACHE,
    env.PLAYWRIGHT_BROWSERS_PATH,
    env.INVOKER_USER_DATA_DIR,
    env.INVOKER_DB_DIR
  ]) mkdirSync(dir, { recursive: true });
  return env;
}

function runProcess(argv, opts) {
  return new Promise((resolve) => {
    const startNs = process.hrtime.bigint();
    const startedAt = new Date().toISOString();
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const endNs = process.hrtime.bigint();
      const endedAt = new Date().toISOString();
      resolve({
        startedAt,
        endedAt,
        elapsedMs: Number(endNs - startNs) / 1e6,
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr
      });
    });
  });
}

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = deviations.length % 2 ? deviations[mid] : (deviations[mid - 1] + deviations[mid]) / 2;
  return { samples: values.length, medianMs: median, minMs: sorted[0], maxMs: sorted[sorted.length - 1], medianAbsoluteDeviationMs: mad };
}

function sampleStatus(caseDef, result, root) {
  if (caseDef.literalNoopTestScript) return 'no_tests';
  if (caseDef.kind === 'package-test' && (caseDef.discoveredTestIds ?? []).length === 0) return 'zero_tests';
  if (result.timedOut) return 'timed_out';
  if (result.exitCode !== 0) return 'failed';
  for (const report of caseDef.expectedReports ?? []) {
    if (!existsSync(join(root, report))) return 'missing_report';
  }
  if (caseDef.rejectIfOutputEquals) {
    const actualPath = join(root, caseDef.rejectIfOutputEquals.path);
    if (existsSync(actualPath) && readFileSync(actualPath, 'utf8') === caseDef.rejectIfOutputEquals.value) {
      return 'stale_output';
    }
  }
  return 'passed';
}

async function runCase(caseDef, root, env, rawDir, repetitions) {
  if (caseDef.literalNoopTestScript) {
    return {
      id: caseDef.id,
      kind: caseDef.kind,
      status: 'no_tests',
      nonScoring: true,
      source: caseDef.source,
      argv: caseDef.argv,
      artifacts: (caseDef.artifacts ?? []).map((artifact) => artifactState(root, artifact)),
      testIds: caseDef.discoveredTestIds ?? [],
      samples: [],
      stats: null,
      disqualifiers: ['literal no-op test script']
    };
  }

  const samples = [];
  const disqualifiers = [];
  const statuses = [];
  const reps = Math.max(1, Number(repetitions));
  for (let i = 0; i < reps; i += 1) {
    process.stderr.write(`[build-bench] ${caseDef.id} sample ${i + 1}/${reps} start\n`);
    const logPath = join(rawDir, `${caseDef.id.replace(/[^A-Za-z0-9_.:-]+/g, '_')}.${i + 1}.log`);
    const cwd = resolve(root, caseDef.cwd ?? '.');
    const result = await runProcess(caseDef.argv, {
      cwd,
      env,
      timeoutMs: caseDef.timeoutMs ?? 20 * 60 * 1000
    });
    const status = sampleStatus(caseDef, result, root);
    statuses.push(status);
    const logBody = [
      `$ ${caseDef.argv.join(' ')}`,
      `cwd=${cwd}`,
      `status=${status} exitCode=${result.exitCode} signal=${result.signal ?? ''} elapsedMs=${result.elapsedMs.toFixed(3)}`,
      '',
      '--- stdout ---',
      result.stdout,
      '--- stderr ---',
      result.stderr
    ].join('\n');
    writeFileSync(logPath, logBody);
    const logHash = hashFile(logPath);
    samples.push({
      repetition: i + 1,
      status,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      elapsedMs: result.elapsedMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      logPath,
      logSha256: logHash
    });
    if (status !== 'passed') disqualifiers.push(`${status} at repetition ${i + 1}`);
    process.stderr.write(`[build-bench] ${caseDef.id} sample ${i + 1}/${reps} ${status} ${result.elapsedMs.toFixed(0)}ms\n`);
  }

  const status = statuses.every((s) => s === 'passed') ? 'passed' : statuses.find((s) => s !== 'passed');
  const scoringSamples = samples.filter((s) => s.status === 'passed').map((s) => s.elapsedMs);
  return {
    id: caseDef.id,
    kind: caseDef.kind,
    status,
    nonScoring: NON_SCORING_STATUSES.has(status),
    source: caseDef.source,
    cwd: caseDef.cwd ?? '.',
    argv: caseDef.argv,
    packageName: caseDef.packageName,
    noTestPackages: caseDef.noTestPackages ?? [],
    artifacts: (caseDef.artifacts ?? []).map((artifact) => artifactState(root, artifact)),
    testIds: caseDef.discoveredTestIds ?? [],
    samples,
    stats: status === 'passed' ? summarize(scoringSamples) : null,
    disqualifiers: [...new Set(disqualifiers)]
  };
}

function createClone(sourceRoot, ref, workRoot) {
  const cloneDir = join(workRoot, 'repo');
  mkdirSync(workRoot, { recursive: true });
  runSync(['git', 'clone', '--local', '--no-hardlinks', sourceRoot, cloneDir], sourceRoot);
  runSync(['git', 'checkout', '--detach', ref], cloneDir);
  return cloneDir;
}

function defaultArtifactRoot(sourceRoot, runId) {
  const res = runSync(['git', 'rev-parse', '--git-path', `invoker-build-bench/${runId}`], sourceRoot, true);
  if (res.status === 0 && res.stdout.trim()) return resolve(sourceRoot, res.stdout.trim());
  return join(tmpdir(), `invoker-build-bench-${runId}`);
}

async function installDependencies(root, env, rawDir) {
  const logPath = join(rawDir, 'dependency-setup.log');
  const result = await runProcess(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(dirname(rawDir), 'pnpm-store')], {
    cwd: root,
    env,
    timeoutMs: 20 * 60 * 1000
  });
  writeFileSync(logPath, [
    '$ pnpm install --frozen-lockfile --ignore-scripts --store-dir <task-local>',
    `status=${result.exitCode === 0 ? 'passed' : 'failed'} exitCode=${result.exitCode} elapsedMs=${result.elapsedMs.toFixed(3)}`,
    '',
    result.stdout,
    result.stderr
  ].join('\n'));
  return {
    status: result.exitCode === 0 ? 'passed' : (result.timedOut ? 'timed_out' : 'failed'),
    elapsedMs: result.elapsedMs,
    exitCode: result.exitCode,
    logPath,
    logSha256: hashFile(logPath)
  };
}

function findPredecessorReceipt(root, outPath) {
  const envPath = process.env.BUILD_BENCH_PREDECESSOR_RECEIPT;
  if (envPath && existsSync(envPath)) return { status: 'consumed', path: envPath, sha256: hashFile(envPath) };
  const resultDir = dirname(outPath);
  if (!existsSync(resultDir)) return { status: 'none-found' };
  const candidates = readdirSync(resultDir)
    .filter((name) => name.endsWith('.json') && join(resultDir, name) !== outPath)
    .sort();
  if (candidates.length === 0) return { status: 'none-found' };
  const path = join(resultDir, candidates[candidates.length - 1]);
  return { status: 'consumed', path, sha256: hashFile(path) };
}

function receiptStatus(cases, setup) {
  if (setup && setup.status !== 'passed') return 'blocked';
  if (cases.some((c) => BLOCKING_STATUSES.has(c.status))) return 'blocked';
  return 'neutral';
}

async function runStage(opts, mode) {
  const sourceRoot = realpathSync(resolve(opts.root ?? ROOT));
  const casesPath = resolve(opts.cases ?? DEFAULT_CASES);
  const suite = opts.suite ?? readJson(casesPath).suite ?? 'migration';
  const repetitions = Number(opts.repetitions ?? 1);
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('--repetitions must be a positive integer');
  const outPath = resolve(opts.out ?? DEFAULT_RESULT);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = resolve(opts.artifacts ?? defaultArtifactRoot(sourceRoot, runId));
  const rawDir = join(artifactRoot, 'logs');
  const cacheRoot = join(artifactRoot, 'cache');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });

  if (mode === 'baseline' && !opts.ref) throw new Error('baseline requires --ref');
  if (opts.ref) assertDescendsFrom(sourceRoot, opts.ref);

  const benchmarkRoot = opts['no-clone']
    ? sourceRoot
    : createClone(sourceRoot, opts.ref ?? currentSha(sourceRoot), join(artifactRoot, 'work'));
  const env = taskEnv(cacheRoot);
  const { manifest, cases } = loadCases(benchmarkRoot, casesPath, suite);
  const setup = opts['no-clone'] ? null : await installDependencies(benchmarkRoot, env, rawDir);
  const caseResults = [];
  if (!setup || setup.status === 'passed') {
    for (const caseDef of cases) {
      caseResults.push(await runCase(caseDef, benchmarkRoot, env, rawDir, repetitions));
    }
  }

  const receipt = {
    schemaVersion: 1,
    stageId: manifest.stageId ?? '01-benchmark',
    mode,
    suite,
    status: receiptStatus(caseResults, setup),
    speedupClaim: null,
    originalReference: manifest.originalReference,
    requestedRef: opts.ref ?? null,
    actualSha: currentSha(benchmarkRoot),
    sourceCheckout: {
      root: benchmarkRoot,
      dirty: dirtyStatus(benchmarkRoot),
      sourceDigest: treeDigest(benchmarkRoot),
      lockfileDigest: hashFile(join(benchmarkRoot, 'pnpm-lock.yaml')),
      commandDigest: commandDigest(benchmarkRoot, cases)
    },
    predecessorReceipt: findPredecessorReceipt(sourceRoot, outPath),
    manifest: {
      path: casesPath,
      sha256: hashFile(casesPath),
      stageId: manifest.stageId,
      recipe: manifest.recipe
    },
    environment: {
      platform: platformInfo(),
      toolVersions: toolVersions(benchmarkRoot),
      parallelism: {
        requested: process.env.INVOKER_BUILD_BENCH_PARALLELISM ?? 'serial',
        effective: 'serial'
      },
      cachePolicy: manifest.cachePolicy,
      rawArtifactRoot: artifactRoot
    },
    dependencySetup: setup,
    inventory: {
      packages: workspacePackages(benchmarkRoot).map((pkg) => ({
        name: pkg.name,
        dir: pkg.dir,
        hasBuild: Boolean(pkg.scripts.build),
        hasTest: Boolean(pkg.scripts.test),
        literalNoopTestScript: pkg.scripts.test ? isLiteralNoopTest(pkg.scripts.test) : false,
        discoveredTestIds: discoverTestIds(benchmarkRoot, pkg.dir)
      })),
      ciAndReleaseEntryPoints: discoverEntryPoints(benchmarkRoot)
    },
    cases: caseResults,
    disqualifiers: [
      ...caseResults.filter((c) => c.nonScoring).map((c) => `${c.id}: ${c.status}`),
      ...(setup && setup.status !== 'passed' ? [`dependency setup: ${setup.status}`] : [])
    ],
    summary: summarizeReceipt(caseResults)
  };
  writeJson(outPath, receipt);
  process.stdout.write(`${outPath}\n`);
  if (opts.strict && receipt.status !== 'neutral') process.exitCode = 1;
  return receipt;
}

function discoverEntryPoints(root) {
  const packageJson = existsSync(join(root, 'package.json')) ? readJson(join(root, 'package.json')) : { scripts: {} };
  const workflowsDir = join(root, '.github/workflows');
  const workflows = existsSync(workflowsDir)
    ? readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).sort()
    : [];
  const scripts = packageJson.scripts ?? {};
  return {
    rootScripts: Object.fromEntries(Object.entries(scripts).filter(([name]) => /^(build|dist|check|test|lint)/.test(name))),
    workflows: workflows.map((name) => ({
      path: `.github/workflows/${name}`,
      sha256: hashFile(join(workflowsDir, name))
    })),
    releaseScripts: Object.fromEntries(Object.entries(scripts).filter(([name]) => /^dist|release/.test(name)))
  };
}

function summarizeReceipt(caseResults) {
  return {
    totalCases: caseResults.length,
    byStatus: caseResults.reduce((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    }, {}),
    scoringCases: caseResults.filter((c) => !c.nonScoring).length,
    nonScoringCases: caseResults.filter((c) => c.nonScoring).length
  };
}

function comparableCaseShape(c) {
  return {
    id: c.id,
    argv: c.argv,
    artifacts: (c.artifacts ?? []).map((a) => a.path),
    testIds: c.testIds ?? []
  };
}

function compareReceipts(opts) {
  const baseline = readJson(resolve(opts.baseline));
  const candidate = readJson(resolve(opts.candidate));
  const byId = new Map(candidate.cases.map((c) => [c.id, c]));
  const comparisons = [];
  const disqualifiers = [];
  for (const baseCase of baseline.cases) {
    const candCase = byId.get(baseCase.id);
    if (!candCase) {
      disqualifiers.push(`${baseCase.id}: missing candidate case`);
      continue;
    }
    if (JSON.stringify(comparableCaseShape(baseCase)) !== JSON.stringify(comparableCaseShape(candCase))) {
      disqualifiers.push(`${baseCase.id}: mismatched scope`);
      continue;
    }
    if (baseCase.status !== 'passed' || candCase.status !== 'passed') {
      disqualifiers.push(`${baseCase.id}: non-scoring status baseline=${baseCase.status} candidate=${candCase.status}`);
      continue;
    }
    const baselineMedian = baseCase.stats?.medianMs;
    const candidateMedian = candCase.stats?.medianMs;
    if (!baselineMedian || !candidateMedian) {
      disqualifiers.push(`${baseCase.id}: missing median`);
      continue;
    }
    const improvement = 100 * (baselineMedian - candidateMedian) / baselineMedian;
    const speedup = baselineMedian / candidateMedian;
    let status = 'neutral';
    if ((candidateMedian - baselineMedian) / baselineMedian > 0.10 && candidateMedian - baselineMedian > 1000) status = 'regressed';
    else if (improvement > 0) status = 'improved';
    comparisons.push({ id: baseCase.id, baselineMedian, candidateMedian, improvementPercent: improvement, speedup, status });
  }
  const receipt = {
    schemaVersion: 1,
    mode: 'compare',
    status: disqualifiers.length > 0 ? 'incomparable' : (comparisons.some((c) => c.status === 'regressed') ? 'regressed' : 'neutral'),
    baseline: resolve(opts.baseline),
    candidate: resolve(opts.candidate),
    comparisons,
    disqualifiers
  };
  if (opts.out) writeJson(resolve(opts.out), receipt);
  else process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status === 'incomparable' || receipt.status === 'regressed') process.exitCode = 2;
}

function runInventory(opts) {
  const root = realpathSync(resolve(opts.root ?? ROOT));
  const casesPath = resolve(opts.cases ?? DEFAULT_CASES);
  const suite = opts.suite ?? readJson(casesPath).suite ?? 'migration';
  const { manifest, cases } = loadCases(root, casesPath, suite);
  const inventory = {
    schemaVersion: 1,
    stageId: manifest.stageId,
    suite,
    root,
    sha: currentSha(root),
    dirty: dirtyStatus(root),
    sourceDigest: treeDigest(root),
    lockfileDigest: hashFile(join(root, 'pnpm-lock.yaml')),
    platform: platformInfo(),
    toolVersions: toolVersions(root),
    packages: workspacePackages(root).map((pkg) => ({
      ...pkg,
      literalNoopTestScript: pkg.scripts.test ? isLiteralNoopTest(pkg.scripts.test) : false,
      discoveredTestIds: discoverTestIds(root, pkg.dir)
    })),
    entryPoints: discoverEntryPoints(root),
    cases
  };
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}

function runSelfTest() {
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts/build-bench.test.mjs')], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  process.exitCode = res.status ?? 1;
}

async function main() {
  const { command, opts } = parseArgs(process.argv);
  try {
    if (command === 'inventory') runInventory(opts);
    else if (command === 'baseline') await runStage(opts, 'baseline');
    else if (command === 'stage') await runStage(opts, 'stage');
    else if (command === 'compare') compareReceipts(opts);
    else if (command === 'self-test') runSelfTest();
    else {
      console.error(usage());
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`build-bench: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
