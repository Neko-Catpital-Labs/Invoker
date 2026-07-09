#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const [, , sourcePath, planPath] = process.argv;

if (!sourcePath || !planPath) {
  console.error('Usage: node check-source-plan-coverage.mjs <source-file> <plan-file>');
  process.exit(2);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function collectJsonStrings(value, output) {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectJsonStrings(item, output);
  }
}

function expandSourceText(raw) {
  const parts = [raw];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const strings = [];
      collectJsonStrings(JSON.parse(trimmed), strings);
      parts.push(...strings);
    } catch {
      // Ignore non-JSON lines; source documents can be markdown or logs.
    }
  }
  return parts.join('\n');
}

function normalizeScalar(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function taskIdsFrom(text) {
  const ids = [];
  let inTasks = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^tasks:\s*(?:$|\[)/.test(line)) {
      inTasks = true;
      continue;
    }
    if (inTasks && /^[A-Za-z0-9_-]+:\s*/.test(line)) {
      inTasks = false;
    }
    if (!inTasks) continue;
    const match = line.match(/^\s*-\s+id:\s*(.+?)\s*$/);
    if (match) ids.push(normalizeScalar(match[1]));
  }
  return ids.filter(Boolean);
}

function summarizePlan(text) {
  const name = normalizeScalar(text.match(/^name:\s*(.+?)\s*$/m)?.[1] || '');
  const repoUrl = normalizeScalar(text.match(/^repoUrl:\s*(.+?)\s*$/m)?.[1] || '');
  const ids = taskIdsFrom(text);
  return { text, name, repoUrl, taskIds: ids };
}

function fencedCandidates(text) {
  const candidates = [];
  const regex = /```(?:ya?ml|yaml|yml)?[^\n]*\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(regex)) {
    candidates.push(match[1].trim() + '\n');
  }
  return candidates;
}

function lineWindowCandidates(text) {
  const lines = text.split(/\r?\n/);
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^name:\s*\S/.test(lines[index])) continue;
    const window = [];
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (cursor > index && /^```/.test(line)) break;
      window.push(line);
      if (window.length > 500) break;
    }
    candidates.push(window.join('\n').trim() + '\n');
  }
  return candidates;
}

function extractBestSourcePlan(raw) {
  const text = expandSourceText(raw);
  const candidates = [
    ...fencedCandidates(text),
    ...lineWindowCandidates(text),
    text,
  ].map(summarizePlan);

  const planCandidates = candidates.filter((candidate) => (
    candidate.name && candidate.repoUrl && candidate.taskIds.length > 0
  ));
  if (planCandidates.length === 0) return null;

  return planCandidates.sort((a, b) => b.taskIds.length - a.taskIds.length)[0];
}

function unique(values) {
  return [...new Set(values)];
}

const sourcePlan = extractBestSourcePlan(read(sourcePath));
if (!sourcePlan) {
  console.log(JSON.stringify({
    checked: false,
    reason: 'no concrete source Invoker plan detected',
  }));
  process.exit(0);
}

const generatedPlan = summarizePlan(read(planPath));
const sourceTaskIds = unique(sourcePlan.taskIds);
const generatedTaskIds = unique(generatedPlan.taskIds);
const generatedSet = new Set(generatedTaskIds);
const missingTaskIds = sourceTaskIds.filter((id) => !generatedSet.has(id));

const result = {
  checked: true,
  sourceName: sourcePlan.name,
  generatedName: generatedPlan.name,
  sourceTaskCount: sourceTaskIds.length,
  generatedTaskCount: generatedTaskIds.length,
  missingTaskIds,
};

if (missingTaskIds.length > 0) {
  console.error(JSON.stringify(result, null, 2));
  console.error(`Generated plan does not preserve ${missingTaskIds.length} source task id(s).`);
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
