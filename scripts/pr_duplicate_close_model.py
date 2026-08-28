from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CandidatePr:
    number: int
    title: str
    url: str
    state: str
    is_draft: bool
    head_ref_name: str
    base_ref_name: str
    head_ref_oid: str


@dataclass(frozen=True)
class GitFacts:
    # Always origin/master-relative (the "landed" signals). Same-diff
    # duplicate comparison uses a separate, per-PR-base patch-id instead --
    # see pr_duplicate_close_exec.py's _compute_patch_id.
    merge_base_sha: str | None
    is_ancestor: bool
    is_empty_diff: bool
    all_commits_equivalent: bool
    is_rebase_equivalent: bool = False
    has_conflict: bool = False


LANDED_ANCESTOR = "landed:ancestor"
LANDED_EMPTY_DIFF = "landed:empty-diff"
LANDED_PATCH_EQUIVALENT = "landed:patch-equivalent"
LANDED_REBASE_EQUIVALENT = "landed:rebase-equivalent"
DUPLICATE_SAME_BRANCH = "duplicate:same-branch"
DUPLICATE_SAME_DIFF = "duplicate:same-diff"
DUPLICATE_TITLE_COLLISION_MERGED = "duplicate:title-collision-merged"

CLOSE_LANDED = "close_landed"
CLOSE_DUPLICATE = "close_duplicate"
FLAG_DUPLICATE = "flag_duplicate"


@dataclass(frozen=True)
class CloseAction:
    kind: str  # CLOSE_LANDED | CLOSE_DUPLICATE | FLAG_DUPLICATE
    pr_number: int
    expected_head_oid: str
    reason: str  # one of the *_* signal constants above
    evidence: str  # human-readable detail for the close comment
    kept_pr_number: int | None = None  # set only for CLOSE_DUPLICATE


@dataclass(frozen=True)
class DuplicateGroup:
    reason: str  # DUPLICATE_SAME_BRANCH | DUPLICATE_SAME_DIFF
    kept_pr_number: int
    closed_pr_numbers: tuple[int, ...]


LEDGER_KIND_SUBMIT = "pr-duplicate-close-submit"


def ledger_key(reason: str, kept_pr_number: int | None) -> str:
    return f"{reason}:{kept_pr_number}" if kept_pr_number is not None else reason
