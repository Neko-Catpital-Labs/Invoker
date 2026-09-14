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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { detectThrash, sessionHash } from './worker-session-mine-thrash.mjs';
import { resolveTranscriptPath, claudeProjectRoots, agentSessionsDir } from './worker-session-mine-resolve.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const STATE_DIR = process.env.INVOKER_SESSION_MINE_STATE_DIR
  ?? join(homedir(), '.invoker', 'worker-session-mine');
const LEDGER_PATH = join(STATE_DIR, 'cooldown.json');
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_TICK = Number(process.env.INVOKER_SESSION_MINE_MAX_PER_TICK ?? '1');
const MAX_PER_DAY = Number(process.env.INVOKER_SESSION_MINE_MAX_PER_DAY ?? '2');
const LOOKBACK_HOURS = Number(process.env.INVOKER_SESSION_MINE_LOOKBACK_HOURS ?? '168');
const WORKFLOW_PREFIXES = (process.env.INVOKER_SESSION_MINE_WORKFLOW_PREFIXES
  ?? 'admin-bypass-repair-')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const EXCLUDE_NAME_RE = /(session-mine|reflect-ci-|worker-session-mine)/i;
const POOL_ID = process.env.INVOKER_SESSION_MINE_POOL_ID ?? 'remote_digital_ocean_1';
const DRY_RUN = process.env.INVOKER_SESSION_MINE_DRY_RUN === '1';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stale']);

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

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function runHeadlessJson(args) {
  const result = spawnSync('bash', [join(REPO_ROOT, 'run.sh'), '--headless', ...args, '--output', 'json'], {
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
  })).filter((r) => r.sessionId);
}

function listFromHeadless() {
  const workflows = runHeadlessJson(['query', 'workflows']);
  if (!Array.isArray(workflows)) return null;
  const out = [];
  for (const wf of workflows) {
    const name = wf.name || wf.id || '';
    if (EXCLUDE_NAME_RE.test(name)) continue;
    if (!WORKFLOW_PREFIXES.some((p) => name.startsWith(p) || name.includes(p))) continue;
    const tasks = runHeadlessJson(['query', 'tasks', '--workflow', wf.id]);
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
        out.push({
          workflowName: '',
          sessionId: name.replace(/\.jsonl$/, ''),
          agentName: 'codex',
          status: 'failed',
          path,
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
poolId: ${POOL_ID}

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
      Reflect via catstack and open a PR to catstack or Invoker by root cause.
      Review claim: Accepted findings land as a non-merged PR in the correct repo for session ${hash}.
      Review lane: behavior
      Safety invariant: Never vendor skills/reflect/ into Invoker; never merge; original workflow untouched.
      Acceptance criteria:
      - Summary says no durable finding or lists PR URL(s).
      - test ! -e skills/reflect
    maxTurns: 30
    prompt: |
      Goal: Reflect on thrashy Invoker worker session ${sessionId} (agent=${agentName}) and open a non-merged PR to catstack or Invoker.
      Safety invariant: Never vendor skills/reflect/; never merge; do not touch the original repair workflow.
      Implementation details: |
        Clone https://github.com/EdbertChan/catstack.git. Follow engine/skills/reflect/SKILL.md against ${jsonlPath}.
        Skill/hook/methodology -> catstack PR. Invoker harness/prompt/product -> Invoker PR. Never merge.
      Pass condition: Exit 0 when acceptance criteria hold.
    dependencies:
      - repro-thrash
`;
}

function submitPlan(yamlText) {
  const dir = mkdtempSync(join(tmpdir(), 'session-mine-plan-'));
  const planPath = join(dir, 'plan.yaml');
  writeFileSync(planPath, yamlText);
  if (DRY_RUN) {
    console.log(`dry-run plan written: ${planPath}`);
    return { ok: true, dryRun: true, planPath };
  }
  const submit = join(REPO_ROOT, 'submit-plan.sh');
  const result = spawnSync('bash', [submit, planPath], {
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
  if (dayCount >= MAX_PER_DAY) {
    console.log(`session-mine: day cap reached (${dayCount}/${MAX_PER_DAY})`);
    return 0;
  }

  let candidates;
  if (process.env.INVOKER_SESSION_MINE_INVENTORY_JSON) {
    candidates = listFromInventoryFile(process.env.INVOKER_SESSION_MINE_INVENTORY_JSON);
  } else {
    candidates = listFromHeadless();
    if (!candidates) {
      console.log('session-mine: headless inventory unavailable; using disk fallback');
      candidates = listFromDiskFallback();
    }
  }

  let filed = 0;
  const now = Date.now();

  for (const cand of candidates) {
    if (filed >= MAX_PER_TICK) break;
    if ((ledger.dayCounts?.[today] ?? 0) >= MAX_PER_DAY) break;

    const path = cand.path || resolveTranscriptPath(cand.agentName, cand.sessionId);
    if (!path || !existsSync(path)) continue;

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

  console.log(`session-mine: filed ${filed}`);
  return 0;
}

process.exit(main());
