import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const skillDir = join(repoRoot, 'skills', 'route-delegation');
const scriptPath = join(skillDir, 'scripts', 'route-delegation.mjs');

type Router = {
  INVOKER_REQUIRED_TOOLS: string[];
  PUBLISHING_OUTPUTS: Set<string>;
  NON_PUBLISHING_OUTPUTS: Set<string>;
  DELEGATE_HANDOFF_STEPS: string[];
  SUBAGENT_FANOUT_STEPS: string[];
  normalizeWorkKind(workKind: string): string;
  routeExecution(args: { tools: string[]; workKind: string }): string;
  publishes(args: { workKind: string; produces: unknown }): boolean;
  routeDelegation(args: { tools: string[]; workKind: string; produces: unknown }): string;
  handoffStepsFor(route: string): string[];
};

let router: Router;

beforeAll(async () => {
  router = (await import(pathToFileURL(scriptPath).href)) as Router;
});

describe('route-delegation execution table', () => {
  it('stays local when Invoker MCP is missing or partial', () => {
    expect(router.routeExecution({ tools: [], workKind: 'approved_plan' })).toBe('local');
    expect(router.routeExecution({ tools: ['invoker_prepare_plan_review'], workKind: 'durable_parallel' })).toBe('local');
    expect(router.handoffStepsFor('local')).toEqual(['stay_local']);
  });

  it('keeps small and read-only work local even with Invoker', () => {
    for (const workKind of ['small_local', 'readonly']) {
      expect(router.routeExecution({ tools: router.INVOKER_REQUIRED_TOOLS, workKind })).toBe('local');
    }
  });

  it('classifies post-land babysit and named backlog as durable work that delegates', () => {
    for (const workKind of ['post_land_babysit', 'named_execution_backlog']) {
      expect(router.normalizeWorkKind(workKind)).toBe('durable_parallel');
      expect(router.routeExecution({ tools: router.INVOKER_REQUIRED_TOOLS, workKind })).toBe('delegate_invoker');
    }
  });

  it('delegates approved and durable work through the chat-submit handoff', () => {
    for (const workKind of ['approved_plan', 'durable_parallel']) {
      const route = router.routeExecution({ tools: router.INVOKER_REQUIRED_TOOLS, workKind });
      expect(route).toBe('delegate_invoker');
      expect(router.handoffStepsFor(route)).toEqual([
        'plan_to_invoker_yaml',
        'planning_completeness_gate',
        'invoker_prepare_plan_review',
        'one_approval_or_auto_submit',
        'invoker_submit_plan',
        'invoker_cli_wait_then_end_turn',
      ]);
    }
  });
});

describe('route-delegation precedence over subagent fan-out', () => {
  it('never fans out publishing work to subagents', () => {
    for (const output of [...router.PUBLISHING_OUTPUTS].sort()) {
      expect(
        router.routeDelegation({ tools: router.INVOKER_REQUIRED_TOOLS, workKind: 'durable_parallel', produces: [output] }),
      ).toBe('delegate_invoker');
    }
  });

  it('routes the eight-subagent shape (separable, parallel, each unit a PR) to Invoker', () => {
    expect(
      router.routeDelegation({
        tools: router.INVOKER_REQUIRED_TOOLS,
        workKind: 'durable_parallel',
        produces: ['commit', 'pull_request'],
      }),
    ).toBe('delegate_invoker');
  });

  it('keeps publishing work out of a swarm even when Invoker is missing', () => {
    expect(router.routeDelegation({ tools: [], workKind: 'durable_parallel', produces: ['pull_request'] })).toBe('local');
  });

  it('treats approved plans and durable aliases as publishing whatever produces says', () => {
    for (const workKind of ['post_land_babysit', 'named_execution_backlog', 'approved_plan']) {
      expect(router.publishes({ workKind, produces: ['none'] })).toBe(true);
      expect(router.routeDelegation({ tools: router.INVOKER_REQUIRED_TOOLS, workKind, produces: ['none'] })).toBe(
        'delegate_invoker',
      );
    }
  });

  it('lets non-publishing work keep the fan-out default with isolation and transcript checks', () => {
    for (const output of [...router.NON_PUBLISHING_OUTPUTS].sort()) {
      const route = router.routeDelegation({ tools: router.INVOKER_REQUIRED_TOOLS, workKind: 'readonly', produces: [output] });
      expect(route).toBe('subagent_fanout');
      expect(router.handoffStepsFor(route)).toEqual(router.SUBAGENT_FANOUT_STEPS);
    }
    expect(router.SUBAGENT_FANOUT_STEPS).toContain('spawn_worktree_isolated_subagents');
    expect(router.SUBAGENT_FANOUT_STEPS).toContain('grep_transcripts_for_writes');
  });

  it('rejects undeclared, non-array, or unknown outputs instead of defaulting to fan-out', () => {
    const tools = router.INVOKER_REQUIRED_TOOLS;
    expect(() => router.routeDelegation({ tools, workKind: 'durable_parallel', produces: [] })).toThrow(/at least one output/);
    expect(() => router.routeDelegation({ tools, workKind: 'durable_parallel', produces: 'commit' })).toThrow(/array/);
    expect(() => router.routeDelegation({ tools, workKind: 'durable_parallel', produces: ['maybe_a_pr'] })).toThrow(
      /unknown produces/,
    );
  });

  it('rejects unknown work kinds and unknown routes', () => {
    expect(() => router.routeDelegation({ tools: [], workKind: 'whatever', produces: ['none'] })).toThrow(/unknown work_kind/);
    expect(() => router.handoffStepsFor('swarm')).toThrow(/unknown route/);
  });
});

describe('route-delegation CLI', () => {
  it('prints the route and steps as JSON', () => {
    const payload = JSON.stringify({
      tools: ['invoker_prepare_plan_review', 'invoker_submit_plan'],
      work_kind: 'durable_parallel',
      produces: ['commit'],
    });
    const out = JSON.parse(execFileSync(process.execPath, [scriptPath, payload], { encoding: 'utf8' }));
    expect(out.route).toBe('delegate_invoker');
    expect(out.steps).toContain('invoker_submit_plan');
  });

  it('exits non-zero on an undeclared output', () => {
    const payload = JSON.stringify({ tools: [], work_kind: 'durable_parallel', produces: [] });
    const result = spawnSync(process.execPath, [scriptPath, payload], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('at least one output');
  });
});

describe('route-delegation skill contract', () => {
  it('states the rule and points at the handoff skills', () => {
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: route-delegation\n/);
    expect(skill).toContain('what does each unit produce?');
    expect(skill).toContain('never a subagent swarm');
    expect(skill).toContain('skill://chat-submit/SKILL.md');
    expect(skill).toContain('scripts/route-delegation.mjs');
    expect(skill).toContain('invoker-route-delegation');
  });

  it('is reachable from chat-submit', () => {
    const chatSubmit = readFileSync(join(repoRoot, 'skills', 'chat-submit', 'SKILL.md'), 'utf8');
    expect(chatSubmit).toContain('skill://route-delegation/SKILL.md');
  });
});
