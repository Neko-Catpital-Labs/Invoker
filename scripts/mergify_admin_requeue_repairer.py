from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping, Sequence

try:
    from . import mergify_admin_requeue_async_repair as async_repair
    from .mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Ledger, MergifyQueueEvent, PrSnapshot, RepairOutcome
    from .mergify_admin_requeue_plan import is_queue_only_required_check
    from .mergify_admin_requeue_repair_body import git_output, hard_reset_work_root, validate_current_pr_body
    from .mergify_admin_requeue_snapshot import GhClient, checkout_pr_head
except ImportError:
    from mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Ledger, MergifyQueueEvent, PrSnapshot, RepairOutcome
    from mergify_admin_requeue_plan import is_queue_only_required_check
    from mergify_admin_requeue_repair_body import git_output, hard_reset_work_root, validate_current_pr_body
    from mergify_admin_requeue_snapshot import GhClient, checkout_pr_head
    import mergify_admin_requeue_async_repair as async_repair


def mergify_check_urls(event: MergifyQueueEvent | None, check_name: str) -> tuple[str, ...]:
    if not event:
        return ()
    for name, urls in event.failing_check_urls:
        if name == check_name:
            return urls
    return ()


class AdminBypassRepairer:
    def __init__(
        self,
        gh: GhClient,
        executor: AdminBypassGhExecutor,
        logger: AdminBypassLogger,
        ledger: Ledger,
        repo: str,
    ):
        self.gh = gh
        self.executor = executor
        self.logger = logger
        self.ledger = ledger
        self.repo = repo

    def blocked_outcome(
        self,
        status: str,
        check_name: str,
        start_head: str,
        end_head: str,
        *,
        repair_commits: Sequence[str] = (),
        status_lines: Sequence[str] = (),
        errors: Sequence[str] = (),
        prereq: Mapping[str, object] | None = None,
    ) -> RepairOutcome:
        return RepairOutcome(
            status=status,
            check_name=check_name,
            start_head=start_head,
            end_head=end_head,
            repair_commits=tuple(repair_commits),
            status_lines=tuple(status_lines),
            errors=tuple(errors),
            prereq=prereq,
        )

    def terminal_repair_outcome(
        self,
        pr: PrSnapshot,
        check_name: str,
        start_head: str,
        end_head: str,
        work_root: Path | None,
    ) -> RepairOutcome | None:
        if not hasattr(self.gh, "pr_detail"):
            return None
        detail = self.gh.pr_detail(self.repo, pr.number)
        state = str(detail.get("state") or pr.state)
        if state == "OPEN":
            return None
        self.logger.trace(
            "admin-bypass-repair-check-terminal",
            repo=self.repo,
            pr_number=pr.number,
            check_name=check_name,
            state=state,
            start_head=start_head,
            end_head=end_head,
        )
        if work_root is not None:
            hard_reset_work_root(work_root, start_head)
        return self.blocked_outcome("noop", check_name, start_head, end_head)

    def job_log_has_evidence(self, log_path: str) -> bool:
        if not log_path:
            return False
        try:
            return bool(Path(log_path).read_text(encoding="utf-8").strip())
        except OSError:
            return False

    def job_log_is_empty(self, log_path: str) -> bool:
        if not log_path:
            return False
        path = Path(log_path)
        if not path.exists():
            return False
        try:
            return not path.read_text(encoding="utf-8").strip()
        except OSError:
            return False

    def repair_check(self, pr: PrSnapshot, check_name: str, now: int | None = None) -> RepairOutcome:
        ctx = pr.checks.get(check_name)
        latest = pr.latest_mergify
        queue_only = ctx is None and is_queue_only_required_check(check_name)
        mergify_urls = mergify_check_urls(latest, check_name)
        details_url = (ctx.details_url if ctx and ctx.details_url else "") or (mergify_urls[0] if mergify_urls else "")
        start_head = pr.head_ref_oid
        if queue_only and not details_url:
            return self.blocked_outcome(
                "blocked_invalid",
                check_name,
                start_head,
                start_head,
                errors=(f"queue-only check {check_name} is missing a Mergify job URL",),
            )
        log_path = self.executor.download_job_log(self.repo, details_url, pr.number, check_name) if details_url else ""
        # "PR Body" with an empty job log is the one check that still needs a
        # local checkout before submitting anything: validate_current_pr_body
        # has no API-only equivalent. Every other check name never checks out.
        if check_name == "PR Body" and self.job_log_is_empty(log_path):
            work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
            work_root.parent.mkdir(parents=True, exist_ok=True)
            checkout_pr_head(self.repo, pr, work_root)
            checked_out_head = git_output(work_root, "rev-parse", "HEAD").strip()
            terminal = self.terminal_repair_outcome(pr, check_name, checked_out_head, checked_out_head, work_root)
            if terminal:
                return terminal
            validation = validate_current_pr_body(work_root, pr.body, pr.base_ref_name)
            if validation.get("valid"):
                self.logger.trace(
                    "admin-bypass-pr-body-valid-noop",
                    repo=self.repo,
                    pr_number=pr.number,
                    check_name=check_name,
                    head_sha=pr.head_ref_oid,
                    details_url=details_url,
                    log_path=log_path,
                )
                return self.blocked_outcome("noop", check_name, start_head, start_head)
        elif queue_only and not self.job_log_has_evidence(log_path):
            self.logger.trace(
                "admin-bypass-queue-only-empty-log-noop",
                repo=self.repo,
                pr_number=pr.number,
                check_name=check_name,
                details_url=details_url,
                log_path=log_path,
                head_sha=pr.head_ref_oid,
            )
            return self.blocked_outcome("queue_only_noop", check_name, start_head, start_head)
        else:
            terminal = self.terminal_repair_outcome(pr, check_name, start_head, start_head, None)
            if terminal:
                return terminal

        queue_pr_number = latest.queue_pr_number if latest else 0
        plan = async_repair.build_repair_check_plan(
            pr,
            check_name,
            repo=self.repo,
            details_url=details_url,
            log_path=log_path,
            queue_only=queue_only,
            queue_pr_number=queue_pr_number,
            latest=latest,
            start_head=start_head,
            state_file=self.ledger.path,
        )
        self.logger.trace(
            "admin-bypass-repair-check-start",
            repo=self.repo,
            pr_number=pr.number,
            check_name=check_name,
            details_url=details_url,
            log_path=log_path,
            head_sha=start_head,
            plan_name=plan.plan_name,
        )
        # Record before submitting: once submitted, the workflow is real and
        # running whether or not this process survives another instruction.
        # Recording first means a broken ledger write (e.g. disk full) raises
        # here and skips the submission entirely, instead of leaving a real,
        # running repair permanently invisible to the retry-cap count.
        self.ledger.record("repair-check", pr.number, start_head, check_name, now)
        async_repair.submit_async_repair_plan(plan)
        return self.blocked_outcome("submitted", check_name, start_head, start_head)

    def repair_conflict(self, pr: PrSnapshot, reason: str, now: int | None = None) -> RepairOutcome:
        check_name = "conflict"
        start_head = pr.head_ref_oid
        plan = async_repair.build_repair_conflict_plan(
            pr, reason, repo=self.repo, start_head=start_head, state_file=self.ledger.path,
        )
        self.logger.trace(
            "admin-bypass-repair-conflict-start",
            repo=self.repo,
            pr_number=pr.number,
            reason=reason,
            base_ref=pr.base_ref_name,
            head_ref=pr.head_ref_name,
            head_sha=start_head,
            plan_name=plan.plan_name,
        )
        # See repair_check: record before submitting so a broken ledger write
        # blocks the submission instead of orphaning a real, running repair.
        self.ledger.record("conflict-repair", pr.number, start_head, f"conflict:{pr.number}", now)
        async_repair.submit_async_repair_plan(plan)
        return self.blocked_outcome("submitted", check_name, start_head, start_head)

    def repair_bot_thread(self, pr: PrSnapshot, thread_id: str, now: int | None = None) -> RepairOutcome:
        start_head = pr.head_ref_oid
        plan = async_repair.build_repair_bot_thread_plan(
            pr, thread_id, repo=self.repo, start_head=start_head, state_file=self.ledger.path,
        )
        self.logger.trace(
            "admin-bypass-repair-bot-thread-start",
            repo=self.repo,
            pr_number=pr.number,
            thread_id=thread_id,
            head_sha=start_head,
            plan_name=plan.plan_name,
        )
        # See repair_check: record before submitting so a broken ledger write
        # blocks the submission instead of orphaning a real, running repair.
        self.ledger.record("repair-bot-thread", pr.number, start_head, thread_id, now)
        async_repair.submit_async_repair_plan(plan)
        return self.blocked_outcome("submitted", thread_id, start_head, start_head)
