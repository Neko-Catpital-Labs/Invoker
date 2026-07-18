#!/usr/bin/env node
/**
 * Typed plan validator — parses YAML structurally and validates against plan-parser.ts constraints.
 * Outputs deterministic JSON diagnostics and exits non-zero on any validation failure.
 *
 * Usage: node validate-plan.ts <plan.yaml>
 * Output: JSON array of errors (stable keys: errorType, field, taskId, message, value)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RawPlan, RawPlanTask, RawExperimentVariant } from '../../../packages/app/src/plan-parser.js';

interface ValidationError {
  errorType: string;
  field: string;
  taskId?: string;
  message: string;
  value?: unknown;
}

const VALID_ON_FINISH = ['none', 'merge', 'pull_request'] as const;
const VALID_MERGE_MODE = ['manual', 'automatic', 'external_review'] as const;
const VALID_REQUIRED_STATUS = ['completed', 'review_ready'] as const;
const VALID_GATE_POLICY = ['completed', 'review_ready'] as const;

type ExternalDep = { workflowId?: string; taskId?: string; requiredStatus?: string; gatePolicy?: string };

const NESTED_SHELL_INVOCATION = /\b(?:sh|bash)\s+-(?:c|lc)\b/g;
const SHELL_VARIABLE_REFERENCE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/;
const EXPLICIT_BASH_COMMAND = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*bash\s+-(?:lc|cl|c)\b/;

function hasUnsafeNestedShellVariableExpansion(command: string): boolean {
  NESTED_SHELL_INVOCATION.lastIndex = 0;

  for (let match = NESTED_SHELL_INVOCATION.exec(command); match !== null; match = NESTED_SHELL_INVOCATION.exec(command)) {
    const nestedCommand = extractNestedShellCommand(command, match.index + match[0].length);
    if (nestedCommand !== null && SHELL_VARIABLE_REFERENCE.test(nestedCommand)) {
      return true;
    }
  }

  return false;
}

function usesPipefailSetCommand(command: string): boolean {
  return command
    .split(/[;&|()\n]/)
    .some((segment) => /^\s*set\s+/.test(segment) && /\bpipefail\b/.test(segment));
}

function isExplicitBashCommand(command: string): boolean {
  return EXPLICIT_BASH_COMMAND.test(command);
}

/** True when a command invokes pnpm for anything other than bootstrap alone. */
function commandUsesPnpm(command: string): boolean {
  return /\bpnpm\b/.test(command);
}

/**
 * Managed worktrees do not auto-install deps. Any pnpm command task must start
 * with an explicit `pnpm install` (usually `--frozen-lockfile`) so the checkout
 * has node_modules before later pnpm steps run.
 */
function commandHasLeadingPnpmInstall(command: string): boolean {
  const body = command.replace(/^\uFEFF/, '').trim();
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  if (!firstLine) return false;
  const firstCommand = firstLine.split('&&')[0]?.trim() ?? '';
  return /^pnpm\s+install\b/.test(firstCommand);
}

function findRepoRoot(startDir: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return resolve(startDir, '../../..');
  }
}

const PATH_BOUNDARY = String.raw`[\s\`"'()[\]{}<>:;,;&|=]`;
const REPO_ROOT_PATH_PREFIX = String.raw`(?:\.\/|\$PWD\/|\$\{PWD\}\/|\$\(pwd\)\/)?`;
const REPO_PATH_BODY = String.raw`(?:packages|scripts|skills|docs|plans|\.github)\/[A-Za-z0-9_./@+-]+`;
const COMMAND_SCRIPT_BODY = String.raw`(?:${REPO_PATH_BODY}|[A-Za-z0-9_./@+-]+)\.sh`;
const REPO_RELATIVE_PATH_REFERENCE = new RegExp(`(?:^|${PATH_BOUNDARY})${REPO_ROOT_PATH_PREFIX}(${REPO_PATH_BODY})(?=$|${PATH_BOUNDARY})`, 'g');
const COMMAND_REQUIRED_FILE_REFERENCE = new RegExp(`(?:^|${PATH_BOUNDARY})${REPO_ROOT_PATH_PREFIX}(${COMMAND_SCRIPT_BODY})(?=$|${PATH_BOUNDARY})`, 'g');
const PARENT_DIRECTORY_PATH_REFERENCE = new RegExp(`(?:^|${PATH_BOUNDARY})((?:${REPO_ROOT_PATH_PREFIX})(?:[A-Za-z0-9_@+.-]+\\/|\\.\\/|\\.\\.\\/)*\\.\\.(?:\\/|$)(?:[A-Za-z0-9_./@+-]+)?)(?=$|${PATH_BOUNDARY})`, 'g');

function stripRepoRootPathPrefix(rawPath: string): string {
  return rawPath.replace(/^(?:\.\/|\$PWD\/|\$\{PWD\}\/|\$\(pwd\)\/)/, '');
}

function hasParentDirectorySegment(rawPath: string): boolean {
  return stripRepoRootPathPrefix(rawPath).split('/').includes('..');
}

function isUnsupportedParentDirectoryReference(rawPath: string): boolean {
  const repoPath = stripRepoRootPathPrefix(rawPath);
  const segments = repoPath.split('/').filter(Boolean);
  return (
    segments.includes('..')
    && (
      segments.some((segment) => ['packages', 'scripts', 'skills', 'docs', 'plans', '.github'].includes(segment))
      || repoPath.endsWith('.sh')
    )
  );
}

function normalizedRepoPath(rawPath: string): string | null {
  const repoPath = stripRepoRootPathPrefix(rawPath);
  const normalizedPath = normalize(repoPath);
  if (
    hasParentDirectorySegment(rawPath)
    || normalizedPath.startsWith('/')
    || normalizedPath.endsWith('/')
  ) {
    return null;
  }

  return normalizedPath;
}

function referencedPathTokens(text: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  const paths = new Set<string>();

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const rawPath = match[1];
    if (!rawPath) continue;
    paths.add(rawPath);
  }

  return [...paths];
}

function referencedRepoPaths(text: string, pattern = REPO_RELATIVE_PATH_REFERENCE): string[] {
  const paths = new Set<string>();

  for (const rawPath of referencedPathTokens(text, pattern)) {
    const normalizedPath = normalizedRepoPath(rawPath);
    if (normalizedPath === null) continue;
    paths.add(normalizedPath);
  }

  return [...paths];
}

function isCommittedInHead(repoRoot: string, relativePath: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${relativePath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function pushFileNotInRemoteError(
  errors: ValidationError[],
  taskId: string | undefined,
  field: string,
  path: string,
  value: string,
): void {
  errors.push({
    errorType: 'local_only_file_reference',
    field,
    ...(taskId ? { taskId } : {}),
    message: `${taskId ? `Task "${taskId}"` : 'Plan'} references "${path}", but that file is not checked into the remote branch this plan will run on. Commit and push it before submission, or replace the reference with a checked-in file.`,
    value,
  });
}

function pushUnsupportedRelativePathError(
  errors: ValidationError[],
  taskId: string | undefined,
  field: string,
  path: string,
  value: string,
): void {
  errors.push({
    errorType: 'unsupported_relative_file_reference',
    field,
    ...(taskId ? { taskId } : {}),
    message: `${taskId ? `Task "${taskId}"` : 'Plan'} uses "${path}", but Invoker plans must use repo-relative paths checked into the remote branch. Replace it with a path like "scripts/..." or remove the parent-directory traversal.`,
    value,
  });
}

function validateUnsupportedRelativePathReferences(
  errors: ValidationError[],
  taskId: string | undefined,
  field: string,
  value: string,
): void {
  for (const relativePath of referencedPathTokens(value, PARENT_DIRECTORY_PATH_REFERENCE)) {
    if (!isUnsupportedParentDirectoryReference(relativePath)) continue;
    pushUnsupportedRelativePathError(errors, taskId, field, relativePath, value);
  }
}

function validateLocalOnlyFileReferences(
  errors: ValidationError[],
  taskId: string | undefined,
  field: string,
  value: string,
  repoRoot: string,
): void {
  for (const referencedPath of referencedRepoPaths(value)) {
    if (!existsSync(join(repoRoot, referencedPath))) continue;

    if (!isCommittedInHead(repoRoot, referencedPath)) {
      pushFileNotInRemoteError(errors, taskId, field, referencedPath, value);
    }
  }
}

function validatePlanFileReferences(
  errors: ValidationError[],
  taskId: string | undefined,
  field: string,
  value: string,
  repoRoot: string,
): void {
  validateUnsupportedRelativePathReferences(errors, taskId, field, value);
  validateLocalOnlyFileReferences(errors, taskId, field, value, repoRoot);
}

function validateRequiredCommandFiles(
  errors: ValidationError[],
  taskId: string,
  field: string,
  command: string,
  repoRoot: string,
): void {
  const repoReferences = new Set(referencedRepoPaths(command));
  for (const scriptPath of referencedRepoPaths(command, COMMAND_REQUIRED_FILE_REFERENCE)) {
    const absolutePath = join(repoRoot, scriptPath);
    const existsInWorktree = existsSync(absolutePath);
    const existsInHead = isCommittedInHead(repoRoot, scriptPath);

    if (existsInWorktree && !existsInHead) {
      if (!repoReferences.has(scriptPath)) {
        pushFileNotInRemoteError(errors, taskId, field, scriptPath, command);
      }
      continue;
    }

    if (!existsInWorktree && !existsInHead) {
      errors.push({
        errorType: 'missing_file_reference',
        field,
        taskId,
        message: `Task "${taskId}" references "${scriptPath}", but that file is not checked into the remote branch this plan will run on. Commit and push it before submission, or replace the reference with a checked-in file.`,
        value: command,
      });
    }
  }
}

function extractNestedShellCommand(command: string, startIndex: number): string | null {
  let index = startIndex;
  while (index < command.length && /\s/.test(command[index])) {
    index += 1;
  }

  const quote = command[index];
  if (quote !== '"' && quote !== "'") {
    return null;
  }

  let nestedCommand = '';
  index += 1;

  for (; index < command.length; index += 1) {
    const char = command[index];
    if (char === quote && !hasOddBackslashRun(command, index)) {
      return nestedCommand;
    }
    nestedCommand += char;
  }

  return nestedCommand;
}

function hasOddBackslashRun(value: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function pushUnsafeCommandError(
  errors: ValidationError[],
  taskId: string,
  field: string,
  command: string,
): void {
  errors.push({
    errorType: 'unsafe_shell_variable_expansion',
    field,
    taskId,
    message: `Task "${taskId}" uses a nested shell command with shell variable references. Avoid sh -c/bash -c quoting with variables in plan command fields; use a direct command or literal smoke command instead.`,
    value: command,
  });
}

function pushNonPortablePipefailError(
  errors: ValidationError[],
  taskId: string,
  field: string,
  command: string,
): void {
  errors.push({
    errorType: 'non_portable_pipefail',
    field,
    taskId,
    message: `Task "${taskId}" uses bash-only pipefail without explicitly running the command through bash. Use bash -lc 'set -euo pipefail; ...' or write POSIX-compatible shell for Invoker command tasks.`,
    value: command,
  });
}

/**
 * Validate a single externalDependencies array (reused for both plan-level and task-level).
 * @param deps - The array to validate
 * @param fieldPrefix - e.g. "externalDependencies" or "tasks[0].externalDependencies"
 * @param taskId - optional task ID for task-level deps
 */
function validateExternalDeps(
  deps: unknown,
  fieldPrefix: string,
  errors: ValidationError[],
  taskId?: string,
): void {
  if (!Array.isArray(deps)) {
    errors.push({
      errorType: 'invalid_field_type',
      field: fieldPrefix,
      ...(taskId ? { taskId } : {}),
      message: `${taskId ? `Task "${taskId}" ` : ''}externalDependencies must be an array`,
      value: deps,
    });
    return;
  }
  deps.forEach((dep: ExternalDep, depIndex: number) => {
    if (!dep.workflowId || typeof dep.workflowId !== 'string') {
      errors.push({
        errorType: 'missing_required_field',
        field: `${fieldPrefix}[${depIndex}].workflowId`,
        ...(taskId ? { taskId } : {}),
        message: `${taskId ? `Task "${taskId}" ` : ''}externalDependencies[${depIndex}] must have a string "workflowId"`,
        value: dep.workflowId,
      });
    }

    if (dep.taskId !== undefined && typeof dep.taskId !== 'string') {
      errors.push({
        errorType: 'invalid_field_type',
        field: `${fieldPrefix}[${depIndex}].taskId`,
        ...(taskId ? { taskId } : {}),
        message: `${taskId ? `Task "${taskId}" ` : ''}externalDependencies[${depIndex}] "taskId" must be a string when provided`,
        value: dep.taskId,
      });
    }

    if (dep.requiredStatus !== undefined && !VALID_REQUIRED_STATUS.includes(dep.requiredStatus as any)) {
      errors.push({
        errorType: 'invalid_enum_value',
        field: `${fieldPrefix}[${depIndex}].requiredStatus`,
        ...(taskId ? { taskId } : {}),
        message: `${taskId ? `Task "${taskId}" ` : ''}externalDependencies[${depIndex}] "requiredStatus" must be "completed" or "review_ready"`,
        value: dep.requiredStatus,
      });
    }

    if (dep.gatePolicy !== undefined && !VALID_GATE_POLICY.includes(dep.gatePolicy as any)) {
      errors.push({
        errorType: 'invalid_enum_value',
        field: `${fieldPrefix}[${depIndex}].gatePolicy`,
        ...(taskId ? { taskId } : {}),
        message: `${taskId ? `Task "${taskId}" ` : ''}externalDependencies[${depIndex}] "gatePolicy" must be "completed" or "review_ready"`,
        value: dep.gatePolicy,
      });
    }
  });
}

function validateReviewGate(reviewGate: unknown, errors: ValidationError[]): void {
  if (!reviewGate || typeof reviewGate !== 'object' || Array.isArray(reviewGate)) {
    errors.push({
      errorType: 'invalid_field_type',
      field: 'reviewGate',
      message: 'reviewGate must be an object',
      value: reviewGate,
    });
    return;
  }

  const artifacts = (reviewGate as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) {
    errors.push({
      errorType: 'invalid_field_type',
      field: 'reviewGate.artifacts',
      message: 'reviewGate.artifacts must be an array',
      value: artifacts,
    });
    return;
  }

  const ids = new Set<string>();
  const normalizedArtifacts: Array<{ id: string; dependsOn: string[]; sourceIndex: number }> = [];
  artifacts.forEach((artifact, index) => {
    const field = `reviewGate.artifacts[${index}]`;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      errors.push({
        errorType: 'invalid_field_type',
        field,
        message: `${field} must be an object`,
        value: artifact,
      });
      return;
    }
    const record = artifact as { id?: unknown; required?: unknown; dependsOn?: unknown };
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      errors.push({
        errorType: 'missing_required_field',
        field: `${field}.id`,
        message: `${field}.id must be a non-empty string`,
        value: record.id,
      });
      return;
    }
    if (ids.has(record.id)) {
      errors.push({
        errorType: 'duplicate_id',
        field: `${field}.id`,
        message: `${field}.id duplicates artifact "${record.id}"`,
        value: record.id,
      });
      return;
    }
    ids.add(record.id);
    if (record.required === undefined) {
      record.required = true;
    } else if (typeof record.required !== 'boolean') {
      errors.push({
        errorType: 'invalid_field_type',
        field: `${field}.required`,
        message: `${field}.required must be a boolean when provided`,
        value: record.required,
      });
    }
    if (record.dependsOn !== undefined && !Array.isArray(record.dependsOn)) {
      errors.push({
        errorType: 'invalid_field_type',
        field: `${field}.dependsOn`,
        message: `${field}.dependsOn must be an array`,
        value: record.dependsOn,
      });
      return;
    }
    const dependsOn = (record.dependsOn ?? []) as unknown[];
    const normalizedDependsOn: string[] = [];
    for (const dependency of dependsOn) {
      if (typeof dependency !== 'string' || dependency.trim() === '') {
        errors.push({
          errorType: 'invalid_field_type',
          field: `${field}.dependsOn`,
          message: `${field}.dependsOn must contain non-empty artifact ids`,
          value: dependency,
        });
        return;
      }
      normalizedDependsOn.push(dependency);
    }
    normalizedArtifacts.push({ id: record.id, dependsOn: normalizedDependsOn, sourceIndex: index });
  });

  normalizedArtifacts.forEach((artifact, index) => {
    const field = `reviewGate.artifacts[${artifact.sourceIndex}].dependsOn`;
    for (const dependency of artifact.dependsOn) {
      if (!ids.has(dependency)) {
        errors.push({
          errorType: 'invalid_dependency_reference',
          field,
          message: `${field} references unknown artifact "${dependency}"`,
          value: dependency,
        });
      } else if (dependency === artifact.id) {
        errors.push({
          errorType: 'invalid_dependency_reference',
          field,
          message: `${field} must not reference artifact "${artifact.id}" itself`,
          value: dependency,
        });
      }
    }
  });

  normalizedArtifacts.forEach((artifact, index) => {
    const field = `reviewGate.artifacts[${artifact.sourceIndex}].dependsOn`;
    if (index === 0) {
      if (artifact.dependsOn.length > 0) {
        errors.push({
          errorType: 'invalid_dependency_reference',
          field,
          message: `${field} must be omitted or [] for the first review-gate artifact`,
          value: artifact.dependsOn,
        });
      }
      return;
    }
    const expectedDependency = normalizedArtifacts[index - 1]?.id;
    if (artifact.dependsOn.length !== 1 || artifact.dependsOn[0] !== expectedDependency) {
      errors.push({
        errorType: 'invalid_dependency_reference',
        field,
        message: `${field} must be ["${expectedDependency}"] to keep the review-gate stack linear`,
        value: artifact.dependsOn,
      });
    }
  });
}

function validatePlan(yamlContent: string, repoRoot: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Parse YAML
  let raw: RawPlan;
  try {
    const parsed = parseYaml(yamlContent);
    if (!parsed || typeof parsed !== 'object') {
      errors.push({
        errorType: 'invalid_yaml',
        field: 'root',
        message: 'Plan must be a YAML object',
      });
      return errors;
    }
    raw = parsed as RawPlan;
  } catch (e) {
    errors.push({
      errorType: 'yaml_parse_error',
      field: 'root',
      message: e instanceof Error ? e.message : String(e),
    });
    return errors;
  }

  // Validate required top-level fields
  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    errors.push({
      errorType: 'missing_required_field',
      field: 'name',
      message: 'Plan must have a non-empty "name" field',
      value: raw.name,
    });
  }

  if (!raw.repoUrl || typeof raw.repoUrl !== 'string' || raw.repoUrl.trim() === '') {
    errors.push({
      errorType: 'missing_required_field',
      field: 'repoUrl',
      message: 'Plan must have a "repoUrl" field (e.g. repoUrl: git@github.com:user/repo.git)',
      value: raw.repoUrl,
    });
  }

  if (!raw.tasks || !Array.isArray(raw.tasks)) {
    errors.push({
      errorType: 'missing_required_field',
      field: 'tasks',
      message: 'Plan must have a "tasks" array',
      value: raw.tasks,
    });
    return errors; // Can't validate tasks if array doesn't exist
  }

  if (raw.tasks.length === 0) {
    errors.push({
      errorType: 'empty_required_field',
      field: 'tasks',
      message: 'Plan must have a non-empty "tasks" array',
    });
    return errors;
  }

  // Validate enum fields
  if (raw.onFinish !== undefined && !VALID_ON_FINISH.includes(raw.onFinish as any)) {
    errors.push({
      errorType: 'invalid_enum_value',
      field: 'onFinish',
      message: `"onFinish" must be one of: ${VALID_ON_FINISH.join(', ')}`,
      value: raw.onFinish,
    });
  }

  if (typeof raw.description === 'string') {
    validatePlanFileReferences(errors, undefined, 'description', raw.description, repoRoot);
  }

  if (raw.mergeMode !== undefined && !VALID_MERGE_MODE.includes(raw.mergeMode as any)) {
    errors.push({
      errorType: 'invalid_enum_value',
      field: 'mergeMode',
      message: `"mergeMode" must be one of: ${VALID_MERGE_MODE.join(', ')}`,
      value: raw.mergeMode,
    });
  }

  if (raw.runnerKind !== undefined) {
    errors.push({
      errorType: 'unsupported_field',
      field: 'runnerKind',
      message: '"runnerKind" is no longer supported. Omit it for the default worktree executor, use "poolId" for configured execution pools, or use "dockerImage" for Docker tasks.',
      value: raw.runnerKind,
    });
  }

  // Validate description required when onFinish is pull_request or merge
  const onFinish = raw.onFinish ?? 'pull_request';
  if ((onFinish === 'pull_request' || onFinish === 'merge') &&
      (!raw.description || raw.description.trim() === '')) {
    errors.push({
      errorType: 'missing_required_field',
      field: 'description',
      message: `Missing 'description' field. Required when onFinish is '${onFinish}'. Add 1-3 paragraphs: architecture, motivations, tradeoffs.`,
      value: raw.description,
    });
  }

  // Validate plan-level externalDependencies structure
  if (raw.externalDependencies) {
    validateExternalDeps(raw.externalDependencies, 'externalDependencies', errors);
  }
  if ((raw as RawPlan & { reviewGate?: unknown }).reviewGate !== undefined) {
    validateReviewGate((raw as RawPlan & { reviewGate?: unknown }).reviewGate, errors);
  }

  // Collect all externalDependencies (plan-level + task-level) for cross-checks
  const allExtDeps: ExternalDep[] = [];
  if (Array.isArray(raw.externalDependencies)) {
    allExtDeps.push(...raw.externalDependencies);
  }
  if (Array.isArray(raw.tasks)) {
    for (const task of raw.tasks) {
      if (Array.isArray(task.externalDependencies)) {
        allExtDeps.push(...task.externalDependencies);
      }
    }
  }

  // Check for unrendered template placeholders
  const hasUnrenderedTemplate = allExtDeps.some(
    (dep) => dep.workflowId === '__UPSTREAM_WORKFLOW_ID__',
  );
  if (hasUnrenderedTemplate) {
    errors.push({
      errorType: 'unrendered_template_placeholder',
      field: 'externalDependencies',
      message: "Plan contains unrendered template placeholder '__UPSTREAM_WORKFLOW_ID__'. Use submit-workflow-chain.sh or replace with a concrete workflow ID.",
    });
  }

  // Check for stacked baseBranch defaulting to master
  const hasConcreteExtDep = allExtDeps.some(
    (dep) => dep.workflowId && dep.workflowId !== '__UPSTREAM_WORKFLOW_ID__',
  );
  const baseBranch = raw.baseBranch ?? 'master';
  if (hasConcreteExtDep && baseBranch === 'master') {
    errors.push({
      errorType: 'stacked_basebranch_default',
      field: 'baseBranch',
      message: "Plan has externalDependencies but baseBranch is 'master'. For stacked workflows, set baseBranch to the upstream workflow's featureBranch, or use step-submit-stacked to auto-resolve.",
    });
  }

  // Collect task IDs for dependency validation
  const taskIds = new Set<string>();

  // Validate tasks
  raw.tasks.forEach((task: RawPlanTask, index: number) => {
    if (!task.id || typeof task.id !== 'string' || task.id.trim() === '') {
      errors.push({
        errorType: 'missing_required_field',
        field: 'id',
        message: `Task at index ${index} must have a non-empty "id" field`,
        value: task.id,
      });
      return; // Skip further validation for this task
    }

    const taskId = task.id;
    taskIds.add(taskId);

    if (!task.description || typeof task.description !== 'string' || task.description.trim() === '') {
      errors.push({
        errorType: 'missing_required_field',
        field: 'description',
        taskId,
        message: `Task "${taskId}" must have a non-empty "description" field`,
        value: task.description,
      });
    }

    if (typeof task.description === 'string') {
      validatePlanFileReferences(errors, taskId, 'description', task.description, repoRoot);
    }

    if (typeof task.prompt === 'string') {
      validatePlanFileReferences(errors, taskId, 'prompt', task.prompt, repoRoot);
    }

    if (typeof task.command === 'string') {
      validatePlanFileReferences(errors, taskId, 'command', task.command, repoRoot);
      validateRequiredCommandFiles(errors, taskId, 'command', task.command, repoRoot);
    }

    // Validate command/prompt exclusivity
    const hasCommand = task.command !== undefined && task.command !== null;
    const hasPrompt = task.prompt !== undefined && task.prompt !== null;

    if (!hasCommand && !hasPrompt) {
      errors.push({
        errorType: 'missing_command_or_prompt',
        field: 'command|prompt',
        taskId,
        message: `Task "${taskId}" must define either "command" or "prompt"`,
      });
    }

    if (hasCommand && hasPrompt) {
      errors.push({
        errorType: 'command_prompt_exclusive',
        field: 'command|prompt',
        taskId,
        message: `Task "${taskId}" cannot define both "command" and "prompt" — choose one`,
      });
    }

    // Validate banned patterns
    if (task.command && /\bnpx vitest run\b/.test(task.command)) {
      errors.push({
        errorType: 'banned_pattern',
        field: 'command',
        taskId,
        message: `Task "${taskId}" uses 'npx vitest run' which may not resolve correctly. Use a repo-supported script or explicit package-local command instead.`,
        value: task.command,
      });
    }

    if (
      typeof task.command === 'string'
      && commandUsesPnpm(task.command)
      && !commandHasLeadingPnpmInstall(task.command)
    ) {
      errors.push({
        errorType: 'banned_pattern',
        field: 'command',
        taskId,
        message: `Task "${taskId}" runs pnpm without a leading pnpm install. Prepend \`pnpm install --frozen-lockfile\` (managed worktrees do not auto-provision node_modules).`,
        value: task.command,
      });
    }

    if (typeof task.command === 'string' && hasUnsafeNestedShellVariableExpansion(task.command)) {
      pushUnsafeCommandError(errors, taskId, 'command', task.command);
    }

    if (typeof task.command === 'string' && usesPipefailSetCommand(task.command) && !isExplicitBashCommand(task.command)) {
      pushNonPortablePipefailError(errors, taskId, 'command', task.command);
    }

    // Validate obsolete executor routing fields.
    if (task.runnerKind !== undefined) {
      errors.push({
        errorType: 'unsupported_field',
        field: 'runnerKind',
        taskId,
        message: `Task "${taskId}" uses unsupported "runnerKind". Omit it for the default worktree executor, use "poolId" for configured execution pools, or use "dockerImage" for Docker tasks.`,
        value: task.runnerKind,
      });
    }

    if (task.poolId !== undefined && typeof task.poolId !== 'string') {
      errors.push({
        errorType: 'invalid_field_type',
        field: 'poolId',
        taskId,
        message: `Task "${taskId}" poolId must be a string when provided`,
        value: task.poolId,
      });
    }

    // Validate externalDependencies
    if (task.externalDependencies) {
      validateExternalDeps(task.externalDependencies, 'externalDependencies', errors, taskId);
    }

    // Validate experimentVariants
    if (task.experimentVariants) {
      if (!Array.isArray(task.experimentVariants)) {
        errors.push({
          errorType: 'invalid_field_type',
          field: 'experimentVariants',
          taskId,
          message: `Task "${taskId}" experimentVariants must be an array`,
          value: task.experimentVariants,
        });
      } else {
        task.experimentVariants.forEach((variant: RawExperimentVariant, varIndex: number) => {
          const hasVarCommand = variant.command !== undefined && variant.command !== null;
          const hasVarPrompt = variant.prompt !== undefined && variant.prompt !== null;

          if (!hasVarCommand && !hasVarPrompt) {
            errors.push({
              errorType: 'missing_command_or_prompt',
              field: `experimentVariants[${varIndex}].command|prompt`,
              taskId,
              message: `Task "${taskId}" experimentVariants[${varIndex}] must define either "command" or "prompt"`,
            });
          }

          if (hasVarCommand && hasVarPrompt) {
            errors.push({
              errorType: 'command_prompt_exclusive',
              field: `experimentVariants[${varIndex}].command|prompt`,
              taskId,
              message: `Task "${taskId}" experimentVariants[${varIndex}] cannot define both "command" and "prompt"`,
            });
          }

          if (typeof variant.description === 'string') {
            validatePlanFileReferences(errors, taskId, `experimentVariants[${varIndex}].description`, variant.description, repoRoot);
          }

          if (typeof variant.prompt === 'string') {
            validatePlanFileReferences(errors, taskId, `experimentVariants[${varIndex}].prompt`, variant.prompt, repoRoot);
          }

          if (typeof variant.command === 'string') {
            validatePlanFileReferences(errors, taskId, `experimentVariants[${varIndex}].command`, variant.command, repoRoot);
            validateRequiredCommandFiles(errors, taskId, `experimentVariants[${varIndex}].command`, variant.command, repoRoot);
          }

          if (typeof variant.command === 'string' && hasUnsafeNestedShellVariableExpansion(variant.command)) {
            pushUnsafeCommandError(errors, taskId, `experimentVariants[${varIndex}].command`, variant.command);
          }

          if (typeof variant.command === 'string' && usesPipefailSetCommand(variant.command) && !isExplicitBashCommand(variant.command)) {
            pushNonPortablePipefailError(errors, taskId, `experimentVariants[${varIndex}].command`, variant.command);
          }
        });
      }
    }
  });

  // Validate dependency references
  raw.tasks.forEach((task: RawPlanTask) => {
    if (!task.id) return; // Already reported as error above

    if (task.dependencies && Array.isArray(task.dependencies)) {
      task.dependencies.forEach((depId: string) => {
        if (!taskIds.has(depId)) {
          errors.push({
            errorType: 'invalid_dependency_reference',
            field: 'dependencies',
            taskId: task.id,
            message: `Task "${task.id}" depends on non-existent task "${depId}"`,
            value: depId,
          });
        }
      });
    }
  });

  return errors;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: validate-plan.ts <plan.yaml>');
    process.exit(1);
  }

  const filePath = args[0];
  let content: string;

  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(JSON.stringify([{
      errorType: 'file_not_found',
      field: 'file',
      message: e instanceof Error ? e.message : String(e),
      value: filePath,
    }], null, 2));
    process.exit(1);
  }

  const errors = validatePlan(content, findRepoRoot(process.cwd()));

  if (errors.length > 0) {
    console.error(JSON.stringify(errors, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ valid: true, file: filePath }));
  process.exit(0);
}

main();
