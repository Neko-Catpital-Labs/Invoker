#!/usr/bin/env node
/**
 * Scan terminal Invoker agent sessions (Claude/Codex/OMP) for thrash and
 * submit one follow-up Invoker workflow per session hash per week.
 * Never stops the original repair.
 *
 * Discovery: Invoker headless task inventory (agentSessionId + agentName),
 * then resolve transcript paths per harness. Optional inventory JSON for tests.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scoreSessionFile } from './agentic-context-score.mjs';
import { detectThrash, sessionHash } from './worker-session-mine-thrash.mjs';
import { resolveTranscriptPath, claudeProjectRoots, agentSessionsDir } from './worker-session-mine-resolve.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const STATE_DIR = process.env.INVOKER_SESSION_MINE_STATE_DIR
  ?? join(homedir(), '.invoker', 'worker-session-mine');
const LEDGER_PATH = join(STATE_DIR, 'cooldown.json');
const AGENTIC_CONTEXT_METRICS_PATH = process.env.INVOKER_AGENTIC_CONTEXT_METRICS_PATH
  ?? join(homedir(), '.invoker', 'agentic-context', 'metrics.jsonl');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'fixtures', 'agentic-context-score', 'baseline.json');
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_TICK = Number(process.env.INVOKER_SESSION_MINE_MAX_PER_TICK ?? '1');
const MAX_PER_DAY = Number(process.env.INVOKER_SESSION_MINE_MAX_PER_DAY ?? '2');
const LOOKBACK_HOURS = Number(process.env.INVOKER_SESSION_MINE_LOOKBACK_HOURS ?? '168');
const WORKFLOW_PREFIXES = (process.env.INVOKER_SESSION_MINE_WORKFLOW_PREFIXES
  ?? 'admin-bypass-repair-,CI regression')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const EXCLUDE_NAME_RE = /(session-mine|reflect-ci-|worker-session-mine)/i;
const POOL_ID = process.env.INVOKER_SESSION_MINE_POOL_ID?.trim() ?? '';
const DRY_RUN = process.env.INVOKER_SESSION_MINE_DRY_RUN === '1';
const OWNER_CLI = process.env.INVOKER_SESSION_MINE_CLI ?? 'invoker-cli';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stale']);
const EFFICIENCY_ENABLED = process.env.INVOKER_SESSION_MINE_EFFICIENCY === '1';
const EFFICIENCY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const EFFICIENCY_SINCE_DAYS = Number(process.env.INVOKER_SESSION_MINE_EFFICIENCY_SINCE_DAYS ?? '30');
const EFFICIENCY_MAX_AGE_DAYS = Number(process.env.INVOKER_SESSION_MINE_EFFICIENCY_MAX_AGE_DAYS ?? '8');
const EFFICIENCY_TOP = Number(process.env.INVOKER_SESSION_MINE_EFFICIENCY_TOP ?? '10');
const ROLLUPS_DIR = process.env.INVOKER_SESSION_ROLLUPS_DIR
  ?? join(homedir(), '.invoker', 'session-rollups');
const REPO_CONFIG_PATH = process.env.INVOKER_REPO_CONFIG_PATH
  ?? join(homedir(), '.invoker', 'config.json');
const ROLLUP_SCRIPT = join(REPO_ROOT, 'scripts', 'session-token-rollup.py');
const TICKET_SCRIPT = join(REPO_ROOT, 'scripts', 'session-efficiency-file-tickets.mjs');
const PYTHON_BIN = process.env.INVOKER_SESSION_MINE_PYTHON ?? 'python3';
const SSH_BIN = process.env.INVOKER_SESSION_MINE_SSH ?? 'ssh';
const SSH_TIMEOUT_MS = Number(process.env.INVOKER_SESSION_MINE_SSH_TIMEOUT_MS ?? '300000');
const ROLLUP_TIMEOUT_MS = Number(process.env.INVOKER_SESSION_MINE_ROLLUP_TIMEOUT_MS ?? '600000');

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return { version: 1, entries: {}, dayCounts: {} };
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  } catch {
    return { version: 1, entries: {}, dayCounts: {} };
  }
}

function saveLedger(ledger) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
}

function loadAgenticContextBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      path: BASELINE_PATH,
    };
  }
}

function emptyAgenticContextRollup({ candidateCount }) {
  return {
    type: 'agentic-context.discovery-tax.rollup',
    generatedAt: new Date().toISOString(),
    periodHours: LOOKBACK_HOURS,
    candidateCount,
    scoredSessions: 0,
    counts: {
      discoveryTax: 0,
      terminalFailure: 0,
      classSearchInPrompt: 0,
      byAgent: {},
      skippedNonJsonl: 0,
      scoreErrors: 0,
    },
    rates: {
      discoveryTaxRate: null,
      terminalFailureRate: null,
      classSearchInPromptRate: null,
    },
    baseline: loadAgenticContextBaseline(),
  };
}

function addAgenticContextScore(rollup, score) {
  rollup.scoredSessions += 1;
  if (score.discoveryTax) rollup.counts.discoveryTax += 1;
  if (score.terminalFailure) rollup.counts.terminalFailure += 1;
  if (score.classSearchInPrompt) rollup.counts.classSearchInPrompt += 1;
  const agent = score.agent || 'unknown';
  rollup.counts.byAgent[agent] = (rollup.counts.byAgent[agent] ?? 0) + 1;
}

function finalizeAgenticContextRollup(rollup) {
  const total = rollup.scoredSessions;
  if (total > 0) {
    rollup.rates.discoveryTaxRate = rollup.counts.discoveryTax / total;
    rollup.rates.terminalFailureRate = rollup.counts.terminalFailure / total;
    rollup.rates.classSearchInPromptRate = rollup.counts.classSearchInPrompt / total;
  }
  return rollup;
}

function appendAgenticContextRollup(rollup) {
  mkdirSync(dirname(AGENTIC_CONTEXT_METRICS_PATH), { recursive: true });
  appendFileSync(AGENTIC_CONTEXT_METRICS_PATH, `${JSON.stringify(finalizeAgenticContextRollup(rollup))}\n`);
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function runOwnerQueryJson(args) {
  const result = spawnSync(OWNER_CLI, [...args, '--output', 'json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout || 'null');
  } catch {
    return null;
  }
}

/** @returns {Array<{ workflowName: string, sessionId: string, agentName: string, status: string }>} */
function listFromInventoryFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Array.isArray(raw) ? raw : (raw.sessions || raw.tasks || []);
  return rows.map((r) => ({
    workflowName: r.workflowName || r.workflow || '',
    sessionId: r.sessionId || r.agentSessionId || '',
    agentName: r.agentName || r.executionAgent || 'claude',
    status: r.status || 'failed',
    path: r.path || '',
  })).filter((r) => r.sessionId);
}

function listFromOwner() {
  const workflows = runOwnerQueryJson(['query', 'workflows']);
  if (!Array.isArray(workflows)) return null;
  const out = [];
  for (const wf of workflows) {
    const name = wf.name || wf.id || '';
    if (EXCLUDE_NAME_RE.test(name)) continue;
    if (!WORKFLOW_PREFIXES.some((p) => name.startsWith(p) || name.includes(p))) continue;
    const tasks = runOwnerQueryJson(['query', 'tasks', '--workflow', wf.id]);
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      const status = task.status || '';
      if (!TERMINAL.has(status)) continue;
      const execution = task.execution || {};
      const sessionId = execution.agentSessionId || execution.lastAgentSessionId || '';
      if (!sessionId) continue;
      const agentName = execution.agentName || execution.lastAgentName || task.config?.executionAgent || 'claude';
      out.push({ workflowName: name, sessionId, agentName, status });
    }
  }
  return out;
}

/** Disk fallback when headless is unavailable (dev / fixtures). */
function listFromDiskFallback() {
  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const out = [];
  for (const root of claudeProjectRoots()) {
    if (!existsSync(root)) continue;
    for (const project of readdirSync(root)) {
      const projectDir = join(root, project);
      try {
        if (!statSync(projectDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const name of readdirSync(projectDir)) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(projectDir, name);
        try {
          const mtime = statSync(path).mtimeMs;
          if (mtime < cutoff) continue;
          out.push({
            workflowName: '',
            sessionId: name.replace(/\.jsonl$/, ''),
            agentName: 'claude',
            status: 'failed',
            path,
            mtime,
          });
        } catch {
          // skip
        }
      }
    }
  }
  const sessions = agentSessionsDir();
  if (existsSync(sessions)) {
    for (const name of readdirSync(sessions)) {
      const path = join(sessions, name);
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime < cutoff) continue;
      } catch {
        continue;
      }
      if (name.endsWith('.jsonl')) {
        const sessionId = name.replace(/\.jsonl$/, '');
        out.push({
          workflowName: '',
          sessionId,
          agentName: 'codex',
          status: 'failed',
          path: resolveTranscriptPath('codex', sessionId) ?? path,
        });
      } else if (name.endsWith('.omp.txt')) {
        out.push({
          workflowName: '',
          sessionId: name.replace(/\.omp\.txt$/, ''),
          agentName: 'omp',
          status: 'failed',
          path,
        });
      }
    }
  }
  return out;
}

function matchesAllowlist(workflowName, report) {
  const hint = workflowName || report.workflowHint || '';
  if (EXCLUDE_NAME_RE.test(hint)) return false;
  if (!hint) {
    return process.env.INVOKER_SESSION_MINE_ALLOW_UNHINTTED === '1';
  }
  return WORKFLOW_PREFIXES.some((prefix) => hint.startsWith(prefix) || hint.includes(prefix));
}

function buildFollowUpPlan({ sessionId, jsonlPath, report, hash, agentName }) {
  const name = `worker-session-mine-${hash}`;
  const reasons = report.reasons.join('; ');
  return `name: "${name}"
description: |
  Follow-up reflect/fix for thrashy worker session ${sessionId} (${agentName}).
  Original repair is untouched. Never merge. Never vendor skills/reflect/.
onFinish: pull_request
mergeMode: external_review
baseBranch: master
repoUrl: git@github.com:Neko-Catpital-Labs/Invoker.git
${POOL_ID ? `poolId: ${POOL_ID}\n` : ''}
tasks:
  - id: repro-thrash
    description: |
      Prove the thrash detector fires on a fixture copy and stays silent on a clean fixture.
      Review claim: Detector positive/negative fixtures encode the thrash reasons for session ${hash}.
      Review lane: proof
      Safety invariant: Proof-only; does not modify the original session or merge anything.
    command: "node scripts/worker-session-mine-thrash.mjs --self-test"
    dependencies: []

  - id: reflect-and-fix
    description: |
      Reflect via catstack and route each Accepted finding by root cause: catstack gets its own PR; Invoker changes are committed here for the merge gate to publish.
      Review claim: Accepted findings land exactly once, as a catstack PR or an Invoker commit published by this workflow's merge gate, for session ${hash}.
      Review lane: behavior
      Safety invariant: Never vendor skills/reflect/ into Invoker; never merge; original workflow untouched.
      Acceptance criteria:
      - Summary says no durable finding, lists catstack PR URL(s), or names the Invoker commit(s) left for the merge gate.
      - test ! -e skills/reflect
    maxTurns: 30
    prompt: |
      Goal: Reflect on thrashy Invoker worker session ${sessionId} (agent=${agentName}) and land each Accepted finding exactly once, unmerged.
      Safety invariant: Never vendor skills/reflect/; never merge; do not touch the original repair workflow.
      Implementation details: |
        Clone https://github.com/EdbertChan/catstack.git. Follow engine/skills/reflect/SKILL.md against ${jsonlPath}.
        Skill/hook/methodology -> catstack PR. Invoker harness/prompt/product -> commit in this task's worktree only.
        For Invoker changes, do not push and do not open a PR: this workflow's merge gate owns Invoker publication (onFinish: pull_request). Never merge.
      Pass condition: Exit 0 when acceptance criteria hold.
    dependencies:
      - repro-thrash
`;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function oneLine(text, max = 240) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => `${pad}${line}`).join('\n');
}

function sinceDate(now, days) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function readRemoteTargets() {
  try {
    const config = JSON.parse(readFileSync(expandHome(REPO_CONFIG_PATH), 'utf8'));
    const targets = config.remoteTargets;
    if (!targets || typeof targets !== 'object') return { targets: {}, error: null };
    return { targets, error: null };
  } catch (err) {
    return { targets: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

function collectLocalRollup(since, outPath) {
  const result = spawnSync(PYTHON_BIN, [
    ROLLUP_SCRIPT, 'collect',
    '--since', since,
    '--host', hostname(),
    '--out', outPath,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: ROLLUP_TIMEOUT_MS,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: oneLine(result.stderr || result.stdout) || `exit ${result.status}` };
  }
  return { ok: true };
}

function collectRemoteRollup(target, since, outPath) {
  const host = String(target?.host ?? '').trim();
  const user = String(target?.user ?? '').trim();
  const keyPath = expandHome(String(target?.sshKeyPath ?? '').trim());
  const port = String(target?.port ?? 22);
  if (!host || !user || !keyPath) {
    return { ok: false, error: 'incomplete remote target (needs host, user and sshKeyPath)' };
  }
  const result = spawnSync(SSH_BIN, [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-i', keyPath,
    '-p', port,
    `${user}@${host}`,
    'python3', '-', 'collect', '--since', since,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    input: readFileSync(ROLLUP_SCRIPT, 'utf8'),
    maxBuffer: 64 * 1024 * 1024,
    timeout: SSH_TIMEOUT_MS,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: oneLine(result.stderr || result.stdout) || `ssh exit ${result.status}` };
  }
  try {
    JSON.parse(result.stdout || '');
  } catch (err) {
    return { ok: false, error: `unparseable report: ${err instanceof Error ? err.message : String(err)}` };
  }
  writeFileSync(outPath, result.stdout);
  return { ok: true };
}

function listRollupReports() {
  if (!existsSync(ROLLUPS_DIR)) return [];
  return readdirSync(ROLLUPS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(ROLLUPS_DIR, name));
}

function mergeRollupReports(paths, now) {
  const result = spawnSync(PYTHON_BIN, [
    ROLLUP_SCRIPT, 'merge',
    ...paths,
    '--top', String(EFFICIENCY_TOP),
    '--max-age-days', String(EFFICIENCY_MAX_AGE_DAYS),
    '--now', new Date(now).toISOString(),
    '--json',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: ROLLUP_TIMEOUT_MS,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: oneLine(result.stderr || result.stdout) || `exit ${result.status}` };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout || 'null') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function buildEfficiencyPlan({ dateKey, findingsPath, merged, unchecked }) {
  const name = `worker-session-mine-efficiency-${dateKey}`;
  const uncheckedText = unchecked.length > 0
    ? unchecked.map((item) => `- ${item.source}: ${item.error}`).join('\n')
    : '- none';
  const hostCount = Object.keys(merged.machines ?? {}).length;
  const sessionCount = (merged.top_sessions ?? []).length;
  return `name: "${name}"
description: |
  Weekly cross-machine token-efficiency review for ${dateKey}.
  Read-only analysis plus unlabeled Linear tickets. No repo, no branch, no merge.
scratch: true
onFinish: none
tasks:
  - id: name-token-patterns
    description: |
      Name the biggest cross-session token patterns in the merged rollup and write findings.json.
      Review claim: Every finding names a cross-session pattern, the numbers that show it, and one suggested fix.
      Review lane: policy
      Safety invariant: Analysis only - this task creates no tickets, adds no labels, and touches no repository.
      Acceptance criteria:
      - test -s ${findingsPath}
    maxTurns: 25
    prompt: |
      Goal: Name the token-efficiency patterns worth fixing across ${hostCount} machine(s) and ${sessionCount} top session(s), then write them to ${findingsPath}.
      Safety invariant: Analysis only. Do not create tickets, do not add labels, do not clone or edit any repository.
      Implementation details: |
        Rank patterns that span sessions (context growth before compaction, fork copy cost,
        repeated tool loops, worker versus interactive split), not single-session incidents.
        Write ${findingsPath} as JSON: {"findings": [{"slug", "title", "goal", "motivation",
        "safetyInvariant", "verify", "repo", "suggestedFix", "evidence"}]}.
        slug is lowercase-kebab and stable across weeks so token-pattern:<slug> can dedupe the ticket.
        motivation and evidence must quote the real numbers from the merged rollup below.
        Emit at most 5 findings, biggest token saving first.
      Unchecked sources (a machine or report that could not be read; never treat one as zero spend):
${indentBlock(uncheckedText, 8)}
      Merged rollup JSON:
${indentBlock(JSON.stringify(merged, null, 2), 8)}
      Pass condition: ${findingsPath} exists and parses as JSON with a non-empty findings array.
    dependencies: []

  - id: file-linear-tickets
    description: |
      File one Linear ticket per finding, skipping any pattern whose token-pattern:<slug> marker is already open.
      Review claim: Each new finding becomes exactly one unlabeled Linear issue carrying its token-pattern marker.
      Review lane: policy
      Safety invariant: The filer sends an empty label list, so a filed ticket can never carry a ready-to-run label.
      Acceptance criteria:
      - The command exits 0.
    command: "node ${TICKET_SCRIPT} --findings ${findingsPath}"
    dependencies:
      - name-token-patterns
`;
}

function recordEfficiencyPass(ledger, now, detail) {
  ledger.efficiency = { at: now, ...detail };
  saveLedger(ledger);
}

function runEfficiencyPass(ledger, now) {
  const last = Number(ledger.efficiency?.at ?? 0);
  if (last > 0 && now - last < EFFICIENCY_INTERVAL_MS) {
    console.log(`session-mine: efficiency cooldown (last pass ${new Date(last).toISOString()})`);
    return false;
  }

  mkdirSync(ROLLUPS_DIR, { recursive: true });
  const since = sinceDate(now, EFFICIENCY_SINCE_DAYS);
  const unchecked = [];

  const local = collectLocalRollup(since, join(ROLLUPS_DIR, `${hostname()}.json`));
  if (!local.ok) unchecked.push({ source: `local:${hostname()}`, error: local.error });

  const config = readRemoteTargets();
  if (config.error) unchecked.push({ source: `config:${REPO_CONFIG_PATH}`, error: oneLine(config.error) });
  for (const [id, target] of Object.entries(config.targets).sort(([a], [b]) => a.localeCompare(b))) {
    const remote = collectRemoteRollup(target, since, join(ROLLUPS_DIR, `${id}.json`));
    if (!remote.ok) unchecked.push({ source: `remote:${id}`, error: remote.error });
  }

  const reports = listRollupReports();
  if (reports.length === 0) {
    if (unchecked.length > 0) {
      console.error(`session-mine: efficiency pass found no machine reports and ${unchecked.length} source(s) failed; retrying next tick: ${JSON.stringify(unchecked)}`);
      return false;
    }
    console.log('session-mine: efficiency pass found no machine reports; nothing to review');
    recordEfficiencyPass(ledger, now, { submitted: false, reports: 0, unchecked: 0 });
    return false;
  }

  const merged = mergeRollupReports(reports, now);
  if (!merged.ok) {
    console.error(`session-mine: efficiency merge failed: ${merged.error}`);
    return false;
  }
  for (const entry of merged.value?.skipped ?? []) {
    unchecked.push({
      source: `report:${entry.host || entry.path}`,
      error: `${entry.reason} (generatedAt=${entry.generatedAt ?? 'none'}, limit ${merged.value.maxAgeDays} days)`,
    });
  }
  for (const entry of merged.value?.unreadable ?? []) {
    unchecked.push({ source: `report:${entry.path}`, error: entry.error });
  }

  const passDay = dayKey(new Date(now));
  const runDir = join(STATE_DIR, 'efficiency', passDay);
  mkdirSync(runDir, { recursive: true });
  const yamlText = buildEfficiencyPlan({
    dateKey: passDay,
    findingsPath: join(runDir, 'findings.json'),
    merged: merged.value,
    unchecked,
  });
  const submitted = submitPlan(yamlText);
  if (!submitted.ok) {
    console.error('session-mine: efficiency plan submit failed');
    return false;
  }
  recordEfficiencyPass(ledger, now, {
    submitted: true,
    reports: reports.length,
    unchecked: unchecked.length,
  });
  console.log(`session-mine: efficiency review filed for ${passDay} (reports=${reports.length}, unchecked=${unchecked.length})`);
  return true;
}

function submitPlan(yamlText) {
  const dir = mkdtempSync(join(tmpdir(), 'session-mine-plan-'));
  const planPath = join(dir, 'plan.yaml');
  writeFileSync(planPath, yamlText);
  if (DRY_RUN) {
    console.log(`dry-run plan written: ${planPath}`);
    return { ok: true, dryRun: true, planPath };
  }
  const result = spawnSync(OWNER_CLI, ['run', '--live', planPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  console.log(result.stdout || '');
  if (result.stderr) console.error(result.stderr);
  return { ok: result.status === 0, status: result.status, planPath };
}

function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const ledger = loadLedger();
  const today = dayKey();
  const dayCount = ledger.dayCounts?.[today] ?? 0;

  let candidates;
  if (process.env.INVOKER_SESSION_MINE_INVENTORY_JSON) {
    candidates = listFromInventoryFile(process.env.INVOKER_SESSION_MINE_INVENTORY_JSON);
  } else {
    candidates = listFromOwner();
    if (!candidates || candidates.length === 0) {
      console.log('session-mine: owner inventory empty or unavailable; using disk fallback');
      candidates = listFromDiskFallback();
    }
  }

  const rollup = emptyAgenticContextRollup({ candidateCount: candidates.length });
  const scoredPaths = new Set();
  let filed = 0;
  const now = Date.now();
  if (dayCount >= MAX_PER_DAY) {
    console.log(`session-mine: day cap reached (${dayCount}/${MAX_PER_DAY})`);
  }

  for (const cand of candidates) {
    const path = cand.path || resolveTranscriptPath(cand.agentName, cand.sessionId);
    if (!path || !existsSync(path)) continue;

    if (!scoredPaths.has(path)) {
      scoredPaths.add(path);
      if (path.endsWith('.jsonl')) {
        try {
          addAgenticContextScore(rollup, scoreSessionFile(path));
        } catch (err) {
          rollup.counts.scoreErrors += 1;
          console.error(`session-mine: agentic-context score failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        rollup.counts.skippedNonJsonl += 1;
      }
    }

    if (filed >= MAX_PER_TICK) continue;
    if ((ledger.dayCounts?.[today] ?? 0) >= MAX_PER_DAY) continue;

    const report = detectThrash(path);
    if (!report.thrash) continue;
    if (!matchesAllowlist(cand.workflowName, report)) continue;

    const hash = sessionHash(cand.sessionId, cand.workflowName || report.workflowHint || '');
    const prev = ledger.entries[hash];
    if (prev && now - Number(prev.at || 0) < COOLDOWN_MS) {
      console.log(`session-mine: cooldown ${hash}`);
      continue;
    }

    console.log(`session-mine: filing follow-up for ${cand.sessionId} agent=${cand.agentName} hash=${hash} reasons=${report.reasons.join(',')}`);
    const yamlText = buildFollowUpPlan({
      sessionId: cand.sessionId,
      jsonlPath: path,
      report,
      hash,
      agentName: cand.agentName,
    });
    const submitted = submitPlan(yamlText);
    if (!submitted.ok) {
      console.error(`session-mine: submit failed for ${hash}`);
      continue;
    }
    ledger.entries[hash] = {
      at: now,
      sessionId: cand.sessionId,
      agentName: cand.agentName,
      path,
      reasons: report.reasons,
    };
    ledger.dayCounts = ledger.dayCounts || {};
    ledger.dayCounts[today] = (ledger.dayCounts[today] ?? 0) + 1;
    filed += 1;
    saveLedger(ledger);
  }

  appendAgenticContextRollup(rollup);
  console.log(`session-mine: filed ${filed}`);
  if (EFFICIENCY_ENABLED) runEfficiencyPass(ledger, now);
  return 0;
}

process.exit(main());
