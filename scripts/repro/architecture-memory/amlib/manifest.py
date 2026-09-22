"""Immutable experiment manifest: source commit, structural delta, trial task.

Every value here is part of the experiment's provenance. run.py hashes this
module and records the hash in each pair record; verify-recorded refuses a
record whose manifest hash does not match.
"""

from __future__ import annotations

EXPERIMENT_ID = "architecture-memory-close-idle-task"
EXPERIMENT_SOURCE_COMMIT = "0ca415e4d69a3f59a4b666e65f6362adf2d947ad"
EXPERIMENT_SOURCE_REMOTE = "https://github.com/Neko-Catpital-Labs/Invoker.git"

TARGET_FILE = "packages/app/src/workflow-mutation-facade.ts"

TRIAL_WORKSPACE_REDACTIONS = [
    "CLAUDE.md",
    "AGENTS.md",
    "ARCHITECTURE.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LOOP.md",
    "README.md",
    ".cursor",
    ".github",
    "docs",
    "evals",
    "plans",
    "repro",
    "skills",
    "scripts/repro",
]

EQUIVALENCE_TESTS = [
    "src/__tests__/workflow-mutation-facade.test.ts",
    "src/__tests__/parity-regression.test.ts",
]

GRADER_CHECK_IDS = [
    "check:exposes-close-idle-task",
    "check:routes-through-command-service",
    "check:closes-review-before-mutation",
    "check:runs-scoped-dispatch-and-topup",
    "check:propagates-command-service-failure",
]

COMMAND_CHECK_IDS = [
    "check:existing-facade-suite",
    "check:typecheck",
]

HELPER = """  private async mutateTaskScoped(
    taskId: string,
    context: string,
    mutate: () => Promise<TaskState[]> | TaskState[],
  ): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = await mutate();
    return this.finalizeWithTopup(started, context, { scopedTaskIds: [taskId] });
  }

"""

REPLACEMENT_PAIRS = [
(
"""  async retryTask(taskId: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = await this.runViaCommandService(
      (cs) => cs.retryTask(makeEnvelope('facade.retry-task', 'surface', 'task', { taskId })),
    );
    return this.finalizeWithTopup(started, 'facade.retry-task', { scopedTaskIds: [taskId] });
  }""",
"""  async retryTask(taskId: string): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.retry-task', () =>
      this.runViaCommandService(
        (cs) => cs.retryTask(makeEnvelope('facade.retry-task', 'surface', 'task', { taskId })),
      ),
    );
  }"""),
(
"""  async recreateTask(taskId: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = await this.runViaCommandService(
      (cs) => cs.recreateTask(makeEnvelope('facade.recreate-task', 'surface', 'task', { taskId })),
    );
    return this.finalizeWithTopup(started, 'facade.recreate-task', { scopedTaskIds: [taskId] });
  }""",
"""  async recreateTask(taskId: string): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.recreate-task', () =>
      this.runViaCommandService(
        (cs) => cs.recreateTask(makeEnvelope('facade.recreate-task', 'surface', 'task', { taskId })),
      ),
    );
  }"""),
(
"""  async selectExperiment(taskId: string, experimentId: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = sharedSelectExperiment(taskId, experimentId, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.select-experiment', { scopedTaskIds: [taskId] });
  }""",
"""  async selectExperiment(taskId: string, experimentId: string): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.select-experiment', () =>
      sharedSelectExperiment(taskId, experimentId, {
        orchestrator: this.deps.orchestrator,
      }),
    );
  }"""),
(
"""  async selectExperiments(taskId: string, experimentIds: string[]): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = await sharedSelectExperiments(taskId, experimentIds, {
      orchestrator: this.deps.orchestrator,
      taskExecutor: this.deps.taskExecutor,
    });
    return this.finalizeWithTopup(started, 'facade.select-experiments', { scopedTaskIds: [taskId] });
  }""",
"""  async selectExperiments(taskId: string, experimentIds: string[]): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.select-experiments', () =>
      sharedSelectExperiments(taskId, experimentIds, {
        orchestrator: this.deps.orchestrator,
        taskExecutor: this.deps.taskExecutor,
      }),
    );
  }"""),
(
"""  async editTaskCommand(taskId: string, newCommand: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = sharedEditTaskCommand(taskId, newCommand, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-command', { scopedTaskIds: [taskId] });
  }""",
"""  async editTaskCommand(taskId: string, newCommand: string): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.edit-task-command', () =>
      sharedEditTaskCommand(taskId, newCommand, {
        orchestrator: this.deps.orchestrator,
      }),
    );
  }"""),
(
"""  async editTaskPrompt(taskId: string, newPrompt: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = sharedEditTaskPrompt(taskId, newPrompt, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-prompt', { scopedTaskIds: [taskId] });
  }""",
"""  async editTaskPrompt(taskId: string, newPrompt: string): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.edit-task-prompt', () =>
      sharedEditTaskPrompt(taskId, newPrompt, {
        orchestrator: this.deps.orchestrator,
      }),
    );
  }"""),
(
"""    await this.closeReviewForTask(taskId);
    const started = sharedEditTaskType(
      taskId,
      runnerKind,
      { orchestrator: this.deps.orchestrator },
      poolMemberId,
    );
    return this.finalizeWithTopup(started, 'facade.edit-task-type', { scopedTaskIds: [taskId] });
  }""",
"""    return this.mutateTaskScoped(taskId, 'facade.edit-task-type', () =>
      sharedEditTaskType(
        taskId,
        runnerKind,
        { orchestrator: this.deps.orchestrator },
        poolMemberId,
      ),
    );
  }"""),
(
"""  async editTaskAgent(taskId: string, agentName: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = sharedEditTaskAgent(taskId, agentName, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-agent', { scopedTaskIds: [taskId] });
  }""",
"""  async editTaskAgent(taskId: string, agentName: string): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.edit-task-agent', () =>
      sharedEditTaskAgent(taskId, agentName, {
        orchestrator: this.deps.orchestrator,
      }),
    );
  }"""),
(
"""  async editTaskModel(taskId: string, executionModel: string | null): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = sharedEditTaskModel(taskId, executionModel, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-model', { scopedTaskIds: [taskId] });
  }""",
"""  async editTaskModel(taskId: string, executionModel: string | null): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.edit-task-model', () =>
      sharedEditTaskModel(taskId, executionModel, {
        orchestrator: this.deps.orchestrator,
      }),
    );
  }"""),
]

STRUCTURAL_DELTA = {
    "summary": (
        "Route every task-scoped facade mutation through one named helper, "
        "mutateTaskScoped(taskId, context, mutate), which owns close-review -> "
        "mutate -> scoped dispatch + topup. Pure refactor: no behaviour change."
    ),
    "helper": HELPER,
    "helper_anchor": "  private async dispatchWithTopup(",
    "replacements": REPLACEMENT_PAIRS,
}
