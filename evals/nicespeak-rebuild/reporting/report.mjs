#!/usr/bin/env node
/**
 * Immutable NiceSpeak rebuild eval reporter.
 *
 * Reads local git refs / PR diffs and optional Invoker cost JSON to produce
 * deterministic JSON + HTML comparison artifacts without mutating model branches.
 *
 * Live GitHub PR metadata is written under `liveMetadata` and is excluded from
 * the frozen content-hash body.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Known human interventions during the pilot (not scored as model correctness). */
export const HUMAN_INTERVENTIONS = Object.freeze({
  'qwen/09-slack-web-adapter': {
    kind: 'human_hotfix',
    note: 'Human hotfix on Qwen 09: unref timers + NODE_ENV=test / --test-force-exit so verify could exit after an open-handle hang.',
  },
});

export function canonicalizeDiff(diffText) {
  const lines = String(diffText).split('\n');
  const out = [];
  for (const line of lines) {
    if (line.startsWith('index ') || line.startsWith('diff --git ')) {
      // Keep path identity from diff --git, drop volatile index hashes.
      if (line.startsWith('diff --git ')) out.push(line.replace(/[0-9a-f]{7,}/g, '<hash>'));
      continue;
    }
    if (line.startsWith('@@')) {
      // Drop hunk offsets; keep change markers only via following +/- lines.
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      out.push(line.replace(/\t.*$/, ''));
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      out.push(line);
    }
  }
  return `${out.join('\n').trim()}\n`;
}

export function diffSimilarity(a, b) {
  if (a == null || b == null) return null;
  const left = canonicalizeDiff(a);
  const right = canonicalizeDiff(b);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const leftLines = new Set(left.split('\n').filter(Boolean));
  const rightLines = new Set(right.split('\n').filter(Boolean));
  let intersection = 0;
  for (const line of leftLines) {
    if (rightLines.has(line)) intersection += 1;
  }
  const union = leftLines.size + rightLines.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Paths touched in a unified diff (new-side path preferred). */
export function pathSetFromDiff(diffText) {
  if (diffText == null) return null;
  const paths = new Set();
  for (const line of String(diffText).split('\n')) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (m) paths.add(m[2]);
  }
  return paths;
}

export function pathSetJaccard(a, b) {
  if (a == null || b == null) return null;
  const left = a instanceof Set ? a : new Set(a);
  const right = b instanceof Set ? b : new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const p of left) {
    if (right.has(p)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function pathHighlights(a, b) {
  if (a == null || b == null) return null;
  const left = a instanceof Set ? a : new Set(a);
  const right = b instanceof Set ? b : new Set(b);
  const onlyA = [...left].filter((p) => !right.has(p)).sort();
  const onlyB = [...right].filter((p) => !left.has(p)).sort();
  const shared = [...left].filter((p) => right.has(p)).sort();
  return { onlyA, onlyB, shared };
}

/**
 * Parse `git diff --numstat` output into totals + per-path rows.
 */
export function parseNumstat(numstatText) {
  if (numstatText == null) return null;
  let additions = 0;
  let deletions = 0;
  const files = [];
  for (const line of String(numstatText).split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addRaw, delRaw, path] = parts;
    const add = addRaw === '-' ? 0 : Number(addRaw);
    const del = delRaw === '-' ? 0 : Number(delRaw);
    if (!Number.isFinite(add) || !Number.isFinite(del)) continue;
    additions += add;
    deletions += del;
    files.push({ path, additions: add, deletions: del });
  }
  return { filesChanged: files.length, additions, deletions, files };
}

/**
 * Map gh pr list JSON rows to eval/{lineage}/feature-* branches.
 * Returns `{ [lineageId]: { [featureId]: { number, url, title, headRefName } } }`.
 */
export function mapEvalPrsFromGhList(prs) {
  const out = {};
  for (const pr of prs || []) {
    const head = String(pr.headRefName || pr.head || '');
    // Branches look like eval/codex/feature-01-01-repo-bootstrap
    // → lineage=codex, featureId=01-repo-bootstrap (strip duplicate NN prefix).
    const m = head.match(/^eval\/(claude|codex|kimi|qwen)\/feature-\d+-(.+)$/);
    if (!m) continue;
    const lineageId = m[1];
    const featureId = m[2];
    if (!out[lineageId]) out[lineageId] = {};
    out[lineageId][featureId] = {
      number: pr.number,
      url: pr.url,
      title: pr.title,
      headRefName: head,
    };
  }
  return out;
}

export function interventionFor(lineageId, featureId) {
  return HUMAN_INTERVENTIONS[`${lineageId}/${featureId}`] ?? null;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function loadManifest() {
  return parseYaml(readFileSync(join(ROOT, 'manifest.yaml'), 'utf8'));
}

function git(repoPath, args) {
  return spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function gitDiff(repoPath, baseRef, headRef) {
  const result = git(repoPath, ['diff', '--no-ext-diff', `${baseRef}...${headRef}`]);
  if (result.status !== 0) return null;
  return result.stdout;
}

function gitNumstat(repoPath, baseRef, headRef) {
  const result = git(repoPath, ['diff', '--numstat', `${baseRef}...${headRef}`]);
  if (result.status !== 0) return null;
  return parseNumstat(result.stdout);
}

function gitShow(repoPath, ref, path) {
  const result = git(repoPath, ['show', `${ref}:${path}`]);
  if (result.status !== 0) return null;
  return result.stdout;
}

function gitPathExists(repoPath, ref, path) {
  const result = git(repoPath, ['cat-file', '-e', `${ref}:${path}`]);
  return result.status === 0;
}

/**
 * Mechanical acceptance heuristics from feature specs (not the human oracle).
 */
export function runAcceptanceHeuristics(repoPath, branch, featureId) {
  const checks = [];
  const push = (id, ok, detail) => {
    checks.push({ id, ok: Boolean(ok), detail: detail ?? '' });
  };

  if (featureId === '01-repo-bootstrap') {
    const pkgRaw = gitShow(repoPath, branch, 'package.json');
    let pkg = null;
    try {
      pkg = pkgRaw ? JSON.parse(pkgRaw) : null;
    } catch {
      pkg = null;
    }
    push('package_json_exists', Boolean(pkg), pkg ? 'parsed' : 'missing or invalid');
    push('type_module', pkg?.type === 'module', `type=${pkg?.type ?? 'missing'}`);
    push('engines_node_gte_22', pkg?.engines?.node === '>=22', `engines.node=${pkg?.engines?.node ?? 'missing'}`);
    push('scripts_test', typeof pkg?.scripts?.test === 'string', `test=${pkg?.scripts?.test ?? 'missing'}`);
    push('scripts_check', typeof pkg?.scripts?.check === 'string', `check=${pkg?.scripts?.check ?? 'missing'}`);
    push('gitignore_exists', gitPathExists(repoPath, branch, '.gitignore'), '');
    push('readme_exists', gitPathExists(repoPath, branch, 'README.md'), '');
    const smoke = gitShow(repoPath, branch, 'test/smoke.test.js')
      ?? gitShow(repoPath, branch, 'test/smoke.test.mjs')
      ?? '';
    const hasSmoke = smoke.length > 0;
    push('smoke_test_exists', hasSmoke, hasSmoke ? 'test/smoke.test.*' : 'missing');
    const assertsBootstrap = /engines|type\s*===?\s*['"]module['"]|packageJson|package\.json/i.test(smoke);
    const trivialArith = /1\s*\+\s*1/.test(smoke) && !assertsBootstrap;
    push('smoke_asserts_bootstrap_contract', assertsBootstrap, trivialArith ? 'trivial 1+1 smoke' : (assertsBootstrap ? 'contract asserts present' : 'no contract asserts'));
  } else {
    // Generic: at least one test file or package.json scripts.test on the branch tip.
    const pkgRaw = gitShow(repoPath, branch, 'package.json');
    let pkg = null;
    try {
      pkg = pkgRaw ? JSON.parse(pkgRaw) : null;
    } catch {
      pkg = null;
    }
    push('package_json_exists', Boolean(pkg), pkg ? 'parsed' : 'missing or invalid');
    push('scripts_test', typeof pkg?.scripts?.test === 'string', `test=${pkg?.scripts?.test ?? 'missing'}`);
    const ls = git(repoPath, ['ls-tree', '-r', '--name-only', branch]);
    const paths = ls.status === 0 ? ls.stdout.split('\n').filter(Boolean) : [];
    const testPaths = paths.filter((p) => /(^|\/)test\//.test(p) || /\.test\.(js|mjs|cjs|ts)$/.test(p));
    push('has_test_files', testPaths.length > 0, `${testPaths.length} test path(s)`);
  }

  const failed = checks.filter((c) => !c.ok).map((c) => c.id);
  return {
    passed: failed.length === 0,
    failed,
    checks,
  };
}

function cheapVsPremiumSummary(pairwise, lineages) {
  const premium = new Set(lineages.filter((l) => l.premium).map((l) => l.id));
  const cheap = lineages.filter((l) => !l.premium).map((l) => l.id);
  const rows = [];
  for (const c of cheap) {
    for (const p of premium) {
      const key = [c, p].sort().join('__');
      rows.push({
        cheap: c,
        premium: p,
        similarity: pairwise[key] ?? null,
      });
    }
  }
  return rows;
}

function costForFeature(costs, lineageId, featureId) {
  return costs?.byLineage?.[lineageId]?.features?.[featureId] ?? null;
}

function fetchLivePrMetadata(targetRepoUrl) {
  const repoMatch = String(targetRepoUrl || '').match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  if (!repoMatch) return { prsByLineage: {}, error: 'could not parse targetRepo' };
  const repo = `${repoMatch[1]}/${repoMatch[2]}`;
  const result = spawnSync(
    'gh',
    ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', 'number,title,headRefName,url'],
    { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    return { prsByLineage: {}, error: (result.stderr || result.stdout || 'gh failed').trim() };
  }
  let prs;
  try {
    prs = JSON.parse(result.stdout);
  } catch (err) {
    return { prsByLineage: {}, error: `gh JSON parse failed: ${err.message}` };
  }
  return {
    prsByLineage: mapEvalPrsFromGhList(prs),
    error: null,
    repo,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtScore(score) {
  if (score == null) return '<span class="null">missing</span>';
  return score.toFixed(4);
}

function fmtTokens(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

function renderHtml(manifest, features, costs, liveMetadata) {
  const lineageIds = ['claude', 'codex', 'qwen'];
  const indexRows = manifest.pilotFeatureIds.map((featureId) => {
    const f = features[featureId];
    const cells = lineageIds.map((id) => {
      const L = f.lineages[id];
      if (!L || L.missing) {
        return `<td class="null">missing</td>`;
      }
      const pr = liveMetadata?.prsByLineage?.[id]?.[featureId];
      const cost = L.cost;
      const status = cost?.status ?? (L.acceptance?.passed ? 'heuristics_ok' : 'heuristics_fail');
      const prHtml = pr
        ? `<a href="${escapeHtml(pr.url)}">#${pr.number}</a>`
        : '<span class="null">no PR</span>';
      const interv = L.intervention
        ? `<div class="flag">⚠ ${escapeHtml(L.intervention.kind)}</div>`
        : '';
      return `<td>
        <div>${prHtml}</div>
        <div class="muted">${escapeHtml(status)}</div>
        <div class="muted">in ${fmtTokens(cost?.inputTokens ?? 0)} / out ${fmtTokens(cost?.outputTokens ?? 0)}</div>
        ${interv}
      </td>`;
    }).join('');
    return `<tr><th><a href="#${escapeHtml(featureId)}">${escapeHtml(featureId)}</a></th>${cells}</tr>`;
  }).join('\n');

  const detailSections = manifest.pilotFeatureIds.map((featureId) => {
    const f = features[featureId];
    const lineageCols = lineageIds.map((id) => {
      const L = f.lineages[id];
      if (!L) {
        return `<td class="null">missing lineage</td>`;
      }
      const pr = liveMetadata?.prsByLineage?.[id]?.[featureId];
      const cost = L.cost;
      const checks = (L.acceptance?.checks || [])
        .map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${escapeHtml(c.id)}: ${escapeHtml(c.detail || (c.ok ? 'ok' : 'fail'))}</li>`)
        .join('');
      const interv = L.intervention
        ? `<p class="flag">${escapeHtml(L.intervention.note)}</p>`
        : '';
      return `<td>
        <h3>${escapeHtml(id)}</h3>
        <p>${pr ? `<a href="${escapeHtml(pr.url)}">${escapeHtml(pr.title || `#${pr.number}`)}</a>` : '<span class="null">no PR metadata</span>'}</p>
        <p class="muted">branch <code>${escapeHtml(L.branch || '')}</code></p>
        <p class="muted">workflow <code>${escapeHtml(cost?.workflowId || L.workflowName || '—')}</code> · ${escapeHtml(cost?.status || '—')}</p>
        <p>tokens in/out/cached: ${fmtTokens(cost?.inputTokens)} / ${fmtTokens(cost?.outputTokens)} / ${fmtTokens(cost?.cachedTokens)}</p>
        <p>diff: +${L.diffStats?.additions ?? 0} −${L.diffStats?.deletions ?? 0} · ${L.diffStats?.filesChanged ?? 0} files</p>
        ${interv}
        <p><strong>acceptance heuristics</strong> ${L.acceptance?.passed ? 'PASS' : 'FAIL'}</p>
        <ul>${checks}</ul>
      </td>`;
    }).join('');

    const pairRows = Object.entries(f.pairwise).map(([pair, score]) => {
      const pathScore = f.pathPairwise?.[pair];
      const hl = f.pathHighlights?.[pair];
      const hlHtml = hl
        ? `<div class="muted">only left: ${escapeHtml((hl.onlyA || []).slice(0, 8).join(', ') || '—')}<br>
           only right: ${escapeHtml((hl.onlyB || []).slice(0, 8).join(', ') || '—')}<br>
           shared: ${escapeHtml((hl.shared || []).slice(0, 8).join(', ') || '—')}</div>`
        : '';
      return `<tr>
        <td>${escapeHtml(pair)}</td>
        <td>${fmtScore(score)}</td>
        <td>${fmtScore(pathScore)}</td>
        <td>${hlHtml}</td>
      </tr>`;
    }).join('');

    return `<section id="${escapeHtml(featureId)}">
      <h2>${escapeHtml(featureId)}</h2>
      <table class="tri"><thead><tr><th></th><th>claude</th><th>codex</th><th>qwen</th></tr></thead>
      <tbody><tr><th>detail</th>${lineageCols}</tr></tbody></table>
      <h3>pairwise</h3>
      <table><thead><tr><th>pair</th><th>diff Jaccard</th><th>path Jaccard</th><th>path highlights</th></tr></thead>
      <tbody>${pairRows}</tbody></table>
    </section>`;
  }).join('\n');

  const liveNote = liveMetadata?.error
    ? `<p class="flag">PR metadata: ${escapeHtml(liveMetadata.error)}</p>`
    : `<p class="muted">PR metadata from gh (${escapeHtml(liveMetadata?.repo || '—')}); excluded from frozen hash.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>NiceSpeak rebuild eval — per-workflow</title>
<style>
body{font-family:ui-monospace,Menlo,monospace;margin:2rem;background:#111;color:#eee;line-height:1.4}
table{border-collapse:collapse;margin:1rem 0;width:100%}
th,td{border:1px solid #333;padding:.4rem .6rem;text-align:left;vertical-align:top}
th{background:#222}
.null{color:#888}
.muted{color:#9aa;font-size:.9em}
.flag{color:#f5a623}
.ok{color:#6c6}
.bad{color:#f66}
a{color:#8cf}
.tri td{width:30%}
section{margin:2.5rem 0;padding-top:1rem;border-top:1px solid #333}
ul{margin:.3rem 0 .8rem 1.2rem;padding:0}
</style></head><body>
<h1>NiceSpeak rebuild eval — per-workflow</h1>
<p>source ${escapeHtml(manifest.sourceSha)} · pricing ${escapeHtml(manifest.pricingTableVersion)}</p>
<p>Lineages compared: claude · codex · qwen (kimi skipped). Correctness oracle remains human-final.</p>
${liveNote}
<p class="muted">estimatedCostUsd is often 0 when model=unknown; raw tokens are authoritative.
${costs?.pricingNote ? escapeHtml(costs.pricingNote) : ''}</p>
<h2>Index</h2>
<table>
<thead><tr><th>feature</th><th>claude</th><th>codex</th><th>qwen</th></tr></thead>
<tbody>${indexRows}</tbody>
</table>
${detailSections}
</body></html>
`;
}

function main() {
  const args = process.argv.slice(2);
  const repoPath = args[0];
  const outDir = args[1] || join(ROOT, 'generated', 'reports');
  const costJsonPath = args[2];
  if (!repoPath) {
    console.error('Usage: node report.mjs <target-repo-path> [out-dir] [cost-events.json]');
    process.exit(1);
  }

  const manifest = loadManifest();
  const indexPath = join(ROOT, 'generated', 'pilot', 'index.json');
  if (!existsSync(indexPath)) {
    console.error('Missing generated/pilot/index.json — run render-pilot.mjs first');
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  mkdirSync(outDir, { recursive: true });

  let costs = null;
  if (costJsonPath && existsSync(costJsonPath)) {
    costs = JSON.parse(readFileSync(costJsonPath, 'utf8'));
  }

  const features = {};
  for (const featureId of manifest.pilotFeatureIds) {
    const rawDiffs = {};
    const canonicalDiffs = {};
    const pathSets = {};
    const lineagesOut = {};

    for (const lineage of index.lineages) {
      const entry = lineage.chain.find((c) => c.featureId === featureId);
      if (!entry) continue;
      const diff = gitDiff(repoPath, entry.baseBranch, entry.branch);
      const missing = diff == null;
      rawDiffs[lineage.id] = diff;
      canonicalDiffs[lineage.id] = missing ? null : canonicalizeDiff(diff);
      pathSets[lineage.id] = missing ? null : pathSetFromDiff(diff);
      const diffStats = missing ? null : gitNumstat(repoPath, entry.baseBranch, entry.branch);
      const acceptance = missing
        ? { passed: false, failed: ['diff_missing'], checks: [{ id: 'diff_missing', ok: false, detail: 'could not read base...head' }] }
        : runAcceptanceHeuristics(repoPath, entry.branch, featureId);
      const intervention = interventionFor(lineage.id, featureId);
      const cost = costForFeature(costs, lineage.id, featureId);
      lineagesOut[lineage.id] = {
        branch: entry.branch,
        baseBranch: entry.baseBranch,
        workflowName: entry.workflowName,
        crossModelPromptHash: entry.crossModelPromptHash,
        missing,
        diffStats,
        paths: pathSets[lineage.id] ? [...pathSets[lineage.id]].sort() : null,
        acceptance,
        intervention,
        cost,
      };
    }

    const pairwise = {};
    const pathPairwise = {};
    const highlights = {};
    const ids = Object.keys(canonicalDiffs);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i];
        const b = ids[j];
        const key = [a, b].sort().join('__');
        pairwise[key] = diffSimilarity(canonicalDiffs[a], canonicalDiffs[b]);
        pathPairwise[key] = pathSetJaccard(pathSets[a], pathSets[b]);
        const [leftId, rightId] = key.split('__');
        highlights[key] = pathHighlights(pathSets[leftId], pathSets[rightId]);
      }
    }

    features[featureId] = {
      pairwise,
      pathPairwise,
      pathHighlights: highlights,
      cheapVsPremium: cheapVsPremiumSummary(pairwise, manifest.lineages),
      availableLineages: ids.filter((id) => canonicalDiffs[id] != null),
      missingLineages: ids.filter((id) => canonicalDiffs[id] == null),
      lineages: lineagesOut,
    };
  }

  const reportBody = {
    sourceSha: manifest.sourceSha,
    pricingTableVersion: manifest.pricingTableVersion,
    targetRepo: manifest.targetRepo,
    features,
    costs,
    notes: [
      'Missing/failed diffs remain null — never scored as zero similarity.',
      'Similarity uses canonical git textual diff Jaccard over path/content lines.',
      'Path Jaccard compares touched-file sets only.',
      'Acceptance heuristics are mechanical aids; correctnessOracle remains human-final-result-comparison.',
      'Costs are equivalent-API estimates with explicit confidence; raw tokens are authoritative.',
      'Qwen 09 includes a documented human hotfix (see intervention flags); do not treat that feature as pure model output.',
    ],
  };

  // Stamp is derived from immutable body so repeated runs over frozen refs are byte-identical.
  const bodyHash = sha256(JSON.stringify(reportBody));

  const liveFetch = process.env.NICESPEAK_EVAL_SKIP_GH === '1'
    ? { prsByLineage: {}, error: 'skipped (NICESPEAK_EVAL_SKIP_GH=1)', repo: null }
    : fetchLivePrMetadata(manifest.targetRepo);

  const liveMetadata = {
    fetchedAt: process.env.NICESPEAK_EVAL_REPORT_GENERATED_AT || new Date().toISOString(),
    ...liveFetch,
  };

  const report = {
    generatedAt: process.env.NICESPEAK_EVAL_REPORT_GENERATED_AT || `content-hash:${bodyHash}`,
    frozenContentHash: bodyHash,
    ...reportBody,
    liveMetadata,
  };

  const jsonText = `${JSON.stringify(report, null, 2)}\n`;
  const jsonPath = join(outDir, 'nicespeak-eval-report.json');
  writeFileSync(jsonPath, jsonText);

  const frozenOnly = `${JSON.stringify({ generatedAt: `content-hash:${bodyHash}`, frozenContentHash: bodyHash, ...reportBody }, null, 2)}\n`;
  const jsonHash = sha256(frozenOnly);
  writeFileSync(join(outDir, 'nicespeak-eval-report.sha256'), `${jsonHash}\n`);

  const html = renderHtml(manifest, features, costs, liveMetadata);
  writeFileSync(join(outDir, 'nicespeak-eval-report.html'), html);

  // Published snapshot for Invoker PR review (stable path).
  const publishedDir = join(ROOT, 'published');
  mkdirSync(publishedDir, { recursive: true });
  writeFileSync(join(publishedDir, 'nicespeak-eval-report.json'), jsonText);
  writeFileSync(join(publishedDir, 'nicespeak-eval-report.html'), html);
  writeFileSync(join(publishedDir, 'nicespeak-eval-report.sha256'), `${jsonHash}\n`);
  if (costJsonPath && existsSync(costJsonPath)) {
    writeFileSync(join(publishedDir, 'cost-events.json'), readFileSync(costJsonPath));
  }

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${join(publishedDir, 'nicespeak-eval-report.html')}`);
  console.log(`FROZEN_HASH ${jsonHash}`);
  console.log(`CONTENT_HASH ${bodyHash}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}
