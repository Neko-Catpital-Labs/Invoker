import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DecisionFixture, WorkerDecision } from './types.js';

const FIXTURES_ROOT = dirname(fileURLToPath(import.meta.url));

function isDecision(value: unknown): value is WorkerDecision {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'skip' || type === 'mutation' || type === 'effect';
}

function parseFixture(raw: string, path: string): DecisionFixture {
  const parsed = JSON.parse(raw) as Partial<DecisionFixture>;
  if (typeof parsed.kind !== 'string' || typeof parsed.name !== 'string') {
    throw new Error(`decision fixture ${path} needs kind and name`);
  }
  if (!Array.isArray(parsed.decisions) || !parsed.decisions.every(isDecision)) {
    throw new Error(`decision fixture ${path} needs a decisions array`);
  }
  return parsed as DecisionFixture;
}

export function listDecisionFixtureFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(FIXTURES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const kindDir = join(FIXTURES_ROOT, entry.name);
    for (const name of readdirSync(kindDir)) {
      if (!name.endsWith('.json')) continue;
      files.push(join(kindDir, name));
    }
  }
  return files.sort();
}

export function loadDecisionFixtures(): DecisionFixture[] {
  return listDecisionFixtureFiles().map((path) => parseFixture(readFileSync(path, 'utf8'), path));
}

export function loadDecisionFixturesForKind(kind: string): DecisionFixture[] {
  return loadDecisionFixtures().filter((fixture) => fixture.kind === kind);
}

export function kindsWithDecisionFixtures(): string[] {
  return [...new Set(loadDecisionFixtures().map((fixture) => fixture.kind))].sort();
}

export { FIXTURES_ROOT };
