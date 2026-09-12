#!/usr/bin/env node
/**
 * Linear → Invoker intake worker.
 *
 * Polls issues labeled invoker-ready, fills Goal/Motivation from the ticket
 * when possible, surfaces remaining gaps as a Linear comment + invoker-needs-input,
 * and only auto-submits when the shared planning completeness gate passes.
 *
 * Seams (for tests / DO1 / sandbox):
 *   INVOKER_LINEAR_API_KEY          Linear API key (required unless FIXTURE_ISSUES)
 *   INVOKER_LINEAR_FIXTURE_ISSUES   JSON file of issues (skips network)
 *   INVOKER_LINEAR_ISSUE_IDS        Comma-separated identifiers (e.g. INV-274,INV-277); ignores invoker-ready
 *   INVOKER_LINEAR_SANDBOX=1        Skip Linear comment/label writes; enrich Repo/Files/Verify defaults
 *   INVOKER_LINEAR_DEFAULT_REPO_URL Default repo when ticket omits Repo (sandbox / enrichment)
 *   INVOKER_LINEAR_DRY_RUN=1        Log actions; do not comment/label/submit
 *   INVOKER_LINEAR_SUBMIT_CMD       Submit binary (default: ./submit-plan.sh)
 *   INVOKER_LINEAR_PLANNER_CMD      Optional: ticket JSON on stdin → plan path on stdout
 *   INVOKER_LINEAR_WORK_DIR         Scratch + ledger directory
 *   INVOKER_LINEAR_RESUBMIT_GUARD_MIN  Minutes before resubmitting same issue (default 1200)
 *   INVOKER_LINEAR_COMMENT_CMD      Optional stub: receives JSON {issueId,body,labelsAdd,labelsRemove}
 *   INVOKER_LINEAR_BASE_BRANCH      Default master
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  utimesSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const LABEL_READY = 'invoker-ready';
const LABEL_RUNNING = 'invoker-running';
const LABEL_NEEDS_INPUT = 'invoker-needs-input';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[linear-intake ${ts}] ${msg}`);
}

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'ticket';
}

const PATH_IN_PROSE_RE =
  /\b((?:packages|scripts|skills|docs|plans|packages\/[\w.-]+\/src)\/[\w./@+-]+\.[a-zA-Z0-9]+|CLAUDE\.md|AGENTS\.md|README\.md)\b/;

function inferFixFile(title, description) {
  const body = `${title}\n${description ?? ''}`;
  const match = body.match(PATH_IN_PROSE_RE);
  if (match?.[1]) return match[1];
  // Keyword fallbacks for tickets that name a subsystem but not a path.
  if (/babysit|admin-bypass|human-only blocker/i.test(body)) {
    return 'packages/execution-engine/src/workers/pr-maintenance-workers.ts';
  }
  if (/slack-manager|deploy-do1/i.test(body) && /getpgid|KillMode|cgroup/i.test(body)) {
    return 'scripts/deploy-do1.sh';
  }
  return '';
}

function inferVerify(fixFile, title, description) {
  const body = `${title}\n${description ?? ''}`;

  if (fixFile && (/\.(md|txt|rst)$/i.test(fixFile) || fixFile === 'CLAUDE.md' || fixFile === 'AGENTS.md')) {
    if (/sql\.js|node:sqlite/i.test(body)) {
      // Avoid YAML double-quote escapes (no backslashes). Use -F for literal sql.js.
      return `rg -q node:sqlite ${fixFile} && ! rg -Fq sql.js ${fixFile}`;
    }
    return `test -f ${fixFile}`;
  }

  if (!fixFile) return '';
  if (/\.(sh|bash)$/i.test(fixFile)) {
    return `bash -n ${fixFile}`;
  }
  if (/babysit/i.test(fixFile) || /babysit|human-only blocker/i.test(body)) {
    return `test -f ${fixFile} && rg -n human-only ${fixFile}`;
  }
  return `test -f ${fixFile}`;
}

function enrichTicketFields(fields, { sandbox, defaultRepoUrl }) {
  const out = { ...fields };
  if (!out.repoUrl && (sandbox || defaultRepoUrl)) {
    out.repoUrl = defaultRepoUrl || 'https://github.com/Neko-Catpital-Labs/Invoker.git';
  }
  if (!out.fixFile) {
    out.fixFile = inferFixFile(fields.bugSummary, fields.narrative);
  }
  if (!out.verify) {
    out.verify = inferVerify(out.fixFile, fields.bugSummary, fields.narrative);
  }
  return out;
}

function parseTicketFields(title, description) {
  const body = `${title}\n\n${description ?? ''}`;
  const field = (name) => {
    const re = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'im');
    return body.match(re)?.[1]?.trim() ?? '';
  };
  const repoUrl = field('Repo') || field('repoUrl');
  const verify = field('Verify') || field('verify_command');
  const files = field('Files') || field('fix_file');
  const goal = field('Goal');
  const motivation = field('Motivation');
  const safety = field('Safety invariant') || field('SafetyInvariant');
  const narrative = String(description ?? '')
    .split('\n')
    .filter((line) => !/^\s*(Repo|repoUrl|Verify|verify_command|Files|fix_file|Goal|Motivation|Safety invariant|SafetyInvariant)\s*:/i.test(line))
    .join('\n')
    .trim();
  return {
    repoUrl,
    verify,
    fixFile: files.split(',')[0]?.trim() || '',
    goal: goal || (title ? `Fix: ${title.trim()}` : ''),
    motivation: motivation || (title ? `${title.trim()} is a reported defect that should be fixed at the source.` : ''),
    safety,
    bugSummary: title.trim() || 'Linear ticket defect',
    narrative,
  };
}

function listGaps(fields) {
  const gaps = [];
  if (!fields.repoUrl) gaps.push({ field: 'Repo', message: 'Add a line: Repo: https://github.com/org/repo' });
  if (!fields.verify) gaps.push({ field: 'Verify', message: 'Add a line: Verify: <runnable command that fails before the fix>' });
  if (!fields.fixFile) gaps.push({ field: 'Files', message: 'Add a line: Files: path/to/file.ts' });
  if (!fields.motivation) gaps.push({ field: 'Motivation', message: 'Add Motivation: or a descriptive title so motivation can be inferred.' });
  if (!fields.goal) gaps.push({ field: 'Goal', message: 'Add Goal: or a descriptive title so a goal can be inferred.' });
  return gaps;
}

function formatGapComment(issueIdentifier, gaps) {
  const lines = [
    `Invoker intake paused on ${issueIdentifier}: plan is incomplete.`,
    '',
    'Missing / ambiguous:',
    ...gaps.map((g) => `- **${g.field}**: ${g.message}`),
    '',
    'Edit the ticket (or reply) with the missing fields, keep the `invoker-ready` label, and the next poll will retry.',
    'Fill Goal / Motivation from the title when you can; Verify must be a real command, not “manually check”.',
  ];
  return lines.join('\n');
}

async function linearGraphql(apiKey, query, variables = {}) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const ISSUE_NODE_FIELDS = `
  id
  identifier
  title
  description
  url
  labels { nodes { id name } }
`;

async function fetchIssuesByIdentifiers(apiKey, identifiers) {
  const wanted = new Set(identifiers.map((id) => id.trim().toUpperCase()).filter(Boolean));
  if (wanted.size === 0) return [];

  // Linear has no bulk "identifier in" filter; pull a recent page and match, then fall back per-id.
  const data = await linearGraphql(
    apiKey,
    `query {
      issues(first: 100, orderBy: updatedAt) {
        nodes { ${ISSUE_NODE_FIELDS} }
      }
    }`,
  );
  const found = [];
  const byId = new Map();
  for (const node of data?.issues?.nodes ?? []) {
    byId.set(String(node.identifier).toUpperCase(), node);
  }
  for (const id of wanted) {
    if (byId.has(id)) {
      found.push(byId.get(id));
      continue;
    }
    const number = Number(id.split('-').pop());
    if (!Number.isFinite(number)) {
      throw new Error(`Cannot resolve Linear issue ${id}`);
    }
    const one = await linearGraphql(
      apiKey,
      `query($filter: IssueFilter) {
        issues(filter: $filter, first: 5) {
          nodes { ${ISSUE_NODE_FIELDS} }
        }
      }`,
      { filter: { number: { eq: number } } },
    );
    const match = (one?.issues?.nodes ?? []).find((n) => String(n.identifier).toUpperCase() === id);
    if (!match) throw new Error(`Linear issue not found: ${id}`);
    found.push(match);
  }
  return found;
}

async function fetchLinearIssues({ apiKey, fixturePath, issueIds }) {
  if (fixturePath) {
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
    return Array.isArray(raw) ? raw : raw.issues ?? [];
  }
  if (!apiKey) throw new Error('LINEAR_API_KEY / INVOKER_LINEAR_API_KEY required (or set INVOKER_LINEAR_FIXTURE_ISSUES)');

  if (issueIds?.length) {
    return fetchIssuesByIdentifiers(apiKey, issueIds);
  }

  const data = await linearGraphql(
    apiKey,
    `query($filter: IssueFilter) {
      issues(filter: $filter, first: 50) {
        nodes { ${ISSUE_NODE_FIELDS} }
      }
    }`,
    { filter: { labels: { name: { eq: LABEL_READY } } } },
  );
  return data?.issues?.nodes ?? [];
}

function runCmd(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO_ROOT,
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return result;
}

function oneLine(text, max = 400) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function specializeBugfixPlan(planText, fields) {
  // Ticket narrative often has Repo:/Verify: lines — never inject raw newlines into YAML scalars.
  const impact = oneLine(fields.motivation);
  const details = oneLine(
    fields.narrative
      ? fields.narrative
      : `Correct the defect described as "${fields.bugSummary}" in ${fields.fixFile}.`,
  );
  const claim = oneLine(
    `The change corrects ${fields.bugSummary} at its source with no unrelated edits.`,
  );
  const reproNote = oneLine(`Use \`${fields.verify}\` as the shared repro.`);
  let out = planText;
  out = out.replace(
    /REPLACE_ME:\s*describe the root cause[\s\S]*?specializes each REPLACE_ME line\./g,
    `Root cause / approach: ${details}`,
  );
  out = out.replace(/REPLACE_ME with the precise defect claim\./g, claim);
  out = out.replace(/REPLACE_ME with user impact\./g, impact);
  out = out.replace(/REPLACE_ME with the concrete change\./g, details);
  out = out.replace(/REPLACE_ME if the repro differs\./g, reproNote);
  out = out.replace(/REPLACE_ME\./g, details);
  out = out.replace(/\bREPLACE_ME\b/g, details);
  return out;
}


function maybeSandboxPlan(planText, sandbox) {
  if (!sandbox) return planText;
  return planText
    .replace(/^onFinish:\s*\S+/m, 'onFinish: none')
    .replace(/^mergeMode:\s*\S+/m, 'mergeMode: no_op');
}

function renderBugfixPlan(fields, workDir, sandbox = false) {
  const outDir = join(workDir, 'rendered');
  mkdirSync(outDir, { recursive: true });
  const slug = slugify(fields.bugSummary);
  const result = runCmd('bash', [
    join(REPO_ROOT, 'skills/plan-to-invoker/scripts/render-formula.sh'),
    'bugfix',
    '--var', `repo_url=${fields.repoUrl}`,
    '--var', `base_branch=${env('INVOKER_LINEAR_BASE_BRANCH', 'master')}`,
    '--var', `bug_slug=${slug}`,
    '--var', `bug_summary=${fields.bugSummary}`,
    '--var', `fix_file=${fields.fixFile}`,
    '--var', `verify_command=${fields.verify}`,
    '--out', outDir,
    '--print',
  ]);
  if (result.status !== 0) {
    throw new Error(`render-formula failed: ${result.stderr || result.stdout}`);
  }
  const printed = (result.stdout || '').trim().split('\n').filter(Boolean);
  const planPath = printed[printed.length - 1] || join(outDir, 'bugfix.workflow.yaml');
  if (!existsSync(planPath)) {
    // render-formula may write bugfix.workflow.yaml under outDir
    const fallback = join(outDir, 'bugfix.workflow.yaml');
    if (!existsSync(fallback)) throw new Error(`Rendered plan not found. stdout=${result.stdout}`);
    const specialized = maybeSandboxPlan(specializeBugfixPlan(readFileSync(fallback, 'utf8'), fields), sandbox);
    const dest = join(workDir, `linear-${slug}.yaml`);
    writeFileSync(dest, specialized);
    return dest;
  }
  const specialized = maybeSandboxPlan(specializeBugfixPlan(readFileSync(planPath, 'utf8'), fields), sandbox);
  const dest = join(workDir, `linear-${slug}.yaml`);
  writeFileSync(dest, specialized);
  return dest;
}

function runPlannerCmd(plannerCmd, issue, fields, workDir) {
  const payload = JSON.stringify({ issue, fields }, null, 2);
  const result = runCmd('bash', ['-lc', plannerCmd], { input: payload, cwd: workDir });
  if (result.status !== 0) {
    throw new Error(`planner cmd failed: ${result.stderr || result.stdout}`);
  }
  const planPath = (result.stdout || '').trim().split('\n').filter(Boolean).at(-1);
  if (!planPath || !existsSync(planPath)) {
    throw new Error(`planner cmd did not print an existing plan path: ${result.stdout}`);
  }
  return planPath;
}

function runCompleteness(planPath) {
  const result = runCmd('bash', [
    join(REPO_ROOT, 'skills/plan-to-invoker/scripts/check-planning-completeness.sh'),
    planPath,
  ]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    parsed = { complete: result.status === 0, gaps: [], raw: result.stdout };
  }
  return { ok: result.status === 0, parsed, stderr: result.stderr || '' };
}

function postLinearAction({ apiKey, issueId, body, labelsAdd, labelsRemove, dryRun, sandbox, commentCmd }) {
  const payload = { issueId, body, labelsAdd: labelsAdd ?? [], labelsRemove: labelsRemove ?? [] };
  if (sandbox) {
    log(`sandbox skip Linear mutate: ${JSON.stringify(payload).slice(0, 500)}`);
    return;
  }
  if (dryRun) {
    log(`dry-run comment/labels: ${JSON.stringify(payload).slice(0, 500)}`);
    return;
  }
  if (commentCmd) {
    const result = runCmd('bash', ['-lc', commentCmd], { input: JSON.stringify(payload) });
    if (result.status !== 0) throw new Error(`comment cmd failed: ${result.stderr || result.stdout}`);
    return;
  }
  if (!apiKey) throw new Error('Cannot comment on Linear without API key or INVOKER_LINEAR_COMMENT_CMD');

  // Resolve label ids by name when needed.
  const labelQuery = `
    query { issueLabels(first: 100) { nodes { id name } } }
  `;
  // Best-effort: comment + mutate labels by name via issueUpdate when ids known.
  // For v1 we always create a comment; label add/remove uses names through a second query.
  return (async () => {
    const labelsRes = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: labelQuery }),
    });
    const labelsJson = await labelsRes.json();
    const allLabels = labelsJson.data?.issueLabels?.nodes ?? [];
    const idFor = (name) => allLabels.find((l) => l.name === name)?.id;

    const commentMutation = `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }
    `;
    const commentRes = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: commentMutation, variables: { issueId, body } }),
    });
    if (!commentRes.ok) throw new Error(`Linear comment HTTP ${commentRes.status}`);

    const addIds = (labelsAdd ?? []).map(idFor).filter(Boolean);
    const removeIds = (labelsRemove ?? []).map(idFor).filter(Boolean);
    if (addIds.length || removeIds.length) {
      const updateMutation = `
        mutation($id: String!, $add: [String!], $remove: [String!]) {
          issueUpdate(id: $id, input: { labelIds: $add }) { success }
        }
      `;
      // Linear's issueUpdate replaces label set when labelIds is set; fetch current and merge.
      const currentRes = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({
          query: `query($id: String!) { issue(id: $id) { labels { nodes { id } } } }`,
          variables: { id: issueId },
        }),
      });
      const currentJson = await currentRes.json();
      const current = new Set((currentJson.data?.issue?.labels?.nodes ?? []).map((n) => n.id));
      for (const id of removeIds) current.delete(id);
      for (const id of addIds) current.add(id);
      await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({
          query: updateMutation,
          variables: { id: issueId, add: [...current] },
        }),
      });
    }
  })();
}

function recentlySubmitted(markerPath, guardMin) {
  if (!existsSync(markerPath)) return false;
  const ageMin = (Date.now() - statSync(markerPath).mtimeMs) / 60_000;
  return ageMin < guardMin;
}

async function main() {
  const workDir = env('INVOKER_LINEAR_WORK_DIR', join(tmpdir(), 'linear-ticket-intake'));
  mkdirSync(workDir, { recursive: true });
  const dryRun = env('INVOKER_LINEAR_DRY_RUN', '0') === '1';
  const sandbox = env('INVOKER_LINEAR_SANDBOX', '0') === '1';
  const apiKey = env('INVOKER_LINEAR_API_KEY') || env('LINEAR_API_KEY');
  const fixturePath = env('INVOKER_LINEAR_FIXTURE_ISSUES');
  const issueIds = env('INVOKER_LINEAR_ISSUE_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const defaultRepoUrl = env(
    'INVOKER_LINEAR_DEFAULT_REPO_URL',
    'https://github.com/Neko-Catpital-Labs/Invoker.git',
  );
  let submitCmd = env('INVOKER_LINEAR_SUBMIT_CMD', join(REPO_ROOT, 'submit-plan.sh'));
  if (sandbox && !env('INVOKER_LINEAR_SUBMIT_CMD')) {
    const dbDir = join(workDir, 'db');
    mkdirSync(dbDir, { recursive: true });
    submitCmd = `invoker-cli run --standalone --db-dir ${dbDir} --json`;
  }
  const plannerCmd = env('INVOKER_LINEAR_PLANNER_CMD');
  const commentCmd = env('INVOKER_LINEAR_COMMENT_CMD');
  const guardMin = Number(env('INVOKER_LINEAR_RESUBMIT_GUARD_MIN', '1200'));

  log(`workDir=${workDir} dryRun=${dryRun} sandbox=${sandbox} issueIds=${issueIds.join(',') || '(label:invoker-ready)'}`);
  const issues = await fetchLinearIssues({ apiKey, fixturePath, issueIds });
  log(`candidates=${issues.length}`);

  let submitted = 0;
  let needsInput = 0;
  let skipped = 0;

  for (const issue of issues) {
    const id = issue.id || issue.identifier;
    const identifier = issue.identifier || id;
    const marker = join(workDir, `submitted-${slugify(identifier)}`);
    if (recentlySubmitted(marker, guardMin)) {
      log(`${identifier}: resubmit guard; skip`);
      skipped += 1;
      continue;
    }

    const parsed = parseTicketFields(issue.title ?? '', issue.description ?? '');
    const fields =
      sandbox || issueIds.length
        ? enrichTicketFields(parsed, { sandbox: true, defaultRepoUrl })
        : parsed;
    log(`${identifier}: repo=${fields.repoUrl || '-'} file=${fields.fixFile || '-'} verify=${fields.verify || '-'}`);
    const gaps = listGaps(fields);
    if (gaps.length) {
      log(`${identifier}: ${gaps.length} gap(s); commenting`);
      await postLinearAction({
        apiKey,
        issueId: issue.id,
        body: formatGapComment(identifier, gaps),
        labelsAdd: [LABEL_NEEDS_INPUT],
        labelsRemove: [],
        dryRun,
        sandbox,
        commentCmd,
      });
      needsInput += 1;
      continue;
    }

    let planPath;
    try {
      if (plannerCmd) {
        planPath = runPlannerCmd(plannerCmd, issue, fields, workDir);
      } else {
        planPath = renderBugfixPlan(fields, workDir, sandbox);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`${identifier}: planner failed: ${message}`);
      await postLinearAction({
        apiKey,
        issueId: issue.id,
        body: formatGapComment(identifier, [{ field: 'Planner', message }]),
        labelsAdd: [LABEL_NEEDS_INPUT],
        labelsRemove: [],
        dryRun,
        sandbox,
        commentCmd,
      });
      needsInput += 1;
      continue;
    }

    const completeness = runCompleteness(planPath);
    if (!completeness.ok) {
      const gateGaps = (completeness.parsed?.gaps ?? []).map((g) => ({
        field: g.field,
        message: g.message,
      }));
      log(`${identifier}: completeness failed (${gateGaps.length})`);
      await postLinearAction({
        apiKey,
        issueId: issue.id,
        body: formatGapComment(identifier, gateGaps.length ? gateGaps : [{ field: 'Completeness', message: completeness.stderr || 'gate failed' }]),
        labelsAdd: [LABEL_NEEDS_INPUT],
        labelsRemove: [],
        dryRun,
        sandbox,
        commentCmd,
      });
      needsInput += 1;
      continue;
    }

    if (dryRun) {
      log(`${identifier}: would submit ${planPath}`);
      submitted += 1;
      continue;
    }

    const submitArgs = submitCmd.split(/\s+/).filter(Boolean);
    let submit;
    if (submitArgs[0] === 'invoker-cli' && submitArgs[1] === 'run') {
      submit = runCmd(submitArgs[0], ['run', planPath, ...submitArgs.slice(2)]);
    } else {
      submit = runCmd(submitArgs[0], [...submitArgs.slice(1), planPath]);
    }
    if (submit.status !== 0) {
      log(`${identifier}: submit failed: ${submit.stderr || submit.stdout}`);
      log(`${identifier}: submit stdout: ${(submit.stdout || '').slice(0, 800)}`);
      continue;
    }
    writeFileSync(marker, `${new Date().toISOString()}\n${planPath}\n${submit.stdout || ''}\n`);
    await postLinearAction({
      apiKey,
      issueId: issue.id,
      body: `Invoker intake submitted plan from ${identifier}.\nPlan: \`${planPath}\`\n(Workflow id is in the submit output on the worker host.)`,
      labelsAdd: [LABEL_RUNNING],
      labelsRemove: [LABEL_READY, LABEL_NEEDS_INPUT],
      dryRun: false,
      sandbox,
      commentCmd,
    });
    submitted += 1;
    log(`${identifier}: submitted ${planPath}`);
    log(`${identifier}: submit out: ${(submit.stdout || '').trim().split('\n').slice(-8).join(' | ')}`);
  }

  log(`summary: submitted=${submitted} needsInput=${needsInput} skipped=${skipped}`);
  if (issueIds.length && submitted < issueIds.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
