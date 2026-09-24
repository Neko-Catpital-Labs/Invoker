#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MINER = join(__dirname, 'worker-session-mine.mjs');
const TICKETS = join(__dirname, 'session-efficiency-file-tickets.mjs');

const THRASH_SESSION_ID = '01a082c3-d260-7e90-a870-f4e0a390f604';
const THRASH_WORKFLOW = 'CI regression: 9fe1d9a-required-fast-vitest-workspace';
const STALE_SESSION_ID = 'stale-session-should-not-merge';
const FRESH_SESSION_ID = 'mac-fixture-session-967k';
const REMOTE_SESSION_ID = 'remote-ok-fixture-session';

const failures = [];
function check(label, condition, detail) {
  if (condition) return;
  failures.push(`${label}: ${detail}`);
}

const roots = [];
function freshRoot(name) {
  const dir = mkdtempSync(join(tmpdir(), `session-mine-efficiency-${name}-`));
  roots.push(dir);
  return dir;
}

function thrashyRollout() {
  const rows = [];
  for (let i = 1; i <= 60; i += 1) {
    rows.push(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 200_000 * i, cached_input_tokens: 190_000 * i, output_tokens: 500 * i } },
      },
    }));
  }
  return rows.join('\n');
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function makeReport(host, generatedAt, rows) {
  const day = generatedAt.slice(0, 10);
  const totals = {};
  const sessions = rows.map((row) => ({
    session_id: row.id,
    tool: 'claude',
    origin: 'interactive',
    model: 'claude-opus-5',
    input: 0,
    cache_read: row.total,
    cache_write: 0,
    output: 0,
    total: row.total,
    turns: 120,
    peak_context: row.peak ?? 967_000,
    compactions: 3,
    fork_count: 4,
    median_fork_start_context: 562_000,
    notification_turns: 0,
    first_timestamp: generatedAt,
    last_timestamp: generatedAt,
  }));
  totals[`claude|interactive|claude-opus-5|${day}`] = {
    input: 0,
    cache_read: rows.reduce((sum, row) => sum + row.total, 0),
    cache_write: 0,
    output: 0,
    total: rows.reduce((sum, row) => sum + row.total, 0),
    turns: 120 * rows.length,
  };
  return {
    host,
    generatedAt,
    since: generatedAt.slice(0, 10),
    files: rows.length,
    errors: { unreadable_files: 0, bad_json_lines: 0, forks_without_parent: 0 },
    totals_by_tool_origin_model_day: totals,
    sessions,
  };
}

function makeFakeBin(dir, { remoteReport }) {
  const binDir = join(dir, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  const callsLog = join(dir, 'calls.log');
  writeFileSync(callsLog, '');

  const cli = join(binDir, 'fake-invoker-cli');
  writeFileSync(cli, `#!/usr/bin/env bash
if [ "$1" = "run" ]; then
  if [ "$2" != "--live" ]; then echo "refusing: submission must pass --live" >&2; exit 3; fi
  echo "$3" >> ${callsLog}
  echo "Delegated to live owner - workflow: wf-efficiency-1"
  exit 0
fi
echo null
`);
  chmodSync(cli, 0o755);

  const sshLog = join(dir, 'ssh.log');
  writeFileSync(sshLog, '');
  const remotePath = join(dir, 'remote-report.json');
  writeFileSync(remotePath, JSON.stringify(remoteReport, null, 2));
  const ssh = join(binDir, 'fake-ssh');
  writeFileSync(ssh, `#!/usr/bin/env bash
printf '%s\\n' "ssh $*" >> ${sshLog}
cat > /dev/null
for arg in "$@"; do
  case "$arg" in
    *@bad.example) echo "ssh: connect to host bad.example port 22: Connection refused" >&2; exit 255;;
  esac
done
cat ${remotePath}
`);
  chmodSync(ssh, 0o755);

  return { cli, ssh, callsLog, sshLog };
}

function runMiner(dir, { cli, ssh }, extraEnv = {}) {
  const plansDir = join(dir, 'plans');
  mkdirSync(plansDir, { recursive: true });
  const result = spawnSync('node', [MINER], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(dir, 'home'),
      TMPDIR: plansDir,
      TMP: plansDir,
      TEMP: plansDir,
      INVOKER_SESSION_MINE_DRY_RUN: '0',
      INVOKER_SESSION_MINE_STATE_DIR: join(dir, 'state'),
      INVOKER_SESSION_MINE_CLI: cli,
      INVOKER_SESSION_MINE_SSH: ssh,
      INVOKER_AGENTIC_CONTEXT_METRICS_PATH: join(dir, 'metrics.jsonl'),
      CATSTACK_ROOT: '',
      ...extraEnv,
    },
  });
  return {
    status: result.status,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function submittedPlans(callsLog) {
  const lines = readFileSync(callsLog, 'utf8').split('\n').filter(Boolean);
  return lines.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

const sharedFixtures = freshRoot('fixtures');
const THRASH_PATH = join(sharedFixtures, `${THRASH_SESSION_ID}.jsonl`);
writeFileSync(THRASH_PATH, thrashyRollout());
const THRASH_INVENTORY = join(sharedFixtures, 'inventory.json');
writeFileSync(THRASH_INVENTORY, JSON.stringify({
  sessions: [{
    workflowName: THRASH_WORKFLOW,
    sessionId: THRASH_SESSION_ID,
    agentName: 'codex',
    status: 'failed',
    path: THRASH_PATH,
  }],
}));
const EMPTY_INVENTORY = join(sharedFixtures, 'empty-inventory.json');
writeFileSync(EMPTY_INVENTORY, JSON.stringify({ sessions: [] }));

function seedEfficiencyRoot(name) {
  const dir = freshRoot(name);
  mkdirSync(join(dir, 'home'), { recursive: true });
  const rollups = join(dir, 'rollups');
  mkdirSync(rollups, { recursive: true });
  writeFileSync(
    join(rollups, 'mac.json'),
    JSON.stringify(makeReport('mac', isoDaysAgo(1), [{ id: FRESH_SESSION_ID, total: 23_300_000_000 }]), null, 2),
  );
  writeFileSync(
    join(rollups, 'droplet-a.json'),
    JSON.stringify(makeReport('droplet-a', isoDaysAgo(2), [{ id: 'droplet-a-session', total: 4_100_000_000 }]), null, 2),
  );
  writeFileSync(
    join(rollups, 'stale-host.json'),
    JSON.stringify(makeReport('stale-host', isoDaysAgo(40), [{ id: STALE_SESSION_ID, total: 9_900_000_000 }]), null, 2),
  );
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    remoteTargets: {
      remote_ok: { host: 'ok.example', user: 'invoker', sshKeyPath: join(dir, 'fake_key'), port: 22 },
      remote_bad: { host: 'bad.example', user: 'invoker', sshKeyPath: join(dir, 'fake_key'), port: 22 },
    },
  }, null, 2));
  writeFileSync(join(dir, 'fake_key'), '');
  const bin = makeFakeBin(dir, {
    remoteReport: makeReport('remote-ok', isoDaysAgo(1), [{ id: REMOTE_SESSION_ID, total: 3_300_000_000 }]),
  });
  const env = {
    INVOKER_SESSION_MINE_EFFICIENCY: '1',
    INVOKER_SESSION_ROLLUPS_DIR: rollups,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_SESSION_MINE_INVENTORY_JSON: EMPTY_INVENTORY,
  };
  return { dir, bin, env, rollups };
}

try {
  {
    const offDir = freshRoot('thrash-off');
    mkdirSync(join(offDir, 'home'), { recursive: true });
    const offBin = makeFakeBin(offDir, { remoteReport: {} });
    const off = runMiner(offDir, offBin, { INVOKER_SESSION_MINE_INVENTORY_JSON: THRASH_INVENTORY });
    check('thrash-off-exits-0', off.status === 0, `exit=${off.status}\n${off.out}`);
    check('thrash-off-files-one', /session-mine: filed 1/.test(off.out), `expected one thrash follow-up, got:\n${off.out}`);
    const offPlans = submittedPlans(offBin.callsLog);
    check('thrash-off-submits-one-plan', offPlans.length === 1, `expected 1 plan, got ${offPlans.length}`);

    const onSeed = seedEfficiencyRoot('thrash-on');
    const on = runMiner(onSeed.dir, onSeed.bin, {
      ...onSeed.env,
      INVOKER_SESSION_MINE_INVENTORY_JSON: THRASH_INVENTORY,
    });
    check('thrash-on-exits-0', on.status === 0, `exit=${on.status}\n${on.out}`);
    check('thrash-on-files-one', /session-mine: filed 1/.test(on.out), `expected the thrash path to still file one, got:\n${on.out}`);
    const onPlans = submittedPlans(onSeed.bin.callsLog);
    const onThrash = onPlans.filter((plan) => /^name: "worker-session-mine-[0-9a-f]{16}"$/m.test(plan.text));
    check('thrash-on-still-one-thrash-plan', onThrash.length === 1, `expected exactly 1 thrash plan, got ${onThrash.length}`);
    check(
      'thrash-plan-byte-identical',
      onThrash.length === 1 && offPlans.length === 1 && onThrash[0].text === offPlans[0].text,
      'expected the thrash follow-up plan to be unchanged by the efficiency pass',
    );
  }

  {
    const seed = seedEfficiencyRoot('efficiency');
    const first = runMiner(seed.dir, seed.bin, seed.env);
    check('efficiency-exits-0', first.status === 0, `exit=${first.status}\n${first.out}`);
    check('efficiency-no-thrash-filings', /session-mine: filed 0/.test(first.out), `expected no thrash filings, got:\n${first.out}`);

    const plans = submittedPlans(seed.bin.callsLog);
    check('efficiency-starts-exactly-one-plan', plans.length === 1, `expected exactly 1 plan, got ${plans.length}:\n${first.out}`);
    const plan = plans[0]?.text ?? '';

    check('efficiency-plan-is-scratch', /^scratch: true$/m.test(plan), `expected scratch: true, got:\n${plan.slice(0, 400)}`);
    check('efficiency-plan-finishes-none', /^onFinish: none$/m.test(plan), `expected onFinish: none, got:\n${plan.slice(0, 400)}`);
    check('efficiency-plan-has-findings-task', /findings\.json/.test(plan), 'expected the prompt task to write findings.json');
    check(
      'efficiency-plan-has-linear-command-step',
      /command: "node .*scripts\/session-efficiency-file-tickets\.mjs --findings .*findings\.json"/.test(plan),
      `expected a command task that files Linear tickets, got:\n${plan}`,
    );
    check('efficiency-plan-mentions-token-pattern-dedupe', /token-pattern:/.test(plan), 'expected the token-pattern dedupe marker in the plan');
    check('efficiency-plan-never-passes-ready-label', !/invoker-ready/i.test(plan), `the plan must never name the ready label, got:\n${plan}`);

    check('efficiency-plan-merges-local-and-pushed', plan.includes(FRESH_SESSION_ID), 'expected the fresh pushed Mac report to be merged into the plan');
    check('efficiency-plan-merges-ssh-host', plan.includes(REMOTE_SESSION_ID), 'expected the SSH-collected host report to be merged into the plan');
    check('efficiency-ssh-uses-batchmode', /BatchMode=yes/.test(readFileSync(seed.bin.sshLog, 'utf8')), 'expected ssh -o BatchMode=yes');
    check('efficiency-ssh-uses-connect-timeout', /ConnectTimeout=15/.test(readFileSync(seed.bin.sshLog, 'utf8')), 'expected ssh -o ConnectTimeout=15');

    check(
      'efficiency-failed-host-reported-unchecked',
      /Unchecked sources[\s\S]*remote:remote_bad/.test(plan),
      `expected the unreachable host to be reported as unchecked, got:\n${plan}`,
    );
    check(
      'efficiency-stale-report-reported-unchecked',
      /Unchecked sources[\s\S]*stale-host[\s\S]*too-old/.test(plan),
      `expected the too-old pushed report to be reported as unchecked, got:\n${plan}`,
    );
    check(
      'efficiency-stale-report-not-merged',
      !plan.includes(STALE_SESSION_ID),
      'a too-old pushed report must never contribute merged session data',
    );

    const second = runMiner(seed.dir, seed.bin, seed.env);
    check('second-tick-exits-0', second.status === 0, `exit=${second.status}\n${second.out}`);
    check('second-tick-is-cooled-down', /efficiency cooldown/.test(second.out), `expected a 7-day cooldown message, got:\n${second.out}`);
    check(
      'second-tick-starts-nothing',
      submittedPlans(seed.bin.callsLog).length === 1,
      'a second tick inside 7 days must start no new review',
    );
  }

  {
    const dir = freshRoot('tickets');
    const searchOut = join(dir, 'search.json');
    writeFileSync(searchOut, JSON.stringify({
      issues: [{
        id: 'issue-1',
        identifier: 'INV-1',
        title: 'Existing pattern',
        description: 'Motivation: token-pattern:already-filed\n',
        state: { type: 'started' },
      }],
    }));
    const createdLog = join(dir, 'created.jsonl');
    writeFileSync(createdLog, '');
    const findings = join(dir, 'findings.json');
    writeFileSync(findings, JSON.stringify({
      findings: [
        {
          slug: 'already-filed',
          title: 'Sessions grow to 967K before compacting',
          goal: 'Compact earlier',
          motivation: '967K peak context across every session',
          safetyInvariant: 'Analysis only',
          verify: 'node scripts/test-worker-session-mine-efficiency.mjs',
          repo: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
          suggestedFix: 'Compact at 600K',
          evidence: '23.3B tokens on the Mac in 30 days',
        },
        {
          slug: 'fork-copies-562k',
          title: 'Forks start at a median 562K copied context',
          goal: 'Start forks from a summary',
          motivation: '61 forks copied a median 562K context',
          safetyInvariant: 'Analysis only',
          verify: 'node scripts/test-worker-session-mine-efficiency.mjs',
          repo: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
          suggestedFix: 'Hand forks a digest instead of the transcript',
          evidence: '61 forks, median 562K copied context',
        },
      ],
    }));

    const result = spawnSync('node', [TICKETS, '--findings', findings], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        INVOKER_LINEAR_SEARCH_CMD: `cat ${searchOut}`,
        INVOKER_LINEAR_CREATE_CMD: `cat >> ${createdLog}; printf '\\n' >> ${createdLog}; echo '{"id":"new","identifier":"INV-2"}'`,
        INVOKER_LINEAR_LABEL_NAMES: '',
      },
    });
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    check('tickets-exit-0', result.status === 0, `exit=${result.status}\n${out}`);
    const created = readFileSync(createdLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    check('tickets-skips-existing-marker', created.length === 1, `expected 1 create (the other slug is already open), got ${created.length}\n${out}`);
    check('tickets-creates-new-marker', created[0]?.description?.includes('token-pattern:fork-copies-562k'), `expected the new ticket to carry its marker, got:\n${JSON.stringify(created[0])}`);
    check('tickets-never-label-ready', created.every((payload) => !JSON.stringify(payload).includes('invoker-ready')), 'a created ticket must never carry the ready label');
    check('tickets-send-no-labels', created.every((payload) => (payload.labelIds ?? []).length === 0), `expected no labelIds, got ${JSON.stringify(created[0]?.labelIds)}`);
  }

  {
    const dir = freshRoot('tickets-prefix');
    const searchOut = join(dir, 'search.json');
    writeFileSync(searchOut, JSON.stringify({
      issues: [{
        id: 'issue-2',
        identifier: 'INV-3',
        title: 'Forks start at a median 562K copied context',
        description: 'Motivation: token-pattern:fork-copies-562k\n',
        state: { type: 'started' },
      }],
    }));
    const createdLog = join(dir, 'created.jsonl');
    writeFileSync(createdLog, '');
    const findings = join(dir, 'findings.json');
    writeFileSync(findings, JSON.stringify({
      findings: [
        {
          slug: 'fork',
          title: 'Forks are spawned for work one session could finish',
          goal: 'Stop forking for trivial work',
          motivation: 'Most forks never diverge from their parent',
          safetyInvariant: 'Analysis only',
          verify: 'node scripts/test-worker-session-mine-efficiency.mjs',
          repo: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
          suggestedFix: 'Fork only past a context threshold',
          evidence: '61 forks, median 562K copied context',
        },
      ],
    }));

    const result = spawnSync('node', [TICKETS, '--findings', findings], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        INVOKER_LINEAR_SEARCH_CMD: `cat ${searchOut}`,
        INVOKER_LINEAR_CREATE_CMD: `cat >> ${createdLog}; printf '\\n' >> ${createdLog}; echo '{"id":"new","identifier":"INV-4"}'`,
        INVOKER_LINEAR_LABEL_NAMES: '',
      },
    });
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    check('tickets-prefix-exit-0', result.status === 0, `exit=${result.status}\n${out}`);
    const created = readFileSync(createdLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    check(
      'tickets-prefix-slug-still-filed',
      created.length === 1,
      `a slug that is a prefix of another open marker must still be filed, got ${created.length}\n${out}`,
    );
    check(
      'tickets-prefix-carries-own-marker',
      /token-pattern:fork(?![a-z0-9-])/.test(created[0]?.description ?? ''),
      `expected the new ticket to carry token-pattern:fork, got:\n${JSON.stringify(created[0])}`,
    );
  }

  {
    const dir = freshRoot('cooldown-after-failed-collect');
    mkdirSync(join(dir, 'home'), { recursive: true });
    const rollups = join(dir, 'rollups');
    const bin = makeFakeBin(dir, { remoteReport: makeReport('unused', isoDaysAgo(1), []) });
    const env = {
      INVOKER_SESSION_MINE_EFFICIENCY: '1',
      INVOKER_SESSION_ROLLUPS_DIR: rollups,
      INVOKER_REPO_CONFIG_PATH: join(dir, 'missing-config.json'),
      INVOKER_SESSION_MINE_INVENTORY_JSON: EMPTY_INVENTORY,
      INVOKER_SESSION_MINE_PYTHON: 'false',
    };
    const first = runMiner(dir, bin, env);
    check('failed-collect-exits-0', first.status === 0, `exit=${first.status}\n${first.out}`);
    check('failed-collect-names-the-failure', /retrying next tick/.test(first.out), `expected the failed sources to be reported, got:\n${first.out}`);
    const second = runMiner(dir, bin, env);
    check(
      'failed-collect-starts-no-cooldown',
      !/efficiency cooldown/.test(second.out) && /retrying next tick/.test(second.out),
      `a failed collect must not start the 7-day cooldown, got:\n${second.out}`,
    );
  }

  {
    const dir = freshRoot('tickets-paged');
    const portFile = join(dir, 'port');
    const server = join(dir, 'fake-linear.mjs');
    writeFileSync(server, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const pages = {
  first: { nodes: [{ id: 'p1', identifier: 'INV-10', title: 'Unrelated', description: 'nothing here', state: { type: 'started' } }], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } },
  second: { nodes: [{ id: 'p2', identifier: 'INV-11', title: 'Old pattern', description: 'Motivation: token-pattern:on-page-two', state: { type: 'started' } }], pageInfo: { hasNextPage: false, endCursor: 'cursor-2' } },
};
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const after = JSON.parse(body || '{}').variables?.after ?? null;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { issues: after === 'cursor-1' ? pages.second : pages.first } }));
  });
});
server.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)));
`);
    const child = spawn('node', [server], { stdio: 'ignore' });
    try {
      const waitUntil = Date.now() + 10_000;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(portFile) && Date.now() < waitUntil) Atomics.wait(pause, 0, 0, 50);
      const port = existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '';
      check('paged-fake-linear-started', port !== '', 'fake Linear server never reported a port');
      const createdLog = join(dir, 'created.jsonl');
      writeFileSync(createdLog, '');
      const findings = join(dir, 'findings.json');
      writeFileSync(findings, JSON.stringify({
        findings: [{
          slug: 'on-page-two',
          title: 'A pattern already open on the second page of issues',
          goal: 'Do not refile it',
          motivation: 'open ticket sits past the first page',
          safetyInvariant: 'Analysis only',
          verify: 'node scripts/test-worker-session-mine-efficiency.mjs',
          repo: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
          suggestedFix: 'none',
          evidence: 'fixture',
        }],
      }));
      const env = { ...process.env };
      delete env.INVOKER_LINEAR_SEARCH_CMD;
      const result = spawnSync('node', [TICKETS, '--findings', findings], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...env,
          INVOKER_LINEAR_API_URL: `http://127.0.0.1:${port}/graphql`,
          INVOKER_LINEAR_API_KEY: 'fixture-key',
          INVOKER_LINEAR_CREATE_CMD: `cat >> ${createdLog}; printf '\\n' >> ${createdLog}; echo '{"id":"new","identifier":"INV-12"}'`,
          INVOKER_LINEAR_LABEL_NAMES: '',
        },
      });
      const out = `${result.stdout || ''}${result.stderr || ''}`;
      check('paged-tickets-exit-0', result.status === 0, `exit=${result.status}\n${out}`);
      const created = readFileSync(createdLog, 'utf8').split('\n').filter(Boolean);
      check('paged-tickets-skip-marker-on-page-two', created.length === 0, `expected no create for a marker open on page two, got ${created.length}\n${out}`);
    } finally {
      child.kill();
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, checks: 34 }, null, 2));
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}
