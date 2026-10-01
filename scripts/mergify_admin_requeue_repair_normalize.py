from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

# Safety invariant: The normalize process must not dirty the checkout it is about to dirty-check.
sys.dont_write_bytecode = True

try:
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Ledger
    from .mergify_admin_requeue_plan import is_queue_only_required_check
    from .mergify_admin_requeue_repair_body import (
        create_repair_prerequisite,
        git_lines,
        git_output,
        hard_reset_work_root,
        invalid_repair_errors,
        is_prereq_split_validation,
        normalize_repair_commit,
        scope_split_review_units,
        validate_current_pr_body,
    )
    from .mergify_admin_requeue_snapshot import GhClient
except ImportError:
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Ledger
    from mergify_admin_requeue_plan import is_queue_only_required_check
    from mergify_admin_requeue_repair_body import (
        create_repair_prerequisite,
        git_lines,
        git_output,
        hard_reset_work_root,
        invalid_repair_errors,
        is_prereq_split_validation,
        normalize_repair_commit,
        scope_split_review_units,
        validate_current_pr_body,
    )
    from mergify_admin_requeue_snapshot import GhClient

PREREQ_SENTINEL = Path(".invoker-repair-prereq-created")

# Safety invariant: Record settlement before later exits so plan.py frees repair_in_flight for this repair attempt unless normalize never starts, which the in-flight TTL bounds.
def _record_settle_marker(state_file: Path, pr_number: int, start_head: str, check_name: str) -> None:
    Ledger(state_file).record("repair-check-settled", pr_number, start_head, check_name)


# Safety invariant: Queue-only required checks that noop must record queue-only-noop so plan.py can restore admin-bypass and let Mergify retry the check in the queue.
def _record_queue_only_noop_if_applicable(
    state_file: Path, pr_number: int, start_head: str, check_name: str,
) -> None:
    if is_queue_only_required_check(check_name):
        Ledger(state_file).record("queue-only-noop", pr_number, start_head, check_name)


# Safety invariant: A no-commit PR Body repair must re-check current validity before recording repair-noop or repair-invalid so an async repair gets its chance before being called unfixable.
def _record_repair_noop_or_invalid_for_pr_body(
    state_file: Path, repo: str, pr_number: int, start_head: str, check_name: str, base: str, cwd: Path,
) -> None:
    if check_name != "PR Body":
        return
    gh = GhClient()
    detail = gh.pr_detail(repo, pr_number)
    ledger = Ledger(state_file)
    if str(detail.get("state") or "OPEN") != "OPEN":
        # Safety invariant: A merged or closed PR Body repair records repair-noop without diffing because the base may no longer share history and there is nothing left to fix.
        ledger.record("repair-noop", pr_number, start_head, check_name)
        return
    body = str(detail.get("body") or "")
    validation = validate_current_pr_body(cwd, body, base)
    if validation.get("valid"):
        ledger.record("repair-noop", pr_number, start_head, check_name)
        return
    errors = invalid_repair_errors(validation, base)
    _stop_for_invalid_pr_body(state_file, repo, pr_number, start_head, check_name, errors)


def _stop_for_invalid_pr_body(
    state_file: Path, repo: str, pr_number: int, start_head: str, check_name: str, errors: list[str],
) -> None:
    if not errors:
        return
    Ledger(state_file).record("repair-invalid", pr_number, start_head, check_name, meta={"errors": errors})
    gh = GhClient()
    stop_body = "Mergify repair stopped: " + "\n".join(errors)
    existing = gh.issue_comments(repo, pr_number)
    if not any(str(comment.get("body") or "").strip() == stop_body for comment in existing):
        gh.comment(repo, pr_number, stop_body)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize an async admin-bypass repair commit before safe-push.")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--check", required=True)
    parser.add_argument("--start-head", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--trunk", default="master")
    parser.add_argument("--scope-split", action="store_true")
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
        _record_queue_only_noop_if_applicable(state_file, args.pr, start_head, args.check)
        _record_repair_noop_or_invalid_for_pr_body(state_file, args.repo, args.pr, start_head, args.check, args.base, cwd)
        print("noop: repair task made no commit")
        return 0

    end_head = normalize_repair_commit(cwd, start_head, end_head, args.check)
    if end_head == start_head:
        _record_queue_only_noop_if_applicable(state_file, args.pr, start_head, args.check)
        _record_repair_noop_or_invalid_for_pr_body(state_file, args.repo, args.pr, start_head, args.check, args.base, cwd)
        print("noop: repair diff was empty after normalization")
        return 0

    gh = GhClient()
    detail = gh.pr_detail(args.repo, args.pr)
    body = str(detail.get("body") or "")
    validation = validate_current_pr_body(cwd, body, args.base)
    if validation.get("valid"):
        print(f"repair commit normalized to {end_head}; ready for safe-push")
        return 0

    if args.scope_split and scope_split_review_units(validation):
        hard_reset_work_root(cwd, start_head)
        errors = invalid_repair_errors(validation, args.base)
        if not errors:
            errors = [
                "diff still spans review units: " + ", ".join(scope_split_review_units(validation))
            ]
        _stop_for_invalid_pr_body(state_file, args.repo, args.pr, start_head, args.check, errors)
        print("blocked_invalid: " + "; ".join(errors), file=sys.stderr)
        return 1

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
