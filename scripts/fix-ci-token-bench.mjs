#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const FIXTURES_DIR = join(__dirname, 'fixtures', 'fix-ci-token-bench');
export const MARKER_PATH = join(FIXTURES_DIR, 'codex-poll-loop-marker.sh');
export const SCENARIOS_PATH = join(FIXTURES_DIR, 'scenarios.json');
export const AUDIT_PATH = join(__dirname, 'codex-session-audit.py');

export const BENCH_PROMPT = 'Repair the failing CI job in this workspace, then verify it.';
export const SHARED_PROFILE = 'shared';
export const CANDIDATES = ['proposed', 'baseline'];

export const AVG_REPRESENTATIVE_TOKEN_LIMIT = 500_000;
export const MAX_SESSION_TOKEN_LIMIT = 3_000_000;

const ROLLOUT_TIMESTAMP = '2026-01-01T00-00-00';

const USAGE = [
  'usage: fix-ci-token-bench.mjs [--gate [--candidate proposed|baseline]] | --report [--candidate ...] | --self-test',
  '',
  'Runs the offline fake-codex poll-loop simulator across scenarios.json and',
  'reads each simulated session back through scripts/codex-session-audit.py.',
  'Token totals are never parsed here directly: the audit script is the single',
  'parser of record, already validated against real production rollout files.',
  '',
  '--gate fails when the average total_tokens over representative scenarios is',
  `at or above ${AVG_REPRESENTATIVE_TOKEN_LIMIT}, or when any single scenario`,
  `reaches ${MAX_SESSION_TOKEN_LIMIT}.`,
].join('\n');

export function rolloutFileName(scenarioId) {
  const safeId = String(scenarioId).replace(/[^a-zA-Z0-9-]/g, '-');
  return `rollout-${ROLLOUT_TIMESTAMP}-${safeId}.jsonl`;
}

export function loadScenarios(scenariosPath = SCENARIOS_PATH) {
  const parsed = JSON.parse(readFileSync(scenariosPath, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`No scenarios found in ${scenariosPath}`);
  }
  return parsed;
}

export function scenariosForCandidate(scenarios, candidate) {
  if (!CANDIDATES.includes(candidate)) {
    throw new Error(`Unknown candidate "${candidate}" (expected one of ${CANDIDATES.join(', ')})`);
  }
  const selected = scenarios.filter(
    (scenario) => scenario.profile === candidate || scenario.profile === SHARED_PROFILE,
  );
  if (selected.length === 0) {
    throw new Error(`No scenarios match candidate "${candidate}"`);
  }
  return selected;
}

export function runScenario(scenario, options = {}) {
  const markerPath = options.markerPath ?? MARKER_PATH;
  const auditPath = options.auditPath ?? AUDIT_PATH;

  const sessionDir = mkdtempSync(join(tmpdir(), 'fix-ci-token-bench-'));
  try {
    const simulated = spawnSync('bash', [markerPath, 'exec', '--json', BENCH_PROMPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...(scenario.env ?? {}) },
      maxBuffer: 256 * 1024 * 1024,
    });
    if (simulated.error) throw simulated.error;
    if (simulated.status !== 0) {
      throw new Error(`Simulator exited ${simulated.status} for ${scenario.id}: ${simulated.stderr}`);
    }

    const rolloutPath = join(sessionDir, rolloutFileName(`${scenario.id}-${scenario.profile}`));
    writeFileSync(rolloutPath, simulated.stdout);

    const audited = spawnSync('python3', [auditPath, '--session-dir', sessionDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (audited.error) throw audited.error;
    if (audited.status !== 0) {
      throw new Error(`codex-session-audit.py exited ${audited.status} for ${scenario.id}: ${audited.stderr}`);
    }

    const rows = JSON.parse(audited.stdout);
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error(
        `Expected exactly one audited session for ${scenario.id}, got ${Array.isArray(rows) ? rows.length : 'non-array'}`,
      );
    }

    return {
      id: scenario.id,
      profile: scenario.profile,
      representative: scenario.representative === true,
      totalTokens: rows[0].total_tokens ?? 0,
      turns: countPollTurns(simulated.stdout),
    };
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

export function countPollTurns(stdout) {
  let turns = 0;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Simulator emitted a non-JSON line: ${line.slice(0, 200)}`);
    }
    if (row?.type === 'event_msg' && row?.payload?.type === 'token_count') turns += 1;
  }
  return turns;
}

export function evaluate(results) {
  const representative = results.filter((result) => result.representative);
  const averageRepresentativeTokens = representative.length
    ? representative.reduce((sum, result) => sum + result.totalTokens, 0) / representative.length
    : 0;
  const worst = results.reduce(
    (acc, result) => (result.totalTokens > acc.totalTokens ? result : acc),
    results[0],
  );

  const failures = [];
  if (representative.length === 0) {
    failures.push('No representative scenarios were run, so the average check is unprovable.');
  }
  if (averageRepresentativeTokens >= AVG_REPRESENTATIVE_TOKEN_LIMIT) {
    failures.push(
      `average-representative-tokens: ${Math.round(averageRepresentativeTokens)} >= ${AVG_REPRESENTATIVE_TOKEN_LIMIT}`,
    );
  }
  if (worst.totalTokens >= MAX_SESSION_TOKEN_LIMIT) {
    failures.push(
      `max-single-session-tokens: ${worst.id} (${worst.profile}) spent ${worst.totalTokens} >= ${MAX_SESSION_TOKEN_LIMIT}`,
    );
  }

  return {
    ok: failures.length === 0,
    averageRepresentativeTokens,
    representativeCount: representative.length,
    maxTotalTokens: worst.totalTokens,
    maxScenario: `${worst.id} (${worst.profile})`,
    failures,
  };
}

export function runCandidate(candidate, options = {}) {
  const scenarios = scenariosForCandidate(options.scenarios ?? loadScenarios(), candidate);
  return scenarios.map((scenario) => runScenario(scenario, options));
}

function parseCandidate(argv) {
  const index = argv.indexOf('--candidate');
  if (index === -1) return 'proposed';
  const value = argv[index + 1];
  if (!value) throw new Error('--candidate requires a value (proposed or baseline)');
  return value;
}

function formatResults(candidate, results, verdict) {
  const lines = [`fix-ci token bench — candidate: ${candidate}`];
  for (const result of results) {
    const tag = result.representative ? 'representative' : 'ceiling-check';
    lines.push(
      `  ${result.id} [${result.profile}] ${tag}: ${result.turns} poll turns, ${result.totalTokens} tokens`,
    );
  }
  lines.push(
    `  avg over ${verdict.representativeCount} representative: ${Math.round(verdict.averageRepresentativeTokens)} (limit ${AVG_REPRESENTATIVE_TOKEN_LIMIT})`,
  );
  lines.push(
    `  max over all scenarios: ${verdict.maxTotalTokens} in ${verdict.maxScenario} (limit ${MAX_SESSION_TOKEN_LIMIT})`,
  );
  return lines.join('\n');
}

function gate(candidate) {
  const results = runCandidate(candidate);
  const verdict = evaluate(results);
  console.log(formatResults(candidate, results, verdict));
  if (!verdict.ok) {
    console.error(`\nFAIL (${candidate}):`);
    for (const failure of verdict.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nPASS (${candidate}): both token budgets hold.`);
}

function report(candidate) {
  const results = runCandidate(candidate);
  console.log(JSON.stringify({ candidate, results, verdict: evaluate(results) }, null, 2));
}

function selfTest() {
  const failures = [];
  const check = (label, condition) => {
    if (!condition) failures.push(label);
  };

  check(
    'rollout file name matches the pattern codex-session-audit.py globs for',
    /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-.+\.jsonl$/.test(rolloutFileName('normal speed/x')),
  );

  const tinyEnv = {
    INVOKER_FIX_CI_BENCH_BASE_TOKENS: '1000',
    INVOKER_FIX_CI_BENCH_BYTES_PER_POLL: '100',
    INVOKER_FIX_CI_BENCH_MAX_CONTEXT_TOKENS: '1000000',
  };
  const synthetic = [
    {
      id: 'synthetic-three-turns',
      profile: 'proposed',
      representative: true,
      env: { ...tinyEnv, INVOKER_FIX_CI_BENCH_WALLCLOCK_S: '30', INVOKER_FIX_CI_BENCH_POLL_INTERVAL_S: '10' },
      expectedTurns: 3,
      expectedTokens: 1100 + 1200 + 1300,
    },
    {
      id: 'synthetic-partial-interval-rounds-up',
      profile: 'proposed',
      representative: true,
      env: { ...tinyEnv, INVOKER_FIX_CI_BENCH_WALLCLOCK_S: '25', INVOKER_FIX_CI_BENCH_POLL_INTERVAL_S: '10' },
      expectedTurns: 3,
      expectedTokens: 1100 + 1200 + 1300,
    },
    {
      id: 'synthetic-turn-cap-binds',
      profile: 'proposed',
      representative: false,
      env: {
        ...tinyEnv,
        INVOKER_FIX_CI_BENCH_WALLCLOCK_S: '100',
        INVOKER_FIX_CI_BENCH_POLL_INTERVAL_S: '10',
        INVOKER_FIX_CI_BENCH_MAX_TURNS: '2',
      },
      expectedTurns: 2,
      expectedTokens: 1100 + 1200,
    },
    {
      id: 'synthetic-context-window-caps-per-turn',
      profile: 'proposed',
      representative: false,
      env: {
        ...tinyEnv,
        INVOKER_FIX_CI_BENCH_MAX_CONTEXT_TOKENS: '1150',
        INVOKER_FIX_CI_BENCH_WALLCLOCK_S: '30',
        INVOKER_FIX_CI_BENCH_POLL_INTERVAL_S: '10',
      },
      expectedTurns: 3,
      expectedTokens: 1100 + 1150 + 1150,
    },
    {
      id: 'synthetic-no-poll-turns',
      profile: 'proposed',
      representative: true,
      env: { ...tinyEnv, INVOKER_FIX_CI_BENCH_WALLCLOCK_S: '0' },
      expectedTurns: 0,
      expectedTokens: 0,
    },
    {
      id: 'synthetic-never-completes-still-audits',
      profile: 'proposed',
      representative: false,
      env: {
        ...tinyEnv,
        INVOKER_FIX_CI_BENCH_WALLCLOCK_S: '100',
        INVOKER_FIX_CI_BENCH_POLL_INTERVAL_S: '10',
        INVOKER_FIX_CI_BENCH_NEVER_COMPLETES: '1',
      },
      expectedTurns: 10,
      expectedTokens: 10 * 1000 + 100 * 55,
    },
  ];

  for (const scenario of synthetic) {
    const result = runScenario(scenario);
    check(`${scenario.id}: ${scenario.expectedTurns} poll turns`, result.turns === scenario.expectedTurns);
    check(
      `${scenario.id}: total_tokens read back as ${scenario.expectedTokens} (got ${result.totalTokens})`,
      result.totalTokens === scenario.expectedTokens,
    );
  }

  const overAverage = evaluate([
    { id: 'a', profile: 'x', representative: true, totalTokens: 600_000 },
    { id: 'b', profile: 'x', representative: false, totalTokens: 1 },
  ]);
  check('evaluate: flags an over-budget representative average', !overAverage.ok);
  check(
    'evaluate: names the average check',
    overAverage.failures.some((failure) => failure.startsWith('average-representative-tokens')),
  );

  const overCeiling = evaluate([
    { id: 'a', profile: 'x', representative: true, totalTokens: 1000 },
    { id: 'b', profile: 'x', representative: false, totalTokens: 9_000_000 },
  ]);
  check('evaluate: a non-representative scenario still trips the ceiling', !overCeiling.ok);
  check(
    'evaluate: names the ceiling check',
    overCeiling.failures.some((failure) => failure.startsWith('max-single-session-tokens')),
  );

  const withinBudget = evaluate([
    { id: 'a', profile: 'x', representative: true, totalTokens: 1000 },
    { id: 'b', profile: 'x', representative: false, totalTokens: 2_000_000 },
  ]);
  check('evaluate: passes when both budgets hold', withinBudget.ok);

  const scenarios = loadScenarios();
  for (const candidate of CANDIDATES) {
    const selected = scenariosForCandidate(scenarios, candidate);
    check(
      `scenariosForCandidate(${candidate}): excludes the other profile`,
      selected.every((scenario) => scenario.profile === candidate || scenario.profile === SHARED_PROFILE),
    );
    check(
      `scenariosForCandidate(${candidate}): includes the shared-profile scenario`,
      selected.some((scenario) => scenario.profile === SHARED_PROFILE),
    );
  }

  const selfPath = fileURLToPath(import.meta.url);
  const proposedGate = spawnSync(process.execPath, [selfPath, '--gate', '--candidate', 'proposed'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const baselineGate = spawnSync(process.execPath, [selfPath, '--gate', '--candidate', 'baseline'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  check(
    `--gate --candidate proposed exits 0 (got ${proposedGate.status}): ${proposedGate.stderr}`,
    proposedGate.status === 0,
  );
  check(
    `--gate --candidate baseline exits nonzero (got ${baselineGate.status})`,
    baselineGate.status !== 0,
  );
  check(
    '--gate --candidate baseline explains which budget it blew',
    /max-single-session-tokens|average-representative-tokens/.test(baselineGate.stderr),
  );

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        syntheticScenarios: synthetic.length,
        gateDiscriminates: { proposed: proposedGate.status, baseline: baselineGate.status },
      },
      null,
      2,
    ),
  );
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fix-ci-token-bench.mjs');

if (isMain) {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes('--self-test')) {
      selfTest();
    } else if (argv.includes('--gate')) {
      gate(parseCandidate(argv));
    } else if (argv.includes('--report')) {
      report(parseCandidate(argv));
    } else {
      console.error(USAGE);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`fix-ci-token-bench: ${error.message}`);
    process.exitCode = 1;
  }
}
