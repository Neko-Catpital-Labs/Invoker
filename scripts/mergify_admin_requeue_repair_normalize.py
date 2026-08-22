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
    from .mergify_admin_requeue_plan import is_queue_only_required_check
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
    from mergify_admin_requeue_plan import is_queue_only_required_check
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


# A queue-only required check (see is_queue_only_required_check) never runs on
# an ordinary PR head, only on the merge-queue draft -- so an agent repair
# attempt against it settling with no commit isn't "nothing needed fixing", it
# means the check's failure can't be repaired locally at all. plan.py's
# plan_bottom_progress reads for this exact ("queue-only-noop", pr, headSha,
# check) row to know it can restore the admin-bypass label and let Mergify's
# queue retry the check for real, instead of leaving the PR permanently
# unlabeled with no path back into the queue.
def _record_queue_only_noop_if_applicable(
    state_file: Path, pr_number: int, start_head: str, check_name: str,
) -> None:
    if is_queue_only_required_check(check_name):
        Ledger(state_file).record("queue-only-noop", pr_number, start_head, check_name)


# The agent repair task made no commit for a failing "PR Body" check. Two
# very different situations look identical from here, so decide which one it
# is by re-checking validity now:
#   - the body is actually fine (already valid, or the PR was merged/closed
#     out from under the repair mid-flight, so there's nothing left to fix) --
#     record "repair-noop", which plan.py's plan_stack_execution reads
#     (hardcoded to the "PR Body" key) to stop treating this check as blocking.
#   - the body is still invalid, and the agent had every chance to fix it but
#     didn't -- that's a human decision, not something worth re-submitting
#     every tick. Record "repair-invalid" (see plan.py's
#     latest_repair_invalid_blocker, which reads it into a human_decision
#     blocker) and post the stop comment once, the same shape
#     AdminBypassGhExecutor.comment_blocked posts from the synchronous path.
# Deliberately NOT decided at submission time (see
# repro-babysit-pr-body-human-split.sh): a real agent might still fix a body
# that looks invalid right now, so the async repair always gets the chance to
# try before anything here calls it unfixable.
def _record_repair_noop_or_invalid_for_pr_body(
    state_file: Path, repo: str, pr_number: int, start_head: str, check_name: str, base: str, cwd: Path,
) -> None:
    if check_name != "PR Body":
        return
    gh = GhClient()
    detail = gh.pr_detail(repo, pr_number)
    ledger = Ledger(state_file)
    if str(detail.get("state") or "OPEN") != "OPEN":
        # The PR was merged or closed while the repair was in flight. There is
        # no longer a base to diff against (an orphaned/merged branch may not
        # even share history with it), and nothing left to fix either way.
        ledger.record("repair-noop", pr_number, start_head, check_name)
        return
    body = str(detail.get("body") or "")
    validation = validate_current_pr_body(cwd, body, base)
    if validation.get("valid"):
        ledger.record("repair-noop", pr_number, start_head, check_name)
        return
    errors = invalid_repair_errors(validation, base)
    if not errors:
        return
    ledger.record("repair-invalid", pr_number, start_head, check_name, meta={"errors": errors})
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
    if str(detail.get("state") or "OPEN") != "OPEN":
        # The PR was merged or closed (e.g. superseded by a duplicate PR that
        # landed the same fix directly) while the repair was in flight. There
        # is no longer anything to push the normalized commit to, and
        # validating a stale remote body against it would only ever block on
        # content nobody will read -- see _record_repair_noop_or_invalid_for_pr_body,
        # which already applies this same check on the empty-diff paths.
        hard_reset_work_root(cwd, start_head)
        _record_queue_only_noop_if_applicable(state_file, args.pr, start_head, args.check)
        Ledger(state_file).record("repair-noop", args.pr, start_head, args.check)
        # Reuse the prereq sentinel to skip the downstream safe-push task too:
        # a closed/merged PR's head branch may already be gone from the remote
        # (e.g. GitHub's auto-delete-on-close), so safe-push's captured-head
        # lease would correctly refuse the push as a stale/missing head. There
        # is nothing to publish either way, so skip it the same way the
        # prerequisite-split path does.
        PREREQ_SENTINEL.write_text("1", encoding="utf-8")
        print("noop: PR is no longer open")
        return 0
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
