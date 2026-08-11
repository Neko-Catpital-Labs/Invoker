from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

try:
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, PrSnapshot
    from .mergify_admin_requeue_repair_body import rebase_onto_base as run_rebase_onto_base
    from .mergify_admin_requeue_snapshot import GhClient, checkout_pr_head
except ImportError:
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, PrSnapshot
    from mergify_admin_requeue_repair_body import rebase_onto_base as run_rebase_onto_base
    from mergify_admin_requeue_snapshot import GhClient, checkout_pr_head


ADMIN_BYPASS_NUDGE_LEDGER_KIND = "comment-admin-bypass-nudge"
RESTORE_ADMIN_BYPASS_LABEL_LEDGER_KIND = "restore-admin-bypass-label"


def admin_bypass_nudge_body() -> str:
    return (
        "Invoker Mergify babysitting is paused: this is the current bottom PR in the stack, "
        "but it is missing the `admin-bypass` label. Please tag this PR with `admin-bypass` "
        "before babysitting can continue."
    )


class AdminBypassGhExecutor:
    def __init__(self, gh: GhClient, ledger: Ledger, logger: AdminBypassLogger, repo: str):
        self.gh = gh
        self.ledger = ledger
        self.logger = logger
        self.repo = repo

    def pr_head_is_current(self, pr: PrSnapshot, action_kind: str, key: str) -> bool:
        if not pr.head_ref_oid or not hasattr(self.gh, "pr_detail"):
            return True
        detail = self.gh.pr_detail(self.repo, pr.number)
        state = str(detail.get("state") or pr.state)
        current = str(detail.get("headRefOid") or detail.get("head_ref_oid") or "")
        if state == "OPEN" and current == pr.head_ref_oid:
            return True
        self.logger.trace(
            "admin-bypass-stale-head-skip",
            repo=self.repo,
            pr_number=pr.number,
            action_kind=action_kind,
            key=key,
            expected_head=pr.head_ref_oid,
            current_head=current or None,
            current_state=state,
        )
        return False

    def download_job_log(self, repo: str, details_url: str, pr_number: int, check_name: str) -> str:
        match = GH_ACTIONS_JOB_RE.search(details_url)
        if not match:
            return ""
        tmp = Path(tempfile.mkdtemp(prefix=f"mergify-admin-requeue-{pr_number}-"))
        path = tmp / (re.sub(r"[^A-Za-z0-9_.-]+", "-", check_name).strip("-") + ".log")
        out = subprocess.run(
            ["gh", "run", "view", "--repo", repo, "--job", match.group(1), "--log"],
            check=True,
            text=True,
            capture_output=True,
        ).stdout
        path.write_text(out, encoding="utf-8")
        return str(path)

    def requeue(self, pr: PrSnapshot, key: str, now: int) -> None:
        self.gh.comment(self.repo, pr.number, "@mergifyio queue")
        self.ledger.record("requeue", pr.number, pr.head_ref_oid, key, now)

    def refresh_stale_queue(self, pr: PrSnapshot, key: str, now: int) -> None:
        self.gh.comment(self.repo, pr.number, "@mergifyio refresh")
        self.ledger.record("refresh-stale-queue", pr.number, pr.head_ref_oid, key, now)

    def restore_admin_bypass_label(self, pr: PrSnapshot, now: int) -> None:
        if self.ledger.count(RESTORE_ADMIN_BYPASS_LABEL_LEDGER_KIND, pr.number, pr.head_ref_oid, "admin-bypass") == 0:
            self.gh.edit_label(self.repo, pr.number, add="admin-bypass")
            self.ledger.record(RESTORE_ADMIN_BYPASS_LABEL_LEDGER_KIND, pr.number, pr.head_ref_oid, "admin-bypass", now)

    def retarget_base(self, pr: PrSnapshot, new_base: str, now: int) -> None:
        self.gh.retarget_base(self.repo, pr.number, new_base)
        self.ledger.record("retarget-base", pr.number, pr.head_ref_oid, f"{pr.base_ref_name}->{new_base}", now)

    def rebase_onto_base(self, pr: PrSnapshot, new_base: str, now: int) -> bool:
        work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
        work_root.parent.mkdir(parents=True, exist_ok=True)
        checkout_pr_head(self.repo, pr, work_root)
        new_head = run_rebase_onto_base(work_root, new_base, pr.head_ref_name, pr.head_ref_oid)
        if new_head is None:
            self.ledger.record("rebase-onto-base-conflict", pr.number, pr.head_ref_oid, new_base, now)
            return False
        self.ledger.record("rebase-onto-base", pr.number, pr.head_ref_oid, new_base, now, meta={"newHead": new_head})
        return True

    def comment_admin_bypass_nudge(self, pr: PrSnapshot, key: str, now: int) -> None:
        if self.ledger.count(ADMIN_BYPASS_NUDGE_LEDGER_KIND, pr.number, pr.head_ref_oid, key) == 0:
            self.gh.comment(self.repo, pr.number, admin_bypass_nudge_body())
            self.ledger.record(ADMIN_BYPASS_NUDGE_LEDGER_KIND, pr.number, pr.head_ref_oid, key, now)

    def remove_merge_hold(self, pr: PrSnapshot, now: int) -> None:
        self.gh.edit_label(self.repo, pr.number, remove="merge-hold")
        self.ledger.record("remove-merge-hold", pr.number, pr.head_ref_oid, "merge-hold", now)

    def resolve_bot_threads(self, thread_id: str) -> None:
        self.gh.resolve_review_thread(thread_id)

    def has_blocked_comment(self, pr: PrSnapshot | int, body_or_detail: str) -> bool:
        if not hasattr(self.gh, "issue_comments"):
            return False
        if isinstance(pr, PrSnapshot):
            pr_number = pr.number
            body = body_or_detail.strip()
        else:
            pr_number = pr
            body = f"Mergify repair stopped: {body_or_detail}".strip()
        for comment in self.gh.issue_comments(self.repo, pr_number):
            if str(comment.get("body") or "").strip() == body:
                return True
        return False

    def comment_blocked(self, pr: PrSnapshot, detail: str, key: str, now: int) -> None:
        if self.ledger.count("comment-blocked", pr.number, pr.head_ref_oid, key) == 0:
            body = f"Mergify repair stopped: {detail}"
            if not self.has_blocked_comment(pr, body):
                self.gh.comment(self.repo, pr.number, body)
            self.ledger.record("comment-blocked", pr.number, pr.head_ref_oid, key, now, meta={"detail": detail})
            return
        if (
            key == "no-current-bottom"
            and detail != "no current bottom on master"
            and not self.has_blocked_comment(pr.number, detail)
        ):
            self.gh.comment(self.repo, pr.number, f"Mergify repair stopped: {detail}")
            self.ledger.record(
                "comment-blocked",
                pr.number,
                pr.head_ref_oid,
                "no-current-bottom:exact",
                now,
                meta={"detail": detail},
            )

    def execute(self, action: Action, pr: PrSnapshot, now: int) -> bool:
        self.logger.trace("admin-bypass-action-execute", action=self.logger.action_payload(action))
        if action.kind in {
            "requeue",
            "refresh_stale_queue",
            "restore_admin_bypass_label",
            "retarget_base",
            "comment_admin_bypass_nudge",
            "remove_merge_hold",
            "resolve_bot_threads",
            "comment_blocked",
        } and not self.pr_head_is_current(pr, action.kind, action.key):
            return False
        if action.kind == "requeue":
            self.requeue(pr, action.key, now)
            return True
        if action.kind == "refresh_stale_queue":
            self.refresh_stale_queue(pr, action.key, now)
            return True
        if action.kind == "restore_admin_bypass_label":
            self.restore_admin_bypass_label(pr, now)
            return True
        if action.kind == "retarget_base":
            self.retarget_base(pr, action.key, now)
            return True
        if action.kind == "comment_admin_bypass_nudge":
            self.comment_admin_bypass_nudge(pr, action.key, now)
            return True
        if action.kind == "remove_merge_hold":
            self.remove_merge_hold(pr, now)
            return True
        if action.kind == "resolve_bot_threads":
            self.resolve_bot_threads(action.key)
            return True
        if action.kind == "comment_blocked":
            key = f"capped:{action.detail}" if action.key == "capped" else action.key
            self.comment_blocked(pr, action.detail, key, now)
            return True
        raise ValueError(f"unsupported executor action: {action.kind}")
