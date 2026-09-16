from __future__ import annotations

try:
    from .mergify_admin_requeue_snapshot import GhClient
    from .mergify_admin_requeue_workflow_fastpath import submit_close_pr, submit_flag_probable_duplicate
    from .pr_duplicate_close_model import CLOSE_DUPLICATE, FLAG_DUPLICATE, LEDGER_KIND_SUBMIT, CloseAction, ledger_key
except ImportError:
    from mergify_admin_requeue_snapshot import GhClient
    from mergify_admin_requeue_workflow_fastpath import submit_close_pr, submit_flag_probable_duplicate
    from pr_duplicate_close_model import CLOSE_DUPLICATE, FLAG_DUPLICATE, LEDGER_KIND_SUBMIT, CloseAction, ledger_key


class PrDuplicateCloseExecutor:
    """The only layer allowed to submit a close. Every action is CAS-guarded
    against the state seen at scan time immediately before submission — see
    the "Executor" invariants in the plan doc. `submit_close_pr`'s generated
    task re-checks the same facts again right before the actual `gh pr close`,
    since a task can sit queued for a while after this submission.
    """

    def __init__(self, gh: GhClient, ledger, logger, repo: str):
        self.gh = gh
        self.ledger = ledger
        self.logger = logger
        self.repo = repo

    def _pr_state(self, pr_number: int) -> tuple[str, str]:
        detail = self.gh.pr_detail(self.repo, pr_number)
        state = str(detail.get("state") or "")
        head_oid = str(detail.get("headRefOid") or detail.get("head_ref_oid") or "")
        return state, head_oid

    def execute(self, action: CloseAction) -> bool:
        state, head_oid = self._pr_state(action.pr_number)
        if state != "OPEN" or head_oid != action.expected_head_oid:
            self.logger.trace(
                "pr-duplicate-close-stale-head-skip",
                repo=self.repo,
                pr_number=action.pr_number,
                reason=action.reason,
                expected_head=action.expected_head_oid,
                current_head=head_oid or None,
                current_state=state,
            )
            return False

        if action.kind == CLOSE_DUPLICATE:
            kept_state, _ = self._pr_state(action.kept_pr_number) if action.kept_pr_number is not None else ("", "")
            if kept_state != "OPEN":
                self.logger.trace(
                    "pr-duplicate-close-kept-pr-not-open-skip",
                    repo=self.repo,
                    pr_number=action.pr_number,
                    kept_pr_number=action.kept_pr_number,
                    kept_state=kept_state,
                )
                return False

        try:
            if action.kind == FLAG_DUPLICATE:
                submit_flag_probable_duplicate(
                    pr_number=action.pr_number,
                    repo=self.repo,
                    evidence=action.evidence,
                    expected_head_oid=action.expected_head_oid,
                    merged_pr_number=action.kept_pr_number,
                )
            else:
                submit_close_pr(
                    pr_number=action.pr_number,
                    repo=self.repo,
                    reason=action.evidence,
                    expected_head_oid=action.expected_head_oid,
                    kept_pr_number=action.kept_pr_number,
                )
        except RuntimeError as exc:
            self.logger.trace(
                "pr-duplicate-close-submit-failed",
                repo=self.repo,
                pr_number=action.pr_number,
                reason=action.reason,
                error=str(exc),
            )
            return False

        key = ledger_key(action.reason, action.kept_pr_number)
        self.ledger.record(LEDGER_KIND_SUBMIT, action.pr_number, action.expected_head_oid, key)
        self.logger.trace(
            "pr-duplicate-close-submitted",
            repo=self.repo,
            pr_number=action.pr_number,
            reason=action.reason,
            kept_pr_number=action.kept_pr_number,
        )
        return True
