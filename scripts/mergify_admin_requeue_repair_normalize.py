from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

# The normalize process must not dirty the checkout it is about to dirty-check.
sys.dont_write_bytecode = True

try:
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Ledger
    from .mergify_admin_requeue_repair_body import (
        create_repair_prerequisite,
        git_lines,
        git_output,
        hard_reset_work_root,
        invalid_repair_errors,
        is_prereq_split_validation,
        normalize_repair_commit,
        validate_current_pr_body,
    )
    from .mergify_admin_requeue_snapshot import GhClient
except ImportError:
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Ledger
    from mergify_admin_requeue_repair_body import (
        create_repair_prerequisite,
        git_lines,
        git_output,
        hard_reset_work_root,
        invalid_repair_errors,
        is_prereq_split_validation,
        normalize_repair_commit,
        validate_current_pr_body,
    )
    from mergify_admin_requeue_snapshot import GhClient

# Runs inside the Invoker `normalize` task's own checkout, one hop after the
# `repair` task's agent turn -- this is the async replacement for the local
# post-run_claude_repair inspection AdminBypassRepairer.repair_check used to do
# synchronously in the cron process. It re-implements: dirty-check/reset,
# normalize_repair_commit (rebase-shaped diff handling), PR-body
# re-validation, and -- if the fix needs restructuring -- create_repair_prerequisite
# (a small prerequisite PR) instead of letting `safe-push` push directly.

PREREQ_SENTINEL = Path(".invoker-repair-prereq-created")

# Written unconditionally as this task's first action: reaching `normalize` at
# all means the submitted repair attempt concluded (successfully, as a noop, or
# as a still-invalid fix), which is what frees plan.py's repair_in_flight check
# for this (pr, headSha, blockerKey) -- regardless of what happens below. Only
# a crash before `normalize` even starts (the `repair` task itself dying) skips
# this write, and that's exactly the case the in-flight TTL exists to bound.
def _record_settle_marker(state_file: Path, pr_number: int, start_head: str, check_name: str) -> None:
    Ledger(state_file).record("repair-check-settled", pr_number, start_head, check_name)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize an async admin-bypass repair commit before safe-push.")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--check", required=True)
    parser.add_argument("--start-head", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--trunk", default="master")
    parser.add_argument(
        "--state-file",
        default=str(Path.home() / ".invoker" / "mergify-admin-requeue-state.jsonl"),
        help="Ledger JSONL path. Default: ~/.invoker/mergify-admin-requeue-state.jsonl.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    cwd = Path.cwd()
    start_head = args.start_head
    state_file = Path(args.state_file).expanduser()

    _record_settle_marker(state_file, args.pr, start_head, args.check)

    dirty = git_lines(cwd, "status", "--porcelain")
    if dirty:
        hard_reset_work_root(cwd, start_head)
        print("blocked_dirty: repair left the working tree dirty: " + "; ".join(dirty), file=sys.stderr)
        return 1

    end_head = git_output(cwd, "rev-parse", "HEAD").strip()
    if end_head == start_head:
        print("noop: repair task made no commit")
        return 0

    end_head = normalize_repair_commit(cwd, start_head, end_head, args.check)
    if end_head == start_head:
        print("noop: repair diff was empty after normalization")
        return 0

    gh = GhClient()
    detail = gh.pr_detail(args.repo, args.pr)
    body = str(detail.get("body") or "")
    validation = validate_current_pr_body(cwd, body, args.base)
    if validation.get("valid"):
        print(f"repair commit normalized to {end_head}; ready for safe-push")
        return 0

    if is_prereq_split_validation(validation, args.base):
        repair_commits = git_lines(cwd, "rev-list", "--reverse", f"{start_head}..{end_head}")
        ledger = Ledger(state_file)
        logger = AdminBypassLogger()
        try:
            create_repair_prerequisite(
                gh, ledger, logger, args.repo, cwd,
                args.pr, start_head, args.check, start_head, repair_commits, None,
            )
        finally:
            hard_reset_work_root(cwd, start_head)
        PREREQ_SENTINEL.write_text("1", encoding="utf-8")
        print("prerequisite PR created; original PR left unchanged for this attempt")
        return 0

    hard_reset_work_root(cwd, start_head)
    errors = invalid_repair_errors(validation, args.base)
    print("blocked_invalid: " + "; ".join(errors), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
