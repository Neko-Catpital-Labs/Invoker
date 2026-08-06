import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePlan, parsePlanFile, parsePlanSubmissionBundle, parsePlanSubmissionBundleFile, PlanParseError, detectDefaultBranch, applyPlanDefinitionDefaults, applyConfiguredPlanDefaults, assertNoDuplicateTaskIds } from '../plan-parser.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn(actual.execSync) };
});
import { execFileSync, execSync } from 'node:child_process';

const isolatedConfigPath = join(tmpdir(), `invoker-plan-parser-config-${process.pid}.json`);

beforeEach(() => {
  process.env.INVOKER_REPO_CONFIG_PATH = isolatedConfigPath;
  writeFileSync(isolatedConfigPath, JSON.stringify({ defaultBranch: 'main' }));
});

describe('applyPlanDefinitionDefaults', () => {
  it('pins the workflow baseBranch to master when omitted', () => {
    const plan = applyPlanDefinitionDefaults({
      name: 'My Plan',
      repoUrl: 'git@github.com:test/repo.git',
      tasks: [{ id: 'a', description: 'd', command: 'echo' }],
    });
    expect(plan.onFinish).toBe('pull_request');
    expect(plan.featureBranch).toBe('plan/my-plan');
    expect(plan.baseBranch).toBe('master');
  });

  it('preserves explicit workflow baseBranch values for stacked workflows', () => {
    const plan = applyPlanDefinitionDefaults({
      name: 'X',
      baseBranch: 'upstream/develop',
      featureBranch: 'feat/x',
      onFinish: 'merge',
      tasks: [{ id: 'a', description: 'd', command: 'echo' }],
    });
    expect(plan.baseBranch).toBe('upstream/develop');
    expect(plan.featureBranch).toBe('feat/x');
    expect(plan.onFinish).toBe('merge');
  });

  it('pins blank baseBranch values to master too', () => {
    const empty = applyPlanDefinitionDefaults({
      name: 'Remote PR Plan',
      repoUrl: 'git@github.com:test/repo.git',
      baseBranch: '',
      tasks: [{ id: 'a', description: 'd', command: 'echo' }],
    });
    expect(empty.baseBranch).toBe('master');

    const spaces = applyPlanDefinitionDefaults({
      name: 'Remote PR Plan',
      repoUrl: 'git@github.com:test/repo.git',
      baseBranch: '   ',
      tasks: [{ id: 'a', description: 'd', command: 'echo' }],
    });
    expect(spaces.baseBranch).toBe('master');
  });
});

describe('parsePlan', () => {
  it('rejects a bare repo name before the workflow is created', async () => {
    const planPath = join(tmpdir(), `invoker-invalid-repo-${process.pid}.yaml`);
    writeFileSync(planPath, `
name: Bare Repo
repoUrl: invoker
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello"
`);

    await expect(parsePlanFile(planPath)).rejects.toThrow(
      'repoUrl "invoker" is not a valid git repository',
    );
  });

  it('rejects an unreachable remote during plan file validation', async () => {
    const planPath = join(tmpdir(), `invoker-unreachable-repo-${process.pid}.yaml`);
    writeFileSync(planPath, `
name: Unreachable Repo
repoUrl: https://example.invalid/repo.git
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello"
`);
    const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('unreachable');
    });

    await expect(parsePlanFile(planPath)).rejects.toThrow(
      'repoUrl "https://example.invalid/repo.git" is not a readable git repository',
    );
    execFileSyncSpy.mockRestore();
  });

  it('accepts a file:// checkout URL for the local workspace', async () => {
    vi.restoreAllMocks();
    const { pathToFileURL } = await import('node:url');
    const repoRoot = childProcess.execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    const planPath = join(tmpdir(), `invoker-file-url-repo-${process.pid}.yaml`);
    writeFileSync(planPath, `
name: File URL Repo
repoUrl: ${pathToFileURL(repoRoot).href}
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello"
`);

    const plan = await parsePlanFile(planPath);
    expect(plan.repoUrl).toBe(pathToFileURL(repoRoot).href);
    expect(plan.tasks).toHaveLength(1);
  });

  it('rejects plan without repoUrl', () => {
    const yaml = `
name: No Repo Plan
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a "repoUrl" field');
  });

  it('rejects blank intermediateRepoUrl', () => {
    const yaml = `
name: Blank Intermediate URL
repoUrl: git@github.com:test/repo.git
intermediateRepoUrl: "  "
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello"
`;
    expect(() => parsePlan(yaml)).toThrow('Plan "intermediateRepoUrl" must be a non-empty string');
  });

  it('parses valid YAML plan', () => {
    const yaml = `
name: Hello World Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello, World!"
`;
    const plan = parsePlan(yaml);
    expect(plan.name).toBe('Hello World Test');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe('greet');
    expect(plan.tasks[0].description).toBe('Say hello');
    expect(plan.tasks[0].command).toBe('echo "Hello, World!"');
  });

  it('normalizes optional executionModel values', () => {
    const yaml = `
name: Model Selector Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: explicit
    description: Explicit model
    command: echo explicit
    executionModel: claude
  - id: padded
    description: Padded model
    command: echo padded
    executionModel: "  claude  "
  - id: empty
    description: Empty model
    command: echo empty
    executionModel: "  "
  - id: absent
    description: Absent model
    command: echo absent
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].executionModel).toBe('claude');
    expect(plan.tasks[1].executionModel).toBe('claude');
    expect(plan.tasks[2].executionModel).toBeUndefined();
    expect(plan.tasks[3].executionModel).toBeUndefined();
  });

  it('parses optional intermediateRepoUrl', () => {
    const yaml = `
name: Intermediate Remote Plan
repoUrl: git@github.com:test/repo.git
intermediateRepoUrl: https://github.com/fork/repo.git
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello, World!"
`;
    const plan = parsePlan(yaml);
    expect(plan.intermediateRepoUrl).toBe('https://github.com/fork/repo.git');
  });

  it('parses a Workers Surface stacked workflow bundle in order', () => {
    const yaml = `
name: Workers Surface
repoUrl: git@github.com:test/repo.git
baseBranch: main
onFinish: pull_request
mergeMode: external_review
workflows:
  - name: Workers Surface Contracts
    featureBranch: plan/workers-surface-contracts
    tasks:
      - id: define-worker-contracts
        description: Define worker contracts
        prompt: Update shared contracts for workers
        dependencies: []
      - id: verify-worker-contracts
        description: Verify worker contracts
        command: pnpm test packages/contracts
        dependencies: [define-worker-contracts]
  - name: Workers Surface UI
    featureBranch: plan/workers-surface-ui
    tasks:
      - id: build-workers-ui
        description: Build workers UI
        prompt: Implement the workers surface
        dependencies: []
      - id: verify-workers-ui
        description: Verify workers UI
        command: pnpm test packages/ui
        dependencies: [build-workers-ui]
`;
    const bundle = parsePlanSubmissionBundle(yaml);
    expect(bundle.name).toBe('Workers Surface');
    expect(bundle.isStack).toBe(true);
    expect(bundle.plans.map((plan) => plan.name)).toEqual([
      'Workers Surface Contracts',
      'Workers Surface UI',
    ]);
    expect(bundle.plans[0].repoUrl).toBe('git@github.com:test/repo.git');
    expect(bundle.plans[0].mergeMode).toBe('external_review');
    expect(bundle.plans[0].reviewProvider).toBe('github');
    expect(bundle.plans[0].featureBranch).toBe('plan/workers-surface-contracts');
    expect(bundle.plans[1].featureBranch).toBe('plan/workers-surface-ui');
    expect(bundle.plans[1].tasks.map((task) => task.id)).toEqual([
      'build-workers-ui',
      'verify-workers-ui',
    ]);
  });

  it('parses ci_failed externalDependencies on stack and workflow levels', () => {
    const yaml = `
name: CI Repair Stack
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-stack
    taskId: __merge__
    gatePolicy: ci_failed
workflows:
  - name: Inherited Repair
    tasks:
      - id: inherited
        description: Inherits stack dependency
  - name: Workflow Repair
    externalDependencies:
      - workflowId: wf-workflow
        taskId: __merge__
        gatePolicy: ci_failed
    tasks:
      - id: workflow
        description: Adds workflow dependency
`;
    const bundle = parsePlanSubmissionBundle(yaml);

    expect(bundle.plans[0].externalDependencies).toEqual([
      { workflowId: 'wf-stack', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'ci_failed' },
    ]);
    expect(bundle.plans[1].externalDependencies).toEqual([
      { workflowId: 'wf-stack', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'ci_failed' },
      { workflowId: 'wf-workflow', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'ci_failed' },
    ]);
  });

  it('rejects invalid stacked workflow bundles', () => {
    expect(() => parsePlanSubmissionBundle(`
name: Empty Stack
repoUrl: git@github.com:test/repo.git
workflows: []
`)).toThrow('Plan stack must have a non-empty "workflows" array');

    expect(() => parsePlanSubmissionBundle(`
name: Mixed Stack
repoUrl: git@github.com:test/repo.git
tasks:
  - id: top
    description: Top task
workflows:
  - name: Child
    tasks:
      - id: child
        description: Child task
`)).toThrow('Plan stack must put tasks inside each workflow');

    expect(() => parsePlanSubmissionBundle(`
name: Legacy Stack
repoUrl: git@github.com:test/repo.git
autoFixRetries: 1
workflows:
  - name: Child
    tasks:
      - id: child
        description: Child task
`)).toThrow('Plan stack-level "autoFixRetries" is no longer supported');

    expect(() => parsePlanSubmissionBundle(`
name: Bad Dependencies
repoUrl: git@github.com:test/repo.git
externalDependencies: bad
workflows:
  - name: Child
    tasks:
      - id: child
        description: Child task
`)).toThrow('Plan stack "externalDependencies" must be an array');

    expect(() => parsePlan(`
name: Legacy Parse Entry
repoUrl: git@github.com:test/repo.git
workflows:
  - name: Child
    tasks:
      - id: child
        description: Child task
`)).toThrow('Stacked workflow YAML must be loaded with parsePlanSubmissionBundle()');
  });

  it('parses plan with dependencies', () => {
    const yaml = `
name: Dependency Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: first
    description: First task
    command: echo "first"
  - id: second
    description: Second task
    command: echo "second"
    dependencies: [first]
  - id: third
    description: Third task
    command: echo "third"
    dependencies: [first, second]
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[0].dependencies).toEqual([]);
    expect(plan.tasks[1].dependencies).toEqual(['first']);
    expect(plan.tasks[2].dependencies).toEqual(['first', 'second']);
  });

  it('parses externalDependencies with default requiredStatus', () => {
    const yaml = `
name: External Dependency Plan
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: verify-control-plane-regression
tasks:
  - id: gated
    description: Wait for prior workflow task
    command: echo "go"
`;
    const plan = parsePlan(yaml);
    expect(plan.externalDependencies).toEqual([
      {
        workflowId: 'wf-123',
        taskId: 'verify-control-plane-regression',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready',
      },
    ]);
  });

  it('defaults externalDependencies without taskId to upstream merge gate', () => {
    const yaml = `
name: External Dependency By Workflow
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
tasks:
  - id: gated
    description: Wait for prior workflow merge gate
    command: echo "go"
`;
    const plan = parsePlan(yaml);
    expect(plan.externalDependencies).toEqual([
      { workflowId: 'wf-123', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
    ]);
  });

  it('parses externalDependencies.gatePolicy review_ready', () => {
    const yaml = `
name: External Dependency Review Ready
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: __merge__
    gatePolicy: review_ready
tasks:
  - id: gated
    description: Wait for prior workflow merge gate to be review-ready
    command: echo "go"
`;
    const plan = parsePlan(yaml);
    expect(plan.externalDependencies).toEqual([
      { workflowId: 'wf-123', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
    ]);
  });

  it('parses externalDependencies.gatePolicy ci_failed', () => {
    const yaml = `
name: External Dependency CI Failed
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: __merge__
    gatePolicy: ci_failed
tasks:
  - id: gated
    description: Start repair after upstream PR gate is parked
    command: echo "go"
`;
    const plan = parsePlan(yaml);
    expect(plan.externalDependencies).toEqual([
      { workflowId: 'wf-123', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'ci_failed' },
    ]);
  });

  it('parses top-level externalDependencies onto the workflow only', () => {
    const yaml = `
name: Workflow Chain Step
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: __merge__
tasks:
  - id: root-a
    description: Root A
    command: echo "a"
  - id: root-b
    description: Root B
    command: echo "b"
  - id: child
    description: Child
    command: echo "c"
    dependencies: [root-a]
`;
    const plan = parsePlan(yaml);
    expect(plan.externalDependencies).toEqual([
      { workflowId: 'wf-123', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
    ]);
    expect(plan.tasks[0].externalDependencies).toBeUndefined();
    expect(plan.tasks[1].externalDependencies).toBeUndefined();
    expect(plan.tasks[2].externalDependencies).toBeUndefined();
  });

  it('rejects task-level externalDependencies', () => {
    const yaml = `
name: Task-Level External Dependency
repoUrl: git@github.com:test/repo.git
tasks:
  - id: root
    description: Root
    command: echo "go"
    externalDependencies:
      - workflowId: wf-123
        taskId: __merge__
        gatePolicy: completed
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow(
      'task-level "externalDependencies", which is no longer supported',
    );
  });

  it('rejects invalid top-level externalDependencies.gatePolicy', () => {
    const yaml = `
name: Bad Top-Level External Dependency Gate Policy
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: __merge__
    gatePolicy: whenever
tasks:
  - id: gated
    description: Wait
    command: echo "go"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('"gatePolicy" must be "completed", "review_ready", or "ci_failed"');
  });

  it('rejects invalid externalDependencies.requiredStatus', () => {
    const yaml = `
name: Bad External Dependency Plan
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: verify-control-plane-regression
    requiredStatus: running
tasks:
  - id: gated
    description: Wait
    command: echo "go"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('"requiredStatus" must be "completed"');
  });

  it('rejects invalid externalDependencies.gatePolicy', () => {
    const yaml = `
name: Bad External Dependency Gate Policy
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: __merge__
    gatePolicy: whenever
tasks:
  - id: gated
    description: Wait
    command: echo "go"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('"gatePolicy" must be "completed", "review_ready", or "ci_failed"');
  });

  it('rejects deprecated "approved" gatePolicy value', () => {
    const yaml = `
name: Deprecated Approved Gate Policy
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: __merge__
    gatePolicy: approved
tasks:
  - id: gated
    description: Wait
    command: echo "go"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow("gatePolicy value 'approved' is no longer supported. Use 'completed' instead.");
  });

  it('rejects plan without name', () => {
    const yaml = `
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a "name" field');
  });

  it('rejects plan without tasks', () => {
    const yaml = `
name: Empty Plan
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a non-empty "tasks" array');
  });

  it('rejects plan with empty tasks array', () => {
    const yaml = `
name: Empty Plan
tasks: []
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a non-empty "tasks" array');
  });

  it('rejects task without id', () => {
    const yaml = `
name: Bad Task Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - description: No ID here
    command: echo "oops"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have an "id" field');
  });

  it('rejects task without description', () => {
    const yaml = `
name: Bad Task Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: no-desc
    command: echo "oops"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a "description" field');
  });

  it('rejects plan with duplicate task ids', () => {
    const yaml = `
name: Dup Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: build
    description: First build
    command: echo "one"
  - id: build
    description: Second build
    command: echo "two"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('Duplicate task id "build"');
  });

  it('assertNoDuplicateTaskIds throws for a duplicate task id', () => {
    expect(() => assertNoDuplicateTaskIds([{ id: 'build' }, { id: 'build' }])).toThrow(PlanParseError);
    expect(() => assertNoDuplicateTaskIds([{ id: 'build' }, { id: 'build' }])).toThrow('Duplicate task id "build"');
  });

  it('assertNoDuplicateTaskIds does not throw for unique task ids', () => {
    expect(() => assertNoDuplicateTaskIds([{ id: 'build' }, { id: 'test' }])).not.toThrow();
  });

  it('rejects non-object task entries with a parse error', () => {
    const yaml = `
name: Bad Task Shape Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - null
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('Task at index 0 must be an object with an "id" field');
  });

  it('rejects task commands using npx vitest run', () => {
    const yaml = `
name: Bad Command Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: test-it
    description: "Run tests"
    command: "cd packages/surfaces && npx vitest run"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('npx vitest run');
  });

  it('parses task with prompt instead of command', () => {
    const yaml = `
name: Prompt Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: ask
    description: Ask a question
    prompt: What is the meaning of life?
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].prompt).toBe('What is the meaning of life?');
    expect(plan.tasks[0].command).toBeUndefined();
  });

  it('rejects plan-level autoFix', () => {
    const yaml = `
name: AutoFix Plan Level
repoUrl: git@github.com:test/repo.git
autoFix: true
tasks:
  - id: t1
    description: "Task"
    command: "echo hi"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('Plan-level "autoFix" is no longer supported');
  });

  it('rejects plan-level autoFixRetries', () => {
    const yaml = `
name: AutoFix Retries Plan Level
repoUrl: git@github.com:test/repo.git
autoFixRetries: 3
tasks:
  - id: t1
    description: "Task"
    command: "echo hi"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('Plan-level "autoFixRetries" is no longer supported');
  });

  it('rejects task-level autoFix', () => {
    const yaml = `
name: AutoFix Task Level
repoUrl: git@github.com:test/repo.git
tasks:
  - id: fix-task
    description: "A fixable task"
    command: "npm test"
    autoFix: true
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('uses "autoFix", which is no longer supported');
  });

  it('rejects task-level autoFixRetries', () => {
    const yaml = `
name: AutoFix Retries Task Level
repoUrl: git@github.com:test/repo.git
tasks:
  - id: fix-task
    description: "A fixable task"
    command: "npm test"
    autoFixRetries: 3
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('uses "autoFixRetries", which is no longer supported');
  });

  it('does not project global auto-fix config into parsed plan tasks', async () => {
    const configMod = await import('../config.js');
    const loadConfigSpy = vi.spyOn(configMod, 'loadConfig').mockReturnValue({
      autoFixRetries: 3,
    });

    const yaml = `
name: AutoFix Config Only
repoUrl: git@github.com:test/repo.git
tasks:
  - id: t1
    description: "Task one"
    command: "echo one"
  - id: t2
    description: "Task two"
    command: "echo two"
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].autoFix).toBeUndefined();
    expect(plan.tasks[0].autoFixRetries).toBeUndefined();
    expect(plan.tasks[1].autoFix).toBeUndefined();
    expect(plan.tasks[1].autoFixRetries).toBeUndefined();
    loadConfigSpy.mockRestore();
  });

  it('keeps parsed tasks free of auto-fix fields when global autoFixRetries is 0', async () => {
    const configMod = await import('../config.js');
    const loadConfigSpy = vi.spyOn(configMod, 'loadConfig').mockReturnValue({
      autoFixRetries: 0,
    });

    const yaml = `
name: AutoFix Disabled
repoUrl: git@github.com:test/repo.git
tasks:
  - id: t1
    description: "Task one"
    command: "echo one"
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].autoFix).toBeUndefined();
    expect(plan.tasks[0].autoFixRetries).toBeUndefined();
    loadConfigSpy.mockRestore();
  });

  it('parses executionAgent from task definitions', () => {
    const yaml = `
name: Agent Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: codex-task
    description: "Task using codex"
    command: "npm test"
    executionAgent: codex
  - id: claude-task
    description: "Task using claude"
    prompt: "Fix the bug"
    executionAgent: claude
  - id: default-task
    description: "No agent specified"
    command: "echo hi"
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].executionAgent).toBe('codex');
    expect(plan.tasks[1].executionAgent).toBe('claude');
    expect(plan.tasks[2].executionAgent).toBeUndefined();
  });

  it('trims whitespace from executionAgent and treats empty as undefined', () => {
    const yaml = `
name: Agent Trim Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: padded
    description: "Padded agent"
    command: "echo hi"
    executionAgent: "  codex  "
  - id: empty
    description: "Empty agent"
    command: "echo hi"
    executionAgent: ""
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].executionAgent).toBe('codex');
    expect(plan.tasks[1].executionAgent).toBeUndefined();
  });

  it('applies defaultExecutionAgent from config when agent task omits executionAgent', () => {
    writeFileSync(isolatedConfigPath, JSON.stringify({ defaultBranch: 'main', defaultExecutionAgent: 'codex' }));
    const yaml = `
name: Config Agent Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: default-task
    description: "No agent specified"
    prompt: "Do the thing"
  - id: command-task
    description: "Command-only task"
    command: "echo hi"
  - id: explicit-task
    description: "Explicit agent"
    prompt: "Do the thing"
    executionAgent: claude
`;
    const plan = applyConfiguredPlanDefaults(parsePlan(yaml));
    expect(plan.tasks[0].executionAgent).toBe('codex');
    expect(plan.tasks[1].executionAgent).toBeUndefined();
    expect(plan.tasks[2].executionAgent).toBe('claude');
  });

  it('parses executionModel from task definitions', () => {
    const yaml = `
name: Model Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: claude-task
    description: "Task using claude model"
    command: "npm test"
    executionModel: claude
  - id: default-task
    description: "No model specified"
    command: "echo hi"
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].executionModel).toBe('claude');
    expect(plan.tasks[1].executionModel).toBeUndefined();
  });

  it('trims whitespace from executionModel and treats empty as undefined', () => {
    const yaml = `
name: Model Trim Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: padded
    description: "Padded model"
    command: "echo hi"
    executionModel: "  claude  "
  - id: empty
    description: "Empty model"
    command: "echo hi"
    executionModel: ""
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].executionModel).toBe('claude');
    expect(plan.tasks[1].executionModel).toBeUndefined();
  });

  it('rejects a non-string executionModel with PlanParseError', () => {
    const yaml = `
name: Bad Model Test
repoUrl: git@github.com:test/repo.git
baseBranch: main
tasks:
  - id: t1
    description: "Bad model"
    command: "echo hi"
    executionModel: 123
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow(/executionModel/);
  });

  describe('onFinish parsing', () => {
    it('parses plan with onFinish: merge and preserves explicit baseBranch', () => {
      const yaml = `
name: Merge Plan
repoUrl: git@github.com:test/repo.git
onFinish: merge
baseBranch: upstream/develop
featureBranch: feat/x
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('merge');
      expect(plan.baseBranch).toBe('upstream/develop');
      expect(plan.featureBranch).toBe('feat/x');
    });

    it('parses plan with onFinish: pull_request', () => {
      const yaml = `
name: PR Plan
repoUrl: git@github.com:test/repo.git
onFinish: pull_request
featureBranch: feat/pr
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('pull_request');
    });

    it('defaults onFinish to pull_request when omitted', () => {
      const yaml = `
name: Simple Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('pull_request');
      expect(plan.featureBranch).toBe('plan/simple-plan');
    });

    it('pins baseBranch to master when omitted', async () => {
      const configMod = await import('../config.js');
      const loadConfigSpy = vi.spyOn(configMod, 'loadConfig').mockReturnValue({});

      const yaml = `
name: No Base Branch
repoUrl: git@github.com:test/repo.git
onFinish: merge
featureBranch: feat/x
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.baseBranch).toBe('master');
      loadConfigSpy.mockRestore();
    });

    it('preserves an explicit baseBranch override', () => {
      const yaml = `
name: Explicit Base
repoUrl: git@github.com:test/repo.git
onFinish: merge
baseBranch: origin/release
featureBranch: feat/x
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.baseBranch).toBe('origin/release');
    });

    it('preserves stacked workflow baseBranch with externalDependencies', () => {
      const yaml = `
name: Stacked Child
repoUrl: git@github.com:test/repo.git
onFinish: pull_request
baseBranch: plan/upstream-step
featureBranch: plan/downstream-step
externalDependencies:
  - workflowId: wf-upstream
    taskId: "__merge__"
    requiredStatus: completed
    gatePolicy: review_ready
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.baseBranch).toBe('plan/upstream-step');
      expect(plan.externalDependencies).toEqual([
        {
          workflowId: 'wf-upstream',
          taskId: '__merge__',
          requiredStatus: 'completed',
          gatePolicy: 'review_ready',
        },
      ]);
    });

    it('rejects invalid onFinish value', () => {
      const yaml = `
name: Bad Finish
repoUrl: git@github.com:test/repo.git
onFinish: explode
tasks:
  - id: build
    description: Build the project
`;
      expect(() => parsePlan(yaml)).toThrow(PlanParseError);
      expect(() => parsePlan(yaml)).toThrow(/onFinish/);
    });

    it('auto-generates featureBranch when onFinish is merge without explicit branch', () => {
      const yaml = `
name: Missing Feature Branch
repoUrl: git@github.com:test/repo.git
onFinish: merge
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('merge');
      expect(plan.featureBranch).toBe('plan/missing-feature-branch');
    });

    it('auto-generates featureBranch even when onFinish is none', () => {
      const yaml = `
name: No Finish Branch
repoUrl: git@github.com:test/repo.git
onFinish: none
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('none');
      expect(plan.featureBranch).toBe('plan/no-finish-branch');
    });
  });

  describe('routing field validation', () => {
    it('accepts dockerImage without a routing kind selector', () => {
      const yaml = `
name: Docker Image
repoUrl: git@github.com:test/repo.git
tasks:
  - id: build
    description: Build in Docker
    command: echo build
    dockerImage: node:20
`;
      const plan = parsePlan(yaml);
      expect(plan.tasks[0].dockerImage).toBe('node:20');
    });

    it('accepts poolId without a routing kind selector', () => {
      const yaml = `
name: Pool Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: deploy
    description: Deploy via pool
    command: echo deploy
    poolId: prod-pool
`;
      const plan = parsePlan(yaml);
      expect(plan.tasks[0].poolId).toBe('prod-pool');
    });

    it('rejects top-level legacy routing fields', () => {
      const yaml = `
name: Legacy Routing
repoUrl: git@github.com:test/repo.git
runnerKind: worktree
tasks:
  - id: build
    description: Build
    command: echo build
`;
      expect(() => parsePlan(yaml)).toThrow(PlanParseError);
      expect(() => parsePlan(yaml)).toThrow('unsupported routing field "runnerKind"');
    });

    it('rejects task-level legacy routing fields', () => {
      const yaml = `
name: Legacy Task Routing
repoUrl: git@github.com:test/repo.git
tasks:
  - id: deploy
    description: Deploy
    command: echo deploy
    poolMemberId: prod-server-1
`;
      expect(() => parsePlan(yaml)).toThrow(PlanParseError);
      expect(() => parsePlan(yaml)).toThrow('unsupported routing field "poolMemberId"');
    });
  });

  it('parses description field from plan YAML', () => {
    const yaml = [
      'name: "Test Plan"',
      'repoUrl: "git@github.com:test/repo.git"',
      'description: "This plan adds feature X"',
      'tasks:',
      '  - id: task-1',
      '    description: "Do something"',
      '    command: "echo hello"',
      '    dependencies: []',
    ].join('\n');
    const result = parsePlan(yaml);
    expect(result.description).toBe('This plan adds feature X');
  });

  it('description is optional', () => {
    const yaml = [
      'name: "Test Plan"',
      'repoUrl: "git@github.com:test/repo.git"',
      'tasks:',
      '  - id: task-1',
      '    description: "Do something"',
      '    command: "echo hello"',
      '    dependencies: []',
    ].join('\n');
    const result = parsePlan(yaml);
    expect(result.description).toBeUndefined();
  });

  it('parses visualProof field from plan YAML', () => {
    const yaml = [
      'name: "Test Plan"',
      'repoUrl: "git@github.com:test/repo.git"',
      'description: "Architecture context"',
      'visualProof: true',
      'tasks:',
      '  - id: task-1',
      '    description: "Do something"',
      '    command: "echo hello"',
      '    dependencies: []',
    ].join('\n');
    const result = parsePlan(yaml);
    expect(result.visualProof).toBe(true);
  });

  it('visualProof defaults to undefined when not set', () => {
    const yaml = [
      'name: "Test Plan"',
      'repoUrl: "git@github.com:test/repo.git"',
      'tasks:',
      '  - id: task-1',
      '    description: "Do something"',
      '    command: "echo hello"',
      '    dependencies: []',
    ].join('\n');
    const result = parsePlan(yaml);
    expect(result.visualProof).toBeUndefined();
  });
});

describe('parsePlanSubmissionBundleFile', () => {
  it('parses a stacked workflow bundle from disk and validates every workflow repoUrl', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'invoker-plan-bundle-repo-'));
    execFileSync('git', ['init', '-q', repoDir]);
    const planPath = join(tmpdir(), `invoker-plan-bundle-${process.pid}.yaml`);
    writeFileSync(planPath, `
name: Stack
repoUrl: ${repoDir}
workflows:
  - name: First
    tasks:
      - id: a
        description: A
        command: echo hi
  - name: Second
    tasks:
      - id: b
        description: B
        command: echo hi
`);

    const bundle = await parsePlanSubmissionBundleFile(planPath);

    expect(bundle.isStack).toBe(true);
    expect(bundle.plans.map((plan) => plan.name)).toEqual(['First', 'Second']);
  });

  it('parses a single-plan file the same as parsePlanFile', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'invoker-plan-bundle-single-repo-'));
    execFileSync('git', ['init', '-q', repoDir]);
    const planPath = join(tmpdir(), `invoker-plan-bundle-single-${process.pid}.yaml`);
    writeFileSync(planPath, `
name: Single
repoUrl: ${repoDir}
tasks:
  - id: a
    description: A
    command: echo hi
`);

    const bundle = await parsePlanSubmissionBundleFile(planPath);

    expect(bundle.isStack).toBe(false);
    expect(bundle.plans).toHaveLength(1);
    expect(bundle.plans[0].name).toBe('Single');
  });

  it('rejects a stacked bundle when a workflow repoUrl is not cloneable', async () => {
    const planPath = join(tmpdir(), `invoker-plan-bundle-bad-${process.pid}.yaml`);
    writeFileSync(planPath, `
name: Stack
repoUrl: invoker
workflows:
  - name: First
    tasks:
      - id: a
        description: A
`);

    await expect(parsePlanSubmissionBundleFile(planPath)).rejects.toThrow(
      'repoUrl "invoker" is not a valid git repository',
    );
  });
});

describe('detectDefaultBranch', () => {
  const mockExecSync = vi.mocked(execSync);

  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns branch from git symbolic-ref when available', () => {
    mockExecSync.mockImplementation(((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('symbolic-ref')) {
        return 'refs/remotes/origin/master\n';
      }
      throw new Error('unexpected');
    }) as any);

    expect(detectDefaultBranch()).toBe('master');
  });

  it('falls back to main when symbolic-ref fails but main exists', () => {
    let callCount = 0;
    mockExecSync.mockImplementation(((cmd: string) => {
      callCount++;
      if (typeof cmd === 'string' && cmd.includes('symbolic-ref')) {
        throw new Error('not set');
      }
      if (typeof cmd === 'string' && cmd.includes('rev-parse') && cmd.includes('main')) {
        return 'abc123\n';
      }
      throw new Error('unexpected');
    }) as any);

    expect(detectDefaultBranch()).toBe('main');
    expect(callCount).toBe(2);
  });

  it('falls back to master when both symbolic-ref and main fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(detectDefaultBranch()).toBe('master');
  });
});
