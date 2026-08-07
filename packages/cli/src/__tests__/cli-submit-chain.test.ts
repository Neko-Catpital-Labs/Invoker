import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBus } from '@invoker/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';
import {
  UPSTREAM_WORKFLOW_PLACEHOLDER,
  enforceStrictUpstreamDependencyFields,
  hasTopLevelBaseBranch,
  parseSubmitChainArgs,
  renderUpstreamWorkflowPlaceholder,
  rewriteTopLevelBaseBranch,
  validateStrictUpstreamDependencyFields,
} from '../submit-chain.js';

function captureProcessOutput() {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += chunk.toString();
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += chunk.toString();
    return true;
  });
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

function writePlan(dir: string, fileName: string, text: string): string {
  const path = join(dir, fileName);
  writeFileSync(path, text, 'utf8');
  return path;
}

function firstPlanText(): string {
  return `name: First workflow
repoUrl: .
tasks:
  - id: first
    description: First task
    command: echo first
`;
}

function templatePlanText(): string {
  return `name: Second workflow
repoUrl: .
baseBranch: main
externalDependencies:
  - workflowId: "${UPSTREAM_WORKFLOW_PLACEHOLDER}"
tasks:
  - id: second
    description: Second task
    command: echo second
`;
}

describe('invoker-cli submit-chain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults the gate policy to completed', () => {
    expect(parseSubmitChainArgs(['one.yaml', 'two.yaml'])).toEqual({
      gatePolicy: 'completed',
      planPaths: ['one.yaml', 'two.yaml'],
    });
  });

  it('renders the upstream workflow placeholder', () => {
    const rendered = renderUpstreamWorkflowPlaceholder(
      `externalDependencies:\n  - workflowId: "${UPSTREAM_WORKFLOW_PLACEHOLDER}"\n`,
      'wf-next-1',
    );

    expect(rendered).toContain('workflowId: "wf-next-1"');
    expect(rendered).not.toContain(UPSTREAM_WORKFLOW_PLACEHOLDER);
  });

  it('inserts missing strict upstream dependency fields', () => {
    const rendered = enforceStrictUpstreamDependencyFields(
      `name: Child
externalDependencies:
  - workflowId: "wf-upstream"
tasks: []
`,
      'wf-upstream',
      'review_ready',
    );

    expect(rendered).toContain('  taskId: "__merge__"');
    expect(rendered).toContain('  requiredStatus: completed');
    expect(rendered).toContain('  gatePolicy: review_ready');
    expect(validateStrictUpstreamDependencyFields(rendered, 'wf-upstream', 'review_ready')).toBe(true);
  });

  it('corrects wrong strict upstream dependency fields', () => {
    const rendered = enforceStrictUpstreamDependencyFields(
      `name: Child
externalDependencies:
  - workflowId: "wf-upstream"
    taskId: "build"
    requiredStatus: failed
    gatePolicy: completed
tasks: []
`,
      'wf-upstream',
      'review_ready',
    );

    expect(rendered).toContain('  taskId: "__merge__"');
    expect(rendered).toContain('  requiredStatus: completed');
    expect(rendered).toContain('  gatePolicy: review_ready');
    expect(rendered).not.toContain('requiredStatus: failed');
    expect(validateStrictUpstreamDependencyFields(rendered, 'wf-upstream', 'review_ready')).toBe(true);
  });

  it('detects baseBranch rewrite failures', () => {
    expect(() => rewriteTopLevelBaseBranch('name: Missing base\n', 'feature/wf-1')).toThrow(
      'Rendered plan is missing top-level baseBranch',
    );

    const rendered = rewriteTopLevelBaseBranch('name: Child\nbaseBranch: main\n', 'feature/wf-1');
    expect(hasTopLevelBaseBranch(rendered, 'feature/wf-1')).toBe(true);
    expect(hasTopLevelBaseBranch(rendered, 'main')).toBe(false);
  });

  it('rejects bogus gate policies with a usage error', async () => {
    const output = captureProcessOutput();

    const code = await main(['submit-chain', '--gate-policy', 'bogus', 'one.yaml', 'two.yaml']);

    expect(code).toBe(1);
    expect(output.stderr).toContain('Invalid --gate-policy value: bogus');
    expect(output.stderr).toContain('Usage: invoker-cli submit-chain');
    output.restore();
  });

  it('rejects a second plan missing the placeholder and names the file', async () => {
    const output = captureProcessOutput();
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-submit-chain-missing-'));
    const first = writePlan(dir, 'first.yaml', firstPlanText());
    const second = writePlan(dir, 'second.yaml', templatePlanText().replace(UPSTREAM_WORKFLOW_PLACEHOLDER, 'wf-other'));

    const code = await main(['submit-chain', first, second], { createMessageBus: () => new LocalBus() });

    expect(code).toBe(1);
    expect(output.stderr).toContain(`Template plan is missing ${UPSTREAM_WORKFLOW_PLACEHOLDER}: ${second}`);
    output.restore();
  });

  it('requires a live owner before rendering valid chains', async () => {
    const output = captureProcessOutput();
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-submit-chain-no-owner-'));
    const first = writePlan(dir, 'first.yaml', firstPlanText());
    const second = writePlan(dir, 'second.yaml', templatePlanText());

    const code = await main(['submit-chain', first, second], { createMessageBus: () => new LocalBus() });

    expect(code).toBe(1);
    expect(output.stderr).toContain('No running Invoker owner is reachable');
    expect(output.stderr).toContain('invoker-cli owner serve');
    expect(output.stdout).not.toContain('Submitting workflow');
    expect(output.stdout).not.toContain('RENDERED_PLAN=');
    output.restore();
  });

  it('submits through the live-owner path in order and renders the downstream temp plan', async () => {
    const output = captureProcessOutput();
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-submit-chain-live-'));
    const first = writePlan(dir, 'first.yaml', firstPlanText());
    const second = writePlan(dir, 'second.yaml', templatePlanText());
    const bus = new LocalBus();
    const submittedPaths: string[] = [];
    let runCount = 0;

    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.run', async (request: unknown) => {
      const payload = request as { planPath: string; noTrack?: boolean };
      expect(payload.noTrack).toBe(true);
      submittedPaths.push(payload.planPath);
      runCount += 1;
      return { workflowId: runCount === 1 ? 'wf-first' : 'wf-second', tasks: [] };
    });
    bus.onRequest('headless.query', async (request: unknown) => {
      const args = (request as { args: string[] }).args;
      if (args[1] === 'tasks') {
        return { output: JSON.stringify([{ id: '__merge__wf-first' }]) };
      }
      const workflows = [
        {
          id: 'wf-first',
          name: 'First workflow',
          createdAt: '2026-01-01T00:00:00.000Z',
          baseBranch: 'main',
          featureBranch: 'feature/wf-first',
        },
        ...(runCount >= 2 ? [{
          id: 'wf-second',
          name: 'Second workflow',
          createdAt: '2026-01-01T00:01:00.000Z',
          baseBranch: 'feature/wf-first',
          featureBranch: 'feature/wf-second',
        }] : []),
      ];
      return { output: `${JSON.stringify(workflows)}\n` };
    });

    const code = await main(['submit-chain', '--gate-policy', 'review_ready', first, second], {
      createMessageBus: () => bus,
    });

    expect(code).toBe(0);
    expect(submittedPaths[0]).toBe(first);
    expect(submittedPaths[1]).toContain(tmpdir());
    const rendered = readFileSync(submittedPaths[1]!, 'utf8');
    expect(rendered).toContain('workflowId: "wf-first"');
    expect(rendered).toContain('taskId: "__merge__"');
    expect(rendered).toContain('requiredStatus: completed');
    expect(rendered).toContain('gatePolicy: review_ready');
    expect(rendered).toContain('baseBranch: feature/wf-first');
    expect(output.stdout).toContain('GATE_POLICY=review_ready');
    expect(output.stdout).toContain('WF1=wf-first base=main feature=feature/wf-first');
    expect(output.stdout).toContain('WF2=wf-second base=feature/wf-first feature=feature/wf-second');
    expect(output.stdout).toContain(`RENDERED_PLAN=${submittedPaths[1]}`);
    output.restore();
  });
});
