from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path

try:
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, PrSnapshot
    from .mergify_admin_requeue_snapshot import GhClient
except ImportError:
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, PrSnapshot
    from mergify_admin_requeue_snapshot import GhClient


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

    def restore_admin_bypass_label(self, pr: PrSnapshot, now: int) -> None:
        if self.ledger.count(RESTORE_ADMIN_BYPASS_LABEL_LEDGER_KIND, pr.number, pr.head_ref_oid, "admin-bypass") == 0:
            self.gh.edit_label(self.repo, pr.number, add="admin-bypass")
            self.ledger.record(RESTORE_ADMIN_BYPASS_LABEL_LEDGER_KIND, pr.number, pr.head_ref_oid, "admin-bypass", now)

    def comment_admin_bypass_nudge(self, pr: PrSnapshot, key: str, now: int) -> None:
        if self.ledger.count(ADMIN_BYPASS_NUDGE_LEDGER_KIND, pr.number, pr.head_ref_oid, key) == 0:
            self.gh.comment(self.repo, pr.number, admin_bypass_nudge_body())
            self.ledger.record(ADMIN_BYPASS_NUDGE_LEDGER_KIND, pr.number, pr.head_ref_oid, key, now)

    def remove_merge_hold(self, pr: PrSnapshot, now: int) -> None:
        self.gh.edit_label(self.repo, pr.number, remove="merge-hold")
        self.ledger.record("remove-merge-hold", pr.number, pr.head_ref_oid, "merge-hold", now)

    def resolve_bot_threads(self, thread_id: str) -> None:
        self.gh.resolve_review_thread(thread_id)

    def has_blocked_comment(self, pr: PrSnapshot, body: str) -> bool:
        if not hasattr(self.gh, "issue_comments"):
            return False
        for comment in self.gh.issue_comments(self.repo, pr.number):
            if str(comment.get("body") or "").strip() == body.strip():
                return True
        return False

    def comment_blocked(self, pr: PrSnapshot, detail: str, key: str, now: int) -> None:
        if self.ledger.count("comment-blocked", pr.number, pr.head_ref_oid, key) == 0:
            body = f"Mergify repair stopped: {detail}"
            if not self.has_blocked_comment(pr, body):
                self.gh.comment(self.repo, pr.number, body)
            self.ledger.record("comment-blocked", pr.number, pr.head_ref_oid, key, now)

    def execute(self, action: Action, pr: PrSnapshot, now: int) -> None:
        self.logger.trace("admin-bypass-action-execute", action=self.logger.action_payload(action))
        if action.kind == "requeue":
            self.requeue(pr, action.key, now)
            return
        if action.kind == "restore_admin_bypass_label":
            self.restore_admin_bypass_label(pr, now)
            return
        if action.kind == "comment_admin_bypass_nudge":
            self.comment_admin_bypass_nudge(pr, action.key, now)
            return
        if action.kind == "remove_merge_hold":
            self.remove_merge_hold(pr, now)
            return
        if action.kind == "resolve_bot_threads":
            self.resolve_bot_threads(action.key)
            return
        if action.kind == "comment_blocked":
            if action.key == "capped":
                key = f"capped:{action.detail}"
                self.comment_blocked(pr, action.detail, key, now)
            return
        raise ValueError(f"unsupported executor action: {action.kind}")
