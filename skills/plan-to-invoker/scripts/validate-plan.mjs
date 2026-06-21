#!/usr/bin/env node
/**
 * Typed plan validator — parses YAML structurally and validates against plan-parser.ts constraints.
 * Outputs deterministic JSON diagnostics and exits non-zero on any validation failure.
 *
 * Usage: node validate-plan.mjs <plan.yaml>
 * Output: JSON array of errors (stable keys: errorType, field, taskId, message, value)
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveYamlModulePath(scriptDir) {
  const localRepoRoot = resolve(scriptDir, '../../..');
  const localYamlPath = resolve(localRepoRoot, 'packages/app/node_modules/yaml/dist/index.js');
  if (existsSync(localYamlPath)) {
    return localYamlPath;
  }

  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: scriptDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const sharedRepoRoot = resolve(scriptDir, gitCommonDir, '..');
    const sharedYamlPath = resolve(sharedRepoRoot, 'packages/app/node_modules/yaml/dist/index.js');
    if (existsSync(sharedYamlPath)) {
      return sharedYamlPath;
    }
  } catch {
    // Ignore git lookup failure and fall through to the explicit error below.
  }

  throw new Error(
    'Unable to resolve yaml runtime. Checked packages/app/node_modules/yaml/dist/index.js in the current worktree and the shared git checkout.',
  );
}

const yamlPath = resolveYamlModulePath(__dirname);

const { parse: parseYaml } = await import(yamlPath);

const VALID_ON_FINISH = ['none', 'merge', 'pull_request'];
const VALID_MERGE_MODE = ['manual', 'automatic', 'external_review'];
const VALID_REQUIRED_STATUS = ['completed', 'review_ready'];
const VALID_GATE_POLICY = ['completed', 'review_ready'];

const NESTED_SHELL_INVOCATION = /\b(?:sh|bash)\s+-(?:c|lc)\b/g;
const SHELL_VARIABLE_REFERENCE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/;
const EXPLICIT_BASH_COMMAND = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*bash\s+-(?:lc|cl|c)\b/;

function hasUnsafeNestedShellVariableExpansion(command) {
  NESTED_SHELL_INVOCATION.lastIndex = 0;

  for (let match = NESTED_SHELL_INVOCATION.exec(command); match !== null; match = NESTED_SHELL_INVOCATION.exec(command)) {
    const nestedCommand = extractNestedShellCommand(command, match.index + match[0].length);
    if (nestedCommand !== null && SHELL_VARIABLE_REFERENCE.test(nestedCommand)) {
      return true;
    }
  }

  return false;
}

function usesPipefailSetCommand(command) {
  return command
    .split(/[;&|()\n]/)
    .some((segment) => /^\s*set\s+/.test(segment) && /\bpipefail\b/.test(segment));
}

function isExplicitBashCommand(command) {
  return EXPLICIT_BASH_COMMAND.test(command);
}

function extractNestedShellCommand(command, startIndex) {
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

function hasOddBackslashRun(value, index) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function pushUnsafeCommandError(errors, taskId, field, command) {
  errors.push({
    errorType: 'unsafe_shell_variable_expansion',
    field,
    taskId,
    message: `Task "${taskId}" uses a nested shell command with shell variable references. Avoid sh -c/bash -c quoting with variables in plan command fields; use a direct command or literal smoke command instead.`,
    value: command,
  });
}

function pushNonPortablePipefailError(errors, taskId, field, command) {
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
 */
function validateExternalDeps(deps, fieldPrefix, errors, taskId) {
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
  deps.forEach((dep, depIndex) => {
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

    if (dep.requiredStatus !== undefined && !VALID_REQUIRED_STATUS.includes(dep.requiredStatus)) {
      errors.push({
        errorType: 'invalid_enum_value',
        field: `${fieldPrefix}[${depIndex}].requiredStatus`,
        ...(taskId ? { taskId } : {}),
        message: `${taskId ? `Task "${taskId}" ` : ''}externalDependencies[${depIndex}] "requiredStatus" must be "completed" or "review_ready"`,
        value: dep.requiredStatus,
      });
    }

    if (dep.gatePolicy !== undefined && !VALID_GATE_POLICY.includes(dep.gatePolicy)) {
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

function validateReviewGate(reviewGate, errors) {
  if (!reviewGate || typeof reviewGate !== 'object' || Array.isArray(reviewGate)) {
    errors.push({
      errorType: 'invalid_field_type',
      field: 'reviewGate',
      message: 'reviewGate must be an object',
      value: reviewGate,
    });
    return;
  }

  const artifacts = reviewGate.artifacts;
  if (!Array.isArray(artifacts)) {
    errors.push({
      errorType: 'invalid_field_type',
      field: 'reviewGate.artifacts',
      message: 'reviewGate.artifacts must be an array',
      value: artifacts,
    });
    return;
  }

  const ids = new Set();
  const normalizedArtifacts = [];
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
    if (typeof artifact.id !== 'string' || artifact.id.trim() === '') {
      errors.push({
        errorType: 'missing_required_field',
        field: `${field}.id`,
        message: `${field}.id must be a non-empty string`,
        value: artifact.id,
      });
      return;
    }
    if (ids.has(artifact.id)) {
      errors.push({
        errorType: 'duplicate_id',
        field: `${field}.id`,
        message: `${field}.id duplicates artifact "${artifact.id}"`,
        value: artifact.id,
      });
      return;
    }
    ids.add(artifact.id);
    if (artifact.required === undefined) {
      artifact.required = true;
    } else if (typeof artifact.required !== 'boolean') {
      errors.push({
        errorType: 'invalid_field_type',
        field: `${field}.required`,
        message: `${field}.required must be a boolean when provided`,
        value: artifact.required,
      });
    }
    if (artifact.dependsOn !== undefined && !Array.isArray(artifact.dependsOn)) {
      errors.push({
        errorType: 'invalid_field_type',
        field: `${field}.dependsOn`,
        message: `${field}.dependsOn must be an array`,
        value: artifact.dependsOn,
      });
      return;
    }
    const dependsOn = artifact.dependsOn ?? [];
    const normalizedDependsOn = [];
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
    normalizedArtifacts.push({ id: artifact.id, dependsOn: normalizedDependsOn });
  });

  normalizedArtifacts.forEach((artifact, index) => {
    const field = `reviewGate.artifacts[${index}].dependsOn`;
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

  const graph = new Map(normalizedArtifacts.map((artifact) => [artifact.id, artifact.dependsOn]));
  const visitState = new Map();
  const visit = (id) => {
    const state = visitState.get(id);
    if (state === 'visiting') return true;
    if (state === 'visited') return false;
    visitState.set(id, 'visiting');
    for (const dependency of graph.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    visitState.set(id, 'visited');
    return false;
  };
  for (const artifact of normalizedArtifacts) {
    if (visit(artifact.id)) {
      errors.push({
        errorType: 'cyclic_dependency',
        field: 'reviewGate.artifacts',
        message: 'reviewGate.artifacts must not contain dependency cycles',
      });
      break;
    }
  }
}

function validatePlan(yamlContent) {
  const errors = [];

  // Parse YAML
  let raw;
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
    raw = parsed;
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
  if (raw.onFinish !== undefined && !VALID_ON_FINISH.includes(raw.onFinish)) {
    errors.push({
      errorType: 'invalid_enum_value',
      field: 'onFinish',
      message: `"onFinish" must be one of: ${VALID_ON_FINISH.join(', ')}`,
      value: raw.onFinish,
    });
  }

  if (raw.mergeMode !== undefined && !VALID_MERGE_MODE.includes(raw.mergeMode)) {
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
  if (raw.reviewGate !== undefined) {
    validateReviewGate(raw.reviewGate, errors);
  }

  // Collect all externalDependencies (plan-level + task-level) for cross-checks
  const allExtDeps = [];
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
  const taskIds = new Set();

  // Validate tasks
  raw.tasks.forEach((task, index) => {
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
        task.experimentVariants.forEach((variant, varIndex) => {
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
  raw.tasks.forEach((task) => {
    if (!task.id) return; // Already reported as error above

    if (task.dependencies && Array.isArray(task.dependencies)) {
      task.dependencies.forEach((depId) => {
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
    console.error('Usage: validate-plan.mjs <plan.yaml>');
    process.exit(1);
  }

  const filePath = args[0];
  let content;

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

  const errors = validatePlan(content);

  if (errors.length > 0) {
    console.error(JSON.stringify(errors, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ valid: true, file: filePath }));
  process.exit(0);
}

main();
