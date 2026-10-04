import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { parsePlan, PlanParseError } from '../plan-parser.js';

const isolatedConfigPath = join(tmpdir(), `invoker-plan-parser-review-claims-config-${process.pid}.json`);

beforeEach(() => {
  process.env.INVOKER_REPO_CONFIG_PATH = isolatedConfigPath;
  writeFileSync(isolatedConfigPath, JSON.stringify({ defaultBranch: 'main' }));
});

interface PlanOptions {
  repoUrl?: string;
  onFinish?: string;
  mergeMode?: string;
  secondClaim?: string;
  secondLane?: string;
  secondCommand?: string;
  publishMode?: string;
}

function buildPlan(options: PlanOptions = {}): string {
  const {
    repoUrl = 'https://github.com/EdbertChan/catstack',
    onFinish = 'pull_request',
    mergeMode = 'external_review',
    secondClaim = 'Second claim about docs',
    secondLane = 'docs',
    secondCommand,
    publishMode,
  } = options;
  const secondTaskBody = secondCommand
    ? `    command: "${secondCommand}"`
    : '    prompt: "Do the second thing"';
  return [
    'name: review-claims-plan',
    `onFinish: ${onFinish}`,
    `mergeMode: ${mergeMode}`,
    `repoUrl: ${repoUrl}`,
    ...(publishMode === undefined ? [] : [`publishMode: ${publishMode}`]),
    'tasks:',
    '  - id: first',
    '    description: |',
    '      Do the first thing',
    '      Review claim: First claim about behavior',
    '      Review lane: behavior',
    '    prompt: "Do the first thing"',
    '  - id: second',
    '    description: |',
    '      Do the second thing',
    `      Review claim: ${secondClaim}`,
    `      Review lane: ${secondLane}`,
    secondTaskBody,
    '    dependencies: [first]',
    '',
  ].join('\n');
}

describe('parsePlan review claim count', () => {
  it('rejects a single-PR plan whose prompt tasks carry two distinct review claims', () => {
    let error: unknown;
    try {
      parsePlan(buildPlan());
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PlanParseError);
    const message = (error as Error).message;
    expect(message).toMatch(/carries 2 review claims/);
    expect(message).toContain('"First claim about behavior"');
    expect(message).toContain('"Second claim about docs"');
  });

  it('accepts a plan whose tasks share one review claim', () => {
    expect(() => parsePlan(buildPlan({ secondClaim: 'First claim about behavior' }))).not.toThrow();
  });

  it('does not count proof-lane tasks', () => {
    expect(() => parsePlan(buildPlan({ secondLane: 'proof' }))).not.toThrow();
  });

  it('does not count command tasks', () => {
    expect(() => parsePlan(buildPlan({ secondCommand: 'cd packages/app && pnpm test' }))).not.toThrow();
  });

  it('accepts multi-claim plans for Invoker repos', () => {
    expect(() => parsePlan(buildPlan({ repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git' }))).not.toThrow();
  });

  it('accepts multi-claim plans that do not publish a PR', () => {
    expect(() => parsePlan(buildPlan({ onFinish: 'none', mergeMode: 'manual' }))).not.toThrow();
  });

  it('accepts multi-claim plans for a non-Invoker repo that declares stack publishing', () => {
    expect(() => parsePlan(buildPlan({ publishMode: 'stack' }))).not.toThrow();
  });

  it('rejects multi-claim plans for an Invoker repo that declares single publishing', () => {
    expect(() => parsePlan(buildPlan({
      repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
      publishMode: 'single',
    }))).toThrow(/carries 2 review claims/);
  });

  it('rejects a publishMode that is neither stack nor single', () => {
    expect(() => parsePlan(buildPlan({ publishMode: 'stak' })))
      .toThrow(/field "publishMode" must be "stack" or "single", got "stak"/);
  });
});
