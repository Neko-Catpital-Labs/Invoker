#!/usr/bin/env python3
"""Regenerate the evaluator-owned control patches from the pinned source.

Run only while authoring. The committed patches under controls/ are the
immutable inputs; manifest.json pins their hashes and run.py refuses to grade
when they drift.
"""

from __future__ import annotations

import importlib
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

run = importlib.import_module("run")

FACADE = "packages/app/src/workflow-mutation-facade.ts"
ANCHOR = "  async deleteTask(taskId: string): Promise<MutationResult> {\n"

BASELINE_GOLD = """  async editTaskPool(taskId: string, poolId: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = await this.runViaCommandService(
      (cs) => cs.editTaskPool(makeEnvelope('facade.edit-task-pool', 'surface', 'task', { taskId, poolId })),
    );
    return this.finalizeWithTopup(started, 'facade.edit-task-pool', { scopedTaskIds: [taskId] });
  }

"""

TREATMENT_GOLD = """  async editTaskPool(taskId: string, poolId: string): Promise<MutationResult> {
    return this.runTaskCommand(
      taskId,
      'facade.edit-task-pool',
      (cs, envelope) => cs.editTaskPool(envelope),
      { poolId },
    );
  }

"""

STUB = """  async editTaskPool(_taskId: string, _poolId: string): Promise<MutationResult> {
    return { started: [], runnable: [], topup: [] };
  }

"""

BYPASS = """  async editTaskPool(taskId: string, poolId: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = this.deps.orchestrator.editTaskPool(taskId, poolId);
    return this.finalizeWithTopup(started, 'facade.edit-task-pool', { scopedTaskIds: [taskId] });
  }

"""

SKIP_REVIEW_CLOSE = """  async editTaskPool(taskId: string, poolId: string): Promise<MutationResult> {
    const started = await this.runViaCommandService(
      (cs) => cs.editTaskPool(makeEnvelope('facade.edit-task-pool', 'surface', 'task', { taskId, poolId })),
    );
    return this.finalizeWithTopup(started, 'facade.edit-task-pool', { scopedTaskIds: [taskId] });
  }

"""

UNSCOPED = """  async editTaskPool(taskId: string, poolId: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = await this.runViaCommandService(
      (cs) => cs.editTaskPool(makeEnvelope('facade.edit-task-pool', 'surface', 'task', { taskId, poolId })),
    );
    return this.finalizeWithTopup(started, 'facade.edit-task-pool');
  }

"""

NOOP_TEST = """import { describe, it } from 'vitest';

describe('WorkflowMutationFacade.editTaskPool', () => {
  it.todo('routes pool edits through the facade');
});
"""


def insert_method(body: str):
    def edit(repo: Path) -> None:
        path = repo / FACADE
        text = path.read_text(encoding="utf-8")
        if ANCHOR not in text:
            raise SystemExit("anchor missing")
        path.write_text(text.replace(ANCHOR, body + ANCHOR, 1), encoding="utf-8")
    return edit


def add_todo_test(repo: Path) -> None:
    target = repo / "packages/app/src/__tests__/edit-task-pool.test.ts"
    target.write_text(NOOP_TEST, encoding="utf-8")


CONTROLS = {
    "gold": {"baseline": insert_method(BASELINE_GOLD), "treatment": insert_method(TREATMENT_GOLD)},
    "noop-todo-test": {"baseline": add_todo_test, "treatment": add_todo_test},
    "stub-empty-result": {"baseline": insert_method(STUB), "treatment": insert_method(STUB)},
    "bypass-command-service": {"baseline": insert_method(BYPASS), "treatment": insert_method(BYPASS)},
    "skip-review-close": {"baseline": insert_method(SKIP_REVIEW_CLOSE), "treatment": insert_method(SKIP_REVIEW_CLOSE)},
    "unscoped-dispatch": {"baseline": insert_method(UNSCOPED), "treatment": insert_method(UNSCOPED)},
}


def pin_manifest() -> None:
    m = run.manifest()
    files = [m["fixture"]["patch"], m["grader"]["file"], m["task"]["prompt"], "runners.json"]
    files += [spec["patch"] for arm in run.ARMS for spec in m["controls"][arm].values()]
    m["pinned_files"] = {rel: run.sha256_file(HERE / rel) for rel in sorted(files)}
    run.write_json(run.MANIFEST_PATH, m)
    print(f"pinned {len(files)} files in manifest.json")


def main() -> int:
    if "--pin" in sys.argv:
        pin_manifest()
        return 0
    run.ensure_source()
    with tempfile.TemporaryDirectory(prefix="archmem-author-") as tmp:
        for arm in run.ARMS:
            snap = run.build_snapshot(Path(tmp) / arm, arm, install=False)
            repo = Path(snap["path"])
            for name, edits in CONTROLS.items():
                subprocess.run(["git", "reset", "-q", "--hard", snap["commit"]], cwd=repo, check=True)
                subprocess.run(["git", "clean", "-qfd"], cwd=repo, check=True)
                edits[arm](repo)
                subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
                diff = subprocess.run(
                    ["git", "diff", "--cached", "--binary", snap["commit"]],
                    cwd=repo, check=True, capture_output=True,
                ).stdout
                out = HERE / "controls" / arm / f"{name}.patch"
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(diff)
                print(f"wrote {out.relative_to(HERE)} ({len(diff)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
