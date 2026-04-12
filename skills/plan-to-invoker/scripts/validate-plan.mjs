#!/usr/bin/env node
/**
 * Typed plan validator — parses YAML structurally and validates against plan-parser.ts constraints.
 * Outputs deterministic JSON diagnostics and exits non-zero on any validation failure.
 *
 * Usage: node validate-plan.mjs <plan.yaml>
 * Output: JSON array of errors (stable keys: errorType, field, taskId, message, value)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve yaml from packages/app/node_modules using absolute path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');
const yamlPath = resolve(repoRoot, 'packages/app/node_modules/yaml/dist/index.js');

const { parse: parseYaml } = await import(yamlPath);

const VALID_ON_FINISH = ['none', 'merge', 'pull_request'];
const VALID_MERGE_MODE = ['manual', 'automatic', 'github', 'external_review'];
const VALID_EXECUTOR_TYPE = ['worktree', 'docker', 'ssh'];
const VALID_REQUIRED_STATUS = ['completed'];
const VALID_GATE_POLICY = ['completed', 'review_ready'];

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
        message: `${taskId ? `Task "${taskId}" ` : ''}externalDependencies[${depIndex}] "requiredStatus" must be "completed"`,
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

  if (raw.executorType !== undefined && !VALID_EXECUTOR_TYPE.includes(raw.executorType)) {
    errors.push({
      errorType: 'invalid_enum_value',
      field: 'executorType',
      message: `"executorType" must be one of: ${VALID_EXECUTOR_TYPE.join(', ')}`,
      value: raw.executorType,
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
        message: `Task "${taskId}" uses 'npx vitest run' which may not resolve correctly. Use 'pnpm test' instead.`,
        value: task.command,
      });
    }

    // Validate executorType enum
    if (task.executorType !== undefined && !VALID_EXECUTOR_TYPE.includes(task.executorType)) {
      errors.push({
        errorType: 'invalid_enum_value',
        field: 'executorType',
        taskId,
        message: `Task "${taskId}" executorType must be one of: ${VALID_EXECUTOR_TYPE.join(', ')}`,
        value: task.executorType,
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
