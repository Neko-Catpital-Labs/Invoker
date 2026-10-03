import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function wiredByRunner() {
  const text = readFileSync(join(repoRoot, 'scripts/run-root-script-tests.sh'), 'utf8');
  return new Set([...text.matchAll(/^(?:bash|node|python3) (scripts\/repro\/\S+)/gm)].map((match) => match[1]));
}

const FAILING_ON_MASTER = new Map([
  ['scripts/repro/repro-admin-bypass-ledger-gap.sh', 'ran on this tree: 3 of 4 ledger assertions failed (expected counts 2 and 1, got 0; repair_in_flight stayed false)'],
  ['scripts/repro/repro-admin-bypass-ledger-gap.py', 'ran on this tree: 3 of 4 ledger assertions failed (expected counts 2 and 1, got 0; repair_in_flight stayed false)'],
  ['scripts/repro-pr-body-tool-cache-permissions.sh', 'ran on this tree: chmod: --: No such file or directory'],
  ['scripts/repro/repro-coderabbit-pr2634-default-preset-guard-scope.sh', 'ran on this tree: missing expected default-preset missing-tool branch'],
  ['scripts/repro/repro-mergify-admin-requeue-head-sha-reset.py', 'ran on this tree: FAILED (failures=1)'],
  ['scripts/repro/repro-host-cwd-safety.sh', 'ran here and exited 1 during setup. git config --get init.defaultBranch is main, and the script pushes origin master with output discarded, so the assertion never ran.'],
  ['scripts/repro/repro-deploy-do1-kill-script-self-match.sh', 'ran here and exited 1 after printing: BUGGY matcher (current deploy-do1.sh logic)'],
]);

const REFUSED_WITHOUT_DB = new Map([
  ['scripts/repro/repro-stale-descendant-after-fix-state.sh', 'ran here and exited 2: set INVOKER_DB_PATH or INVOKER_DB_DIR to an isolated test database. It then queries one named workflow. Not a hermetic case.'],
]);

const UNPROVEN_ENV = new Map([
  ['scripts/repro/repro-coderabbit-pr4815-db-dir-mismatch.sh', 'pnpm --filter @invoker/data-store exec vitest failed before the assertion: Command "vitest" not found. This worktree has no vitest binary (node_modules/.bin/vitest and packages/data-store/node_modules/.bin/vitest are absent).'],
  ['scripts/repro/repro-workflow-resume-fk.sh', 'esbuild bundle failed before the assertion: Could not resolve "@invoker/transport". This worktree node_modules is a symlink and does not resolve workspace packages for that bundle.'],
  ['scripts/repro/repro-workflow-resume-fk-driver.mjs', 'node import of packages/data-store/src/sqlite-adapter.ts failed before the assertion: TypeScript parameter property is not supported in strip-only mode. The shell wrapper bundles it with esbuild, and that bundle also failed (Could not resolve "@invoker/transport").'],
  ['scripts/repro/repro-global-touch.sh', 'esbuild failed before the assertion: Could not resolve "neverthrow" while bundling the temp repro. This worktree node_modules is a symlink.'],
  ['scripts/repro/repro-db-maintenance-starvation.mjs', 'node --mode=after failed before the assertion: esbuild Could not resolve "@invoker/transport". scripts/evals/db-maintenance-starvation.test.mjs is already in the required runner and checks this file\'s source contract; it does not execute --mode=after.'],
  ['scripts/repro/repro-ui-startup-bundle-size.sh', 'not executed. Default mode exits 0 only after pnpm --filter @invoker/ui build and an entry-chunk byte budget. That build was not run.'],
  ['scripts/repro/repro-readonly-follower-live-wal.sh', 'not executed. The script starts with pnpm --filter @invoker/data-store build. That build was not run.'],
  ['scripts/repro/repro-workflow-mutation-status-source-of-truth.mjs', 'not executed. Usage requires --expect-bug or --expect-fixed plus packages/data-store, app, and ui dist files. Those dist files were not built here.'],
  ['scripts/repro/repro-workflow-mutation-status-source-of-truth.sh', 'not executed. It launches the sibling mjs, which requires --expect-fixed and built dist files.'],
]);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'fixtures') continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(sh|mjs|js|py)$/.test(name)) acc.push(full);
  }
  return acc;
}

export function listReproFiles() {
  const files = walk(join(repoRoot, 'scripts/repro'));
  for (const name of readdirSync(join(repoRoot, 'scripts'))) {
    if (name.startsWith('repro-') && /\.(sh|mjs|js|py)$/.test(name)) {
      files.push(join(repoRoot, 'scripts', name));
    }
  }
  return files.map((file) => relative(repoRoot, file)).sort();
}

function codeOf(text) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#');
    })
    .join('\n');
}

function mentionedPaths(text) {
  return [...text.matchAll(/(?:scripts|packages)\/[A-Za-z0-9_./-]+\.(?:sh|mjs|js|py|yml|yaml)/g)].map((m) => m[0]);
}

function ciReached() {
  const seen = new Set();
  const queue = ['.github/workflows/ci.yml'];
  const manifest = readFileSync(join(repoRoot, 'scripts/test-suites/proof-e2e.manifest'), 'utf8');
  for (const line of manifest.split('\n')) {
    const trimmed = line.split('#')[0].trim();
    if (trimmed) queue.push(`scripts/test-suites/${trimmed}`);
  }
  const blobParts = [];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    const full = join(repoRoot, rel);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    seen.add(rel);
    const text = readFileSync(full, 'utf8');
    blobParts.push(text);
    for (const next of mentionedPaths(text)) {
      if (next.startsWith('packages/')) continue;
      if (!seen.has(next)) queue.push(next);
    }
  }
  return { files: seen, blob: blobParts.join('\n') };
}

function chaosCatalog() {
  const text = readFileSync(join(repoRoot, 'scripts/e2e-chaos/run-overload.sh'), 'utf8');
  const ids = new Set();
  let inCatalog = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('catalog()')) {
      inCatalog = true;
      continue;
    }
    if (inCatalog && line.startsWith('}')) break;
    if (inCatalog && line.includes('|')) ids.add(line.split('|')[0].trim());
  }
  return ids;
}

function packageDirs() {
  const dirs = [];
  for (const name of readdirSync(join(repoRoot, 'packages'))) {
    const dir = join(repoRoot, 'packages', name);
    if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
  }
  return dirs;
}

function testFilesUnder(dir) {
  const out = [];
  const walkDir = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name !== 'node_modules' && name !== 'dist') walkDir(full);
      } else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) out.push(full);
    }
  };
  walkDir(dir);
  return out;
}

function resolveVitestFile(code) {
  const candidates = new Set();
  for (const match of code.matchAll(/(?:packages\/)?[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?/g)) {
    candidates.add(match[0]);
  }
  for (const match of code.matchAll(/\$ROOT(?:_DIR)?\/(packages\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)/g)) {
    candidates.add(match[1]);
  }
  const packages = packageDirs();
  for (const rel of candidates) {
    const direct = join(repoRoot, rel);
    if (existsSync(direct) && statSync(direct).isFile()) return relative(repoRoot, direct);
    for (const pkg of packages) {
      const nested = join(pkg, rel);
      if (existsSync(nested) && statSync(nested).isFile()) return relative(repoRoot, nested);
    }
    for (const pkg of packages) {
      const hit = testFilesUnder(pkg).find((file) => file.endsWith(`/${rel}`) || file.endsWith(rel));
      if (hit) return relative(repoRoot, hit);
    }
  }
  return null;
}

function packageTestRunsVitest(testFile) {
  const parts = testFile.split('/');
  if (parts[0] !== 'packages') return false;
  const pkgDir = join(repoRoot, parts[0], parts[1]);
  const manifestPath = join(pkgDir, 'package.json');
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const script = String(manifest.scripts?.test ?? '');
  if (script.includes('vitest')) return true;
  const wrapper = script.match(/node\s+(\S+\.(?:mjs|cjs|js))/);
  if (!wrapper) return false;
  const wrapperPath = join(pkgDir, wrapper[1].replace(/^\.\//, ''));
  return existsSync(wrapperPath) && readFileSync(wrapperPath, 'utf8').includes('vitest');
}

function playwrightSpecs(code) {
  return [...code.matchAll(/e2e\/[\w./-]+\.spec\.ts/g)].map((match) => match[0]);
}

function manualPlaywrightSpecs() {
  const text = readFileSync(join(repoRoot, 'scripts/repro/repro-ci-playwright-shard-inventory.mjs'), 'utf8');
  return new Set([...text.matchAll(/'([^']+\.spec\.ts)'/g)].map((match) => match[1]));
}

export function classifyRepros() {
  const { files: reached, blob } = ciReached();
  const catalog = chaosCatalog();
  const wired = wiredByRunner();
  const rows = [];
  for (const rel of listReproFiles()) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    const code = codeOf(text);
    if (wired.has(rel)) {
      rows.push({ path: rel, disposition: 'wired-required', proof: 'scripts/run-root-script-tests.sh runs it, and required-fast / Vitest Workspace runs that script via scripts/test-suites/required/10-vitest-workspace.sh' });
      continue;
    }
    if (reached.has(rel)) {
      rows.push({ path: rel, disposition: 'already-wired', proof: 'path is reached from .github/workflows/ci.yml or the e2e proof manifest' });
      continue;
    }
    if (FAILING_ON_MASTER.has(rel)) {
      rows.push({ path: rel, disposition: 'excluded-failing', proof: FAILING_ON_MASTER.get(rel) });
      continue;
    }
    if (REFUSED_WITHOUT_DB.has(rel)) {
      rows.push({ path: rel, disposition: 'excluded-live', proof: REFUSED_WITHOUT_DB.get(rel) });
      continue;
    }
    if (UNPROVEN_ENV.has(rel)) {
      rows.push({ path: rel, disposition: 'excluded-unproven-env', proof: UNPROVEN_ENV.get(rel) });
      continue;
    }
    const scenario = code.match(/INVOKER_CHAOS_OVERLOAD_SCENARIO=['"]?([A-Za-z0-9_@-]+)/);
    if (scenario && code.includes('e2e-chaos/run-overload.sh')) {
      const id = scenario[1];
      const base = id.endsWith('@nightly') ? id.slice(0, -'@nightly'.length) : id;
      if (catalog.has(id)) {
        rows.push({
          path: rel,
          disposition: 'covered-by-chaos-suite',
          proof: `scenario ${id} is in scripts/e2e-chaos/run-overload.sh catalog(); scheduled / Chaos Overload Repros runs scripts/test-suites/optional/33-e2e-chaos-overload.sh with no scenario filter`,
        });
      } else if (catalog.has(base)) {
        rows.push({
          path: rel,
          disposition: 'excluded-scale-duplicate',
          proof: `${id} is the nightly scale clone of catalog row ${base}; expand_catalog keeps the same handler and only raises workflow and burst counts, and the scheduled job runs the base row`,
        });
      } else {
        rows.push({ path: rel, disposition: 'excluded-outdated', proof: `scenario ${id} is not in the chaos catalog` });
      }
      continue;
    }
    const dry = code.match(/scripts\/e2e-dry-run\/cases\/([\w.-]+\.sh)/);
    if (dry && [...reached].some((file) => file.endsWith('.sh') && readFileSync(join(repoRoot, file), 'utf8').includes(dry[1]))) {
      rows.push({ path: rel, disposition: 'already-wired', proof: `${dry[1]} is listed by a suite already reached from CI` });
      continue;
    }
    const specs = playwrightSpecs(code);
    if (specs.length && specs.every((spec) => existsSync(join(repoRoot, 'packages/app', spec)) && blob.includes(spec))) {
      const manual = manualPlaywrightSpecs();
      const manualHit = specs.find((spec) => manual.has(spec.replace(/^e2e\//, '')));
      rows.push({
        path: rel,
        disposition: manualHit ? 'excluded-manual-playwright' : 'covered-by-playwright',
        proof: manualHit
          ? `${manualHit} is on the manual-only shard allowlist`
          : `${specs.join(', ')} are listed in .github/workflows/ci.yml playwright shards`,
      });
      continue;
    }
    const vitest = /vitest run|pnpm[^\n]{0,160}\btest\b/.test(code);
    const vitestFile = vitest ? resolveVitestFile(code) : null;
    if (vitestFile && vitestFile.startsWith('packages/app/e2e/')) {
      const base = vitestFile.split('/').pop();
      const manual = readFileSync(join(repoRoot, 'scripts/repro/repro-ci-playwright-shard-inventory.mjs'), 'utf8').includes(`'${vitestFile.replace('packages/app/e2e/', '')}'`);
      rows.push({
        path: rel,
        disposition: manual ? 'excluded-manual-playwright' : 'covered-by-playwright',
        proof: manual
          ? `${vitestFile} is on the manual-only shard allowlist`
          : `${vitestFile} is under packages/app/e2e, and CI runs playwright test with testDir ./e2e`,
      });
      continue;
    }
    if (vitestFile && packageTestRunsVitest(vitestFile) && !vitestFile.includes('/e2e/')) {
      rows.push({
        path: rel,
        disposition: 'covered-by-workspace-vitest',
        proof: `${vitestFile} exists and its package test script runs vitest; required-fast / Vitest Workspace runs pnpm -r test`,
      });
      continue;
    }
    if (vitest && !vitestFile && !/cat >|writeFileSync\(/.test(code)) {
      rows.push({ path: rel, disposition: 'excluded-outdated', proof: 'vitest invocation names a test file that is not on disk' });
      continue;
    }
    if (/\bssh\b/.test(code)) {
      rows.push({ path: rel, disposition: 'excluded-live', proof: 'script body contains ssh' });
      continue;
    }
    if (/invoker-cli|headless-client|run\.sh|\.invoker\}?\/invoker\.db|owner-serve|headless-lib\.sh|invoker_e2e_run_headless/.test(code)) {
      rows.push({ path: rel, disposition: 'excluded-live', proof: 'script drives a live owner, headless client, run.sh, or the home Invoker database' });
      continue;
    }
    if (/\b(electron|xvfb)\b/.test(code)) {
      rows.push({ path: rel, disposition: 'excluded-live', proof: 'script body launches electron or xvfb outside the playwright suite' });
      continue;
    }
    if (/\bdocker\b/.test(code)) {
      rows.push({ path: rel, disposition: 'excluded-live', proof: 'script body uses docker; the dangerous docker suite is opt-in' });
      continue;
    }
    if (/\bgh\b/.test(code) && !/fake/i.test(text)) {
      rows.push({ path: rel, disposition: 'excluded-live', proof: 'script calls gh without a fake gh stub' });
      continue;
    }
    if (/node_modules\/\.bin\/(?:vitest|tsc)|pnpm --filter[^\n]+ exec (?:vitest|tsc)/.test(code)) {
      rows.push({ path: rel, disposition: 'excluded-unproven-env', proof: 'script invokes a package-local vitest or tsc binary. This worktree has no node_modules/.bin/vitest (ls failed), so the assertion never ran.' });
      continue;
    }
    const namedTests = [...code.matchAll(/['"]([^'"]+\.(?:test|spec)\.[jt]sx?)['"]/g)].map((match) => match[1]);
    const resolvedNamed = [...new Set(namedTests.map((name) => resolveVitestFile(name)).filter(Boolean))];
    if (resolvedNamed.length && /['"]test['"]/.test(code) && resolvedNamed.every((file) => packageTestRunsVitest(file) && !file.includes('/e2e/'))) {
      const filter = code.match(/-t['"],\s*['"]([^'"]+)['"]/);
      const filterOk = !filter || resolvedNamed.every((file) => readFileSync(join(repoRoot, file), 'utf8').includes(filter[1]));
      if (filterOk) {
        rows.push({ path: rel, disposition: 'covered-by-workspace-vitest', proof: `${resolvedNamed.join(', ')} exist and their package test script runs vitest${filter ? `; -t ${filter[1]} is text in those files` : ''}. required-fast runs pnpm -r test, which includes those tests without the name filter.` });
        continue;
      }
    }
    if (/git clone \./.test(code)) {
      rows.push({ path: rel, disposition: 'excluded-heavy-clone', proof: 'script runs `git clone .` of this repository. A full object-database clone does not fit required-fast (45 minutes) or the e2e-proof shards (60 minutes). Not claimed to be covered by another test.' });
      continue;
    }
    if (/MIN_SPEEDUP/.test(code)) {
      rows.push({ path: rel, disposition: 'excluded-benchmark', proof: 'pass condition is a wall-clock speedup ratio (MIN_SPEEDUP), which a loaded runner can miss. Not a functional assertion.' });
      continue;
    }
    if (rel.endsWith('worktree-startup-cancellation.mjs')) {
      const files = [
        'packages/execution-engine/src/__tests__/task-runner.test.ts',
        'packages/execution-engine/src/__tests__/worktree-executor.test.ts',
        'packages/execution-engine/src/__tests__/repo-pool.test.ts',
      ];
      const phrase = 'startup cancellation';
      if (files.every((file) => readFileSync(join(repoRoot, file), 'utf8').includes(phrase))) {
        rows.push({ path: rel, disposition: 'covered-by-workspace-vitest', proof: `runs pnpm --filter @invoker/execution-engine test on ${files.join(', ')} with -t '${phrase}'. That phrase is in each file. The package test script is node scripts/run-vitest.mjs, and required-fast runs the whole files via pnpm -r test.` });
        continue;
      }
    }
    if (rel.endsWith('repro-auto-fix-recovery-scan-n-plus-1.mjs')) {
      const testPath = 'packages/execution-engine/src/__tests__/auto-fix-recovery.test.ts';
      const body = readFileSync(join(repoRoot, testPath), 'utf8');
      if (body.includes("describe('listAutoFixRecoveryScanCandidates'") && body.includes('listAutoFixRecoveryScanCandidates')) {
        rows.push({ path: rel, disposition: 'covered-by-workspace-vitest', proof: `${testPath} imports listAutoFixRecoveryScanCandidates and has describe('listAutoFixRecoveryScanCandidates'). The repro requires a before|after argument and is a call-count driver around that same function. @invoker/execution-engine test runs vitest via scripts/run-vitest.mjs; required-fast runs pnpm -r test.` });
        continue;
      }
    }
    if (rel.includes('repro-workflow-resume-terminal')) {
      const testPath = 'packages/execution-engine/src/__tests__/workflow-resume-worker.test.ts';
      const body = readFileSync(join(repoRoot, testPath), 'utf8');
      if (body.includes("from '../workers/workflow-resume-worker.js'") && body.includes('skips a workflow whose only unfinished work is a failed task')) {
        rows.push({ path: rel, disposition: 'covered-by-workspace-vitest', proof: `${testPath} imports createWorkflowResumeTick from the worker and asserts 'skips a workflow whose only unfinished work is a failed task'. The shell repro's TERMINAL_TASK_STATUSES regex no longer matches the source; the behavior is what the worker test executes.` });
        continue;
      }
    }
    const execSuite = code.match(/exec\s+(?:bash\s+)?(scripts\/test-suites\/[\w./-]+\.sh)/);
    if (execSuite && existsSync(join(repoRoot, execSuite[1]))) {
      const suite = readFileSync(join(repoRoot, execSuite[1]), 'utf8');
      const specs = playwrightSpecs(suite);
      if (specs.length && specs.every((spec) => existsSync(join(repoRoot, 'packages/app', spec)) && blob.includes(spec))) {
        rows.push({ path: rel, disposition: 'covered-by-playwright', proof: `${execSuite[1]} runs ${specs.join(', ')}, and those files are listed in .github/workflows/ci.yml playwright shards` });
        continue;
      }
    }
    if (/\/lib\//.test(rel) || /(?:sqljs-query|action-graph-query|worker-routing-driver|capacity-audit)\./.test(rel)) {
      rows.push({ path: rel, disposition: 'excluded-helper', proof: 'library imported by repro entrypoints, not itself a case' });
      continue;
    }
    rows.push({ path: rel, disposition: 'unclassified', proof: '', code });
  }
  const byPath = new Map(rows.map((row) => [row.path, row]));
  for (const row of rows) {
    if (row.disposition !== 'unclassified') continue;
    const exec = row.code.match(/exec\s+(?:bash\s+|node\s+)?(?:(?:"\$ROOT\/|"\$ROOT_DIR\/)|)(scripts\/[\w./-]+\.(?:sh|mjs))/);
    const target = exec?.[1];
    const parent = target ? byPath.get(target) : undefined;
    if (parent && parent.disposition !== 'unclassified') {
      row.disposition = parent.disposition;
      row.proof = `exec ${target}, which is ${parent.disposition}: ${parent.proof}`;
    }
  }
  for (const row of rows) {
    if (row.disposition !== 'unclassified') continue;
    const parent = rows.find((other) => other !== row && other.disposition === 'wired-required' && other.proof && readFileSync(join(repoRoot, other.path), 'utf8').includes(row.path));
    if (parent) {
      row.disposition = 'wired-required';
      row.proof = `${parent.path} runs this file, and that entry is in scripts/run-root-script-tests.sh`;
    }
    delete row.code;
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const rows = classifyRepros();
  const counts = {};
  for (const row of rows) counts[row.disposition] = (counts[row.disposition] ?? 0) + 1;
  console.log(JSON.stringify(counts, null, 2));
  for (const row of rows.filter((row) => row.disposition === 'unclassified')) {
    console.log(row.path);
  }
}
