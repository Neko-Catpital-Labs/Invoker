#!/usr/bin/env python3
"""Regenerate the evaluator-owned gold and control patches for both variants.

The patches are committed so `self-test` and `verify-recorded` never depend on
this generator at run time; it exists so a reviewer can reproduce them.

Usage:
    python3 scripts/repro/architecture-memory/tools/build_fixture_patches.py
"""

from __future__ import annotations

import difflib
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO_ROOT = ROOT.parents[2]
TARGET = "packages/app/src/workflow-mutation-facade.ts"

sys.path.insert(0, str(ROOT))
from amlib.manifest import EXPERIMENT_SOURCE_COMMIT, STRUCTURAL_DELTA  # noqa: E402

ANCHOR = "  async recreateTask(taskId: string): Promise<MutationResult> {"

BASELINE_BODIES = {
    "gold": """  async closeIdleTask(taskId: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const result = await this.deps.commandService.closeIdleTask(
      makeEnvelope('facade.close-idle-task', 'surface', 'task', { taskId }),
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return this.finalizeWithTopup([], 'facade.close-idle-task', { scopedTaskIds: [taskId] });
  }

""",
    "control-missing-invariant": """  async closeIdleTask(taskId: string): Promise<MutationResult> {
    const result = await this.deps.commandService.closeIdleTask(
      makeEnvelope('facade.close-idle-task', 'surface', 'task', { taskId }),
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return this.finalizeWithTopup([], 'facade.close-idle-task', { scopedTaskIds: [taskId] });
  }

""",
    "control-wrong-envelope": """  async closeIdleTask(taskId: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const result = await this.deps.commandService.closeIdleTask(
      makeEnvelope('facade.retry-task', 'surface', 'task', { taskId }),
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return this.finalizeWithTopup([], 'facade.close-idle-task', { scopedTaskIds: [taskId] });
  }

""",
    "control-stub-only": """  async closeIdleTask(taskId: string): Promise<MutationResult> {
    void taskId;
    return { started: [], runnable: [], topup: [] };
  }

""",
}

TREATMENT_BODIES = {
    "gold": """  async closeIdleTask(taskId: string): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.close-idle-task', async () => {
      const result = await this.deps.commandService.closeIdleTask(
        makeEnvelope('facade.close-idle-task', 'surface', 'task', { taskId }),
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return [];
    });
  }

""",
    "control-missing-invariant": BASELINE_BODIES["control-missing-invariant"],
    "control-wrong-envelope": """  async closeIdleTask(taskId: string): Promise<MutationResult> {
    return this.mutateTaskScoped(taskId, 'facade.close-idle-task', async () => {
      const result = await this.deps.commandService.closeIdleTask(
        makeEnvelope('facade.retry-task', 'surface', 'task', { taskId }),
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return [];
    });
  }

""",
    "control-stub-only": BASELINE_BODIES["control-stub-only"],
}


def read_source_at_commit() -> str:
    return subprocess.run(
        ["git", "show", f"{EXPERIMENT_SOURCE_COMMIT}:{TARGET}"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def apply_structural_delta(text: str) -> str:
    for old, new in STRUCTURAL_DELTA["replacements"]:
        if text.count(old) != 1:
            raise SystemExit(f"structural delta anchor matched {text.count(old)} times")
        text = text.replace(old, new)
    anchor = STRUCTURAL_DELTA["helper_anchor"]
    if text.count(anchor) != 1:
        raise SystemExit("structural delta helper anchor not unique")
    return text.replace(anchor, STRUCTURAL_DELTA["helper"] + anchor)


def unified(before: str, after: str) -> str:
    diff = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"a/{TARGET}",
        tofile=f"b/{TARGET}",
        n=3,
    )
    body = "".join(diff)
    if not body:
        raise SystemExit("empty patch")
    return f"diff --git a/{TARGET} b/{TARGET}\n{body}"


def insert(text: str, body: str) -> str:
    if text.count(ANCHOR) != 1:
        raise SystemExit("insertion anchor not unique")
    return text.replace(ANCHOR, body + ANCHOR)


def main() -> int:
    pristine = read_source_at_commit()
    treatment = apply_structural_delta(pristine)

    (ROOT / "treatment" / "structural-delta.patch").write_text(unified(pristine, treatment))

    for variant, base, bodies in (
        ("baseline", pristine, BASELINE_BODIES),
        ("treatment", treatment, TREATMENT_BODIES),
    ):
        out_dir = ROOT / "grader" / "patches" / variant
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, body in bodies.items():
            (out_dir / f"{name}.patch").write_text(unified(base, insert(base, body)))
        (out_dir / "control-noop.patch").write_text(unified(base, base + "\n"))
        print(f"{variant}: wrote {len(bodies) + 1} patches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
