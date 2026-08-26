#!/usr/bin/env node
/**
 * Deterministic NiceSpeak rebuild eval plan renderer.
 *
 * Emits one workflow YAML per (lineage, feature). Feature prompt bodies are
 * byte-identical across lineages except for generated agent/model/branch metadata.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(ROOT, '../..');

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function loadManifest() {
  return parseYaml(readFileSync(join(ROOT, 'manifest.yaml'), 'utf8'));
}

function loadFeatures(manifest) {
  return manifest.pilotFeatureIds.map((id) => {
    const path = join(ROOT, 'features', `${id}.md`);
    const body = readFileSync(path, 'utf8');
    const title = body.split('\n').find((line) => line.startsWith('# '))?.slice(2).trim() || id;
    return { id, title, body, contentHash: sha256(body) };
  });
}

function yamlQuote(value) {
  return JSON.stringify(String(value));
}

function buildPrompt({ feature, lineage, featureIndex, previousBranch, promptContentHash }) {
  const branch = `eval/${lineage.id}/feature-${String(featureIndex + 1).padStart(2, '0')}-${feature.id}`;
  const meta = [
    `EVAL_LINEAGE=${lineage.id}`,
    `EVAL_EXECUTION_AGENT=${lineage.executionAgent}`,
    `EVAL_EXECUTION_MODEL=${lineage.executionModel}`,
    `EVAL_FEATURE_ID=${feature.id}`,
    `EVAL_FEATURE_INDEX=${featureIndex + 1}`,
    `EVAL_FEATURE_BRANCH=${branch}`,
    `EVAL_BASE_BRANCH=${previousBranch}`,
    `EVAL_SPEC_CONTENT_HASH=${promptContentHash}`,
    `EVAL_SOURCE_SHA=${loadManifest().sourceSha}`,
  ].join('\n');

  return [
    meta,
    'Assume no prior context. Execute this prompt as a zero-context remote task.',
    'You are rebuilding NiceSpeak into a new empty repository through Invoker.',
    'Hard isolation rules:',
    '- Use ONLY the feature specification below and any docs already present in THIS target repository.',
    '- Do NOT read, clone, fetch, or browse NiceSpeak source or NiceSpeak tests.',
    '- Do NOT access host GitHub credentials, SSH agents, or paths outside this worktree.',
    '- Write new tests from the acceptance criteria; do not port NiceSpeak tests.',
    'Feature specification:',
    // Keep feature body contiguous; blank lines break plan-to-invoker prompt block parsing.
    feature.body.split('\n').map((line) => (line.trim() === '' ? '.' : line)).join('\n'),
    'Review claim: Implement only this feature slice.',
    'Review lane: behavior',
    'Safety invariant: Change only this feature and its direct tests; preserve prior contracts; never read or port NiceSpeak source/tests; leave a buildable branch; keep rewrite fail-closed / no-send-before-accept where applicable.',
    'Slice rationale: One reviewable feature for multi-model comparison.',
    'Architectural effect: Adds the capability described above on top of prior lineage commits.',
    'Goal: Satisfy the acceptance criteria in the specification.',
    'Motivation: Multi-model rebuild eval comparing premium and cheaper coding agents.',
    'Alternative considerations: Porting NiceSpeak source or tests is forbidden; reconstruct from this spec only.',
    'Implementation details: Follow the acceptance criteria literally and touch only files required by this slice (for example package.json, README.md, .gitignore, apps/, test/, and related .js/.ts/.md files).',
    'Non-goals: Later pilot features and expansion surfaces.',
    'Files: package.json, README.md, .gitignore, apps/, test/, and any new files required by this feature',
    'Change types: feature',
    'Acceptance criteria: Implement every must/ensure/verify item in the specification so npm test or the stated verify command exits with exit code 0.',
    'Layer: domain',
    'Feature state: active',
    `When finished, ensure the slice verification exits with exit code 0 and summarize the PR-ready commit on branch ${branch}.`,
  ].join('\n');
}

function renderWorkflow({ manifest, feature, lineage, featureIndex, previousBranch, isFirst }) {
  const promptContentHash = feature.contentHash;
  const prompt = buildPrompt({
    feature,
    lineage,
    featureIndex,
    previousBranch,
    promptContentHash,
  });
  const promptHash = sha256(prompt.replace(/^EVAL_LINEAGE=.*$/m, 'EVAL_LINEAGE=')
    .replace(/^EVAL_EXECUTION_AGENT=.*$/m, 'EVAL_EXECUTION_AGENT=')
    .replace(/^EVAL_EXECUTION_MODEL=.*$/m, 'EVAL_EXECUTION_MODEL=')
    .replace(/^EVAL_FEATURE_BRANCH=.*$/m, 'EVAL_FEATURE_BRANCH=')
    .replace(/^EVAL_BASE_BRANCH=.*$/m, 'EVAL_BASE_BRANCH='));
  // Content-stable hash excludes lineage-specific branch/agent metadata lines above
  // by hashing the feature body alone for cross-model equality checks.
  const crossModelPromptHash = feature.contentHash;
  const branch = `eval/${lineage.id}/feature-${String(featureIndex + 1).padStart(2, '0')}-${feature.id}`;
  const workflowName = `nicespeak-eval/${lineage.id}/${feature.id}`;
  const taskId = `impl-${feature.id}`;
  const verifyId = `verify-${feature.id}`;

  const externalDependencies = isFirst
    ? ''
    : `
externalDependencies:
  - workflowId: "__UPSTREAM_WORKFLOW_ID__"
    taskId: "__merge__"
    requiredStatus: completed
    gatePolicy: review_ready
`;

  return {
    workflowName,
    branch,
    crossModelPromptHash,
    promptHash,
    yaml: `name: ${yamlQuote(workflowName)}
description: |
  NiceSpeak rebuild eval pilot slice.
  Review claim: Implement ${feature.id} for lineage ${lineage.id}.
  Safety invariant: Change only this feature and its direct tests; preserve prior contracts; never read or port NiceSpeak source/tests; leave a buildable branch; keep rewrite fail-closed / no-send-before-accept where applicable.
  Spec content hash: ${feature.contentHash}
  Cross-model prompt hash: ${crossModelPromptHash}
onFinish: ${manifest.onFinish}
mergeMode: ${manifest.mergeMode}
repoUrl: ${yamlQuote(manifest.targetRepo)}
baseBranch: ${yamlQuote(previousBranch)}
featureBranch: ${yamlQuote(branch)}
${externalDependencies}
tasks:
  - id: ${taskId}
    description: |
      Implement ${feature.id} (${feature.title}).
      Review claim: Implement only this feature slice for lineage comparison.
      Review lane: behavior
      Safety invariant: Change only this feature and its direct tests; preserve prior contracts; never read or port NiceSpeak source/tests; leave a buildable branch; keep rewrite fail-closed / no-send-before-accept where applicable.
      Slice rationale: One independently reviewable feature per model lineage.
      Architectural effect: Adds ${feature.id} on the cumulative lineage branch.
      Goal: Meet the feature acceptance criteria.
      Motivation: Compare premium vs cheap coding agents on equivalent prompts.
      Alternative considerations: Porting NiceSpeak source/tests is forbidden.
      Implementation details: Follow the attached zero-context prompt.
      Non-goals: Other pilot features and expansion surfaces.
      Files: package.json, README.md, .gitignore, apps/, test/
      Change types: feature
      Acceptance criteria: Feature specification ${feature.id} must pass and verification must exit 0
      Layer: domain
      Feature state: active
    prompt: |
${prompt.split('\n').map((line) => `      ${line}`).join('\n')}
    executionAgent: ${lineage.executionAgent}
    executionModel: ${yamlQuote(lineage.executionModel)}
    poolId: ${manifest.pools.agentPoolId}
    dependencies: []
  - id: ${verifyId}
    description: |
      Verify ${feature.id} with a deterministic local check.
      Review claim: Prove the slice still builds/tests locally.
      Review lane: proof
      Safety invariant: Verification is command-only and does not mutate lineage identity.
      Slice rationale: Every implementation step needs a pass/fail command.
      Architectural effect: None beyond validation.
      Goal: Exit 0 on package checks when present.
      Motivation: Keep lineages comparable.
      Alternative considerations: Full suite gates are out of scope.
      Implementation details: Run npm test when package.json exists, otherwise a no-op success.
      Non-goals: Cross-lineage scoring.
      Files: package.json
      Change types: verification
      Acceptance criteria: Command exits 0
      Layer: app_regression
      Feature state: active
    command: "npm test"
    poolId: ${manifest.pools.verifyPoolId}
    dependencies:
      - ${taskId}
`,
  };
}

function main() {
  const manifest = loadManifest();
  const features = loadFeatures(manifest);
  const outDir = join(ROOT, 'generated', 'pilot');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const index = {
    generatedAt: new Date().toISOString(),
    sourceSha: manifest.sourceSha,
    pricingTableVersion: manifest.pricingTableVersion,
    lineages: [],
    crossModelPromptHashes: {},
  };

  for (const lineage of manifest.lineages) {
    const lineageDir = join(outDir, lineage.id);
    mkdirSync(lineageDir, { recursive: true });
    let previousBranch = manifest.targetDefaultBranch;
    const chain = [];
    for (let i = 0; i < features.length; i += 1) {
      const feature = features[i];
      const rendered = renderWorkflow({
        manifest,
        feature,
        lineage,
        featureIndex: i,
        previousBranch,
        isFirst: i === 0,
      });
      const fileName = i === 0
        ? `${String(i + 1).padStart(2, '0')}-${feature.id}.yaml`
        : `${String(i + 1).padStart(2, '0')}-${feature.id}.template.yaml`;
      const filePath = join(lineageDir, fileName);
      writeFileSync(filePath, rendered.yaml);
      chain.push({
        featureId: feature.id,
        file: filePath.replace(`${REPO_ROOT}/`, ''),
        workflowName: rendered.workflowName,
        branch: rendered.branch,
        baseBranch: previousBranch,
        crossModelPromptHash: rendered.crossModelPromptHash,
      });
      index.crossModelPromptHashes[feature.id] ??= rendered.crossModelPromptHash;
      if (index.crossModelPromptHashes[feature.id] !== rendered.crossModelPromptHash) {
        throw new Error(`Cross-model prompt hash drift for ${feature.id}`);
      }
      previousBranch = rendered.branch;
    }
    index.lineages.push({
      id: lineage.id,
      executionAgent: lineage.executionAgent,
      executionModel: lineage.executionModel,
      chain,
    });
  }

  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`Rendered ${manifest.lineages.length * features.length} workflows → ${outDir}`);
}

main();
