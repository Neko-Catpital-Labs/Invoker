from __future__ import annotations

import dataclasses
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

try:
    from .mergify_admin_requeue_headless_shell import run_headless
    from .mergify_admin_requeue_model import MergifyQueueEvent, PrSnapshot
except ImportError:
    from mergify_admin_requeue_headless_shell import run_headless
    from mergify_admin_requeue_model import MergifyQueueEvent, PrSnapshot


REPO_ROOT = Path(__file__).resolve().parents[1]

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str, *, max_len: int = 40) -> str:
    slug = _SLUG_RE.sub("-", value.lower()).strip("-")
    return (slug or "check")[:max_len].strip("-") or "check"


# Shared with mergify_admin_requeue_infra_signal.py, which needs the exact
# plan_name a build_repair_*_plan call below already produced, to look up that
# same submission's Invoker workflow by name before deciding whether to submit
# another one.
def repair_check_plan_name(pr_number: int, check_name: str, start_head: str) -> str:
    return f"admin-bypass-repair-check-pr-{pr_number}-{_slugify(check_name)}-{start_head[:7]}"


def repair_conflict_plan_name(pr_number: int, start_head: str) -> str:
    # Legacy name kept for settling pre-unification conflict-repair ledger rows.
    return f"admin-bypass-repair-conflict-pr-{pr_number}-{start_head[:7]}"


def rebase_onto_master_plan_name(pr_number: int, start_head: str) -> str:
    return f"admin-bypass-rebase-onto-master-pr-{pr_number}-{start_head[:7]}"


def repair_bot_thread_plan_name(pr_number: int, start_head: str) -> str:
    return f"admin-bypass-repair-bot-thread-pr-{pr_number}-{start_head[:7]}"


def _yaml_str(value: str) -> str:
    # JSON string encoding is a valid YAML flow scalar and, unlike naive shell
    # quoting, correctly escapes quotes/colons/backslashes in PR titles/branch
    # names without a second layer of ad-hoc stripping.
    return json.dumps(value)


def _indent_block(text: str, spaces: int) -> str:
    prefix = " " * spaces
    lines = text.splitlines() or [""]
    return "\n".join(prefix + line if line else prefix.rstrip() for line in lines)


def _repo_url(repo: str) -> str:
    return f"https://github.com/{repo}.git"


@dataclass(frozen=True)
class AsyncRepairPlan:
    plan_name: str
    yaml_text: str


@dataclass(frozen=True)
class RepairSubmissionAcknowledgement:
    workflow_id: str | None = None


_WORKFLOW_ID_RE = re.compile(r"(?:Workflow ID:|workflow:)\s*(wf-[^\s]+)")


def _write_plan_header(*, name: str, base_branch: str, repo: str, merge_mode: str = "manual") -> str:
    return (
        f"name: {name}\n"
        "onFinish: none\n"
        f"mergeMode: {merge_mode}\n"
        f"repoUrl: {_yaml_str(_repo_url(repo))}\n"
        f"baseBranch: {_yaml_str(base_branch)}\n"
        "tasks:\n"
    )


def _repair_task_yaml(*, description: str, prompt: str, max_turns: int | None = 30) -> str:
    max_turns_line = f"    maxTurns: {max_turns}\n" if max_turns is not None else ""
    return (
        "  - id: repair\n"
        f"    description: {_yaml_str(description)}\n"
        f"{max_turns_line}"
        "    prompt: |\n"
        f"{_indent_block(prompt, 6)}\n"
    )


def _foreign_safe_push_command(*, head_ref: str, start_head: str, skip_guard: str) -> str:
    # A foreign worktree never has Invoker's own scripts/pr_worker_safe_push.py
    # (that script lives only in the Invoker checkout). Reimplement its
    # expected-head safety check inline with plain git so the push still
    # refuses to run if the branch moved since this repair started.
    return (
        "set -euo pipefail\n"
        f"{skip_guard}"
        f"git fetch origin {_shlex(head_ref)}\n"
        f"current_head=\"$(git rev-parse origin/{head_ref})\"\n"
        f"if [ \"$current_head\" != {_shlex(start_head)} ]; then\n"
        f"  echo \"refusing to push: {head_ref} moved from {start_head} to $current_head\" >&2\n"
        "  exit 1\n"
        "fi\n"
        f"git push origin HEAD:{_shlex(head_ref)}\n"
    )


def _safe_push_task_yaml(
    *,
    task_id: str,
    description: str,
    dependencies: str,
    head_ref: str,
    start_head: str,
    skip_if_prereq: bool,
    foreign: bool = False,
) -> str:
    skip_guard = (
        "if [ -f .invoker-repair-prereq-created ]; then\n"
        "  echo \"prerequisite PR already published this attempt; nothing to push\"\n"
        "  exit 0\n"
        "fi\n"
        if skip_if_prereq
        else ""
    )
    if foreign:
        command = _foreign_safe_push_command(head_ref=head_ref, start_head=start_head, skip_guard=skip_guard)
    else:
        # Owner-side JSONL settlement is recorded by mergify_admin_requeue_workflow_fastpath
        # from durable workflow/task state. Never pass the owner machine's ledger path into
        # a remote worker command (Linux workers cannot write /Users/... paths).
        command = (
            "set -euo pipefail\n"
            f"{skip_guard}"
            "python3 scripts/pr_worker_safe_push.py \\\n"
            f"  --branch {_shlex(head_ref)} --expected-head {_shlex(start_head)} --cwd .\n"
        )
    return (
        f"  - id: {task_id}\n"
        f"    description: {_yaml_str(description)}\n"
        f"    dependencies: [{dependencies}]\n"
        "    command: |\n"
        f"{_indent_block(command, 6)}\n"
    )


def _shlex(value: str) -> str:
    # Minimal POSIX single-quote wrap; values here are SHAs, branch names, and
    # our own ledger paths/kinds -- none contain single quotes in practice, but
    # this keeps the generated command block safe regardless.
    return "'" + value.replace("'", "'\\''") + "'"


_JOB_LOG_EXCERPT_MAX_CHARS = 20000


def _job_log_excerpt(log_path: str) -> str:
    # log_path (from GhExecutor.download_job_log) is a local tempfile on the
    # orchestrator's own machine. submit_async_repair_plan dispatches this
    # prompt to Invoker's headless runner, which executes on a separate
    # worker that does not share that filesystem, so the path itself would
    # not resolve there -- inline the tail of the log content instead.
    if not log_path:
        return "(not available)"
    try:
        text = Path(log_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "(not available)"
    if not text:
        return "(empty)"
    return text[-_JOB_LOG_EXCERPT_MAX_CHARS:]


def build_repair_check_plan(
    pr: PrSnapshot,
    check_name: str,
    *,
    repo: str,
    details_url: str,
    log_path: str,
    queue_only: bool,
    queue_pr_number: int,
    latest: MergifyQueueEvent | None,
    start_head: str,
    state_file: Path,
    foreign: bool = False,
) -> AsyncRepairPlan:
    name = repair_check_plan_name(pr.number, check_name, start_head)
    prompt = (
        "This PR's CI check is failing. Diagnose why it is failing, then fix it. Add or "
        "update a repro if the failure is reproducible.\n\n"
        "If a code change fixes it: make the change in this checkout. Commit locally if "
        "needed, do not push. If local proof shows the check is already green on the "
        "current head, make no commit and exit 0.\n\n"
        f"Repair the existing pull request #{pr.number} ({json.dumps(pr.title)}) on {repo}.\n"
        f"PR URL: {pr.url}\n"
        f"Head branch: {pr.head_ref_name} (at {start_head}), base branch: {pr.base_ref_name}\n\n"
        "Work directly on its branch:\n"
        f"  git fetch origin {pr.head_ref_name} && git checkout {pr.head_ref_name}\n\n"
        f"Failed check: {check_name}\n"
        f"Details URL: {details_url}\n"
        f"Job log (tail):\n{_job_log_excerpt(log_path)}\n"
        f"Latest Mergify event: {json.dumps(dataclasses.asdict(latest) if latest else None, sort_keys=True)}\n"
    )
    if queue_only:
        prompt += f"Queue draft PR: #{queue_pr_number}\nRepair the real PR head, using only evidence from the queue draft failure.\n"

    yaml_text = _write_plan_header(name=name, base_branch=pr.base_ref_name, repo=repo)
    yaml_text += _repair_task_yaml(description=f"Repair PR #{pr.number} (failed check {check_name})", prompt=prompt)
    if foreign:
        # A foreign worktree never has Invoker's own
        # mergify_admin_requeue_repair_normalize.py (prerequisite-PR splitting
        # is an Invoker-repo-only concept), so go straight from repair to a
        # plain safe push instead of running that Invoker-only normalize step.
        yaml_text += _safe_push_task_yaml(
            task_id="safe-push",
            description=f"Safely push PR #{pr.number} only if its head did not move",
            dependencies="repair",
            head_ref=pr.head_ref_name,
            start_head=start_head,
            skip_if_prereq=False,
            foreign=True,
        )
        return AsyncRepairPlan(plan_name=name, yaml_text=yaml_text)
    normalize_command = (
        "set -euo pipefail\n"
        "python3 -B scripts/mergify_admin_requeue_repair_normalize.py \\\n"
        f"  --repo {_shlex(repo)} --pr {pr.number} --check {_shlex(check_name)} \\\n"
        f"  --start-head {_shlex(start_head)} --base {_shlex(pr.base_ref_name)} --trunk master\n"
    )
    yaml_text += (
        "  - id: normalize\n"
        f"    description: {_yaml_str(f'Normalize PR #{pr.number} repair commit; split a prerequisite PR if required')}\n"
        "    dependencies: [repair]\n"
        "    command: |\n"
        f"{_indent_block(normalize_command, 6)}\n"
    )
    yaml_text += _safe_push_task_yaml(
        task_id="safe-push",
        description=f"Safely push PR #{pr.number} only if its head did not move and no prerequisite was split",
        dependencies="normalize",
        head_ref=pr.head_ref_name,
        start_head=start_head,
        skip_if_prereq=True,
    )
    return AsyncRepairPlan(plan_name=name, yaml_text=yaml_text)


def _rebase_onto_master_prompt(pr: PrSnapshot, reason: str, start_head: str, *, onto: str | None = None) -> str:
    onto_ref = onto or pr.base_ref_name or "master"
    return (
        f"Rebase this pull request onto `{onto_ref}`.\n\n"
        f"Checkout the PR head branch, rebase it onto origin/{onto_ref} while preserving the PR's intended "
        "changes, resolve any conflicts if they appear, then commit locally. Do not push.\n\n"
        "If the PR is already closed or merged, or the head branch no longer exists, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nBase branch: {pr.base_ref_name}\nHead branch: {pr.head_ref_name}\n"
        f"Head SHA: {start_head}\nRebase onto: {onto_ref}\nReason: {reason}\n"
        f"Work directly on its branch:\n"
        f"  git fetch origin {pr.head_ref_name} {onto_ref} && git checkout {pr.head_ref_name}\n"
        f"  git rebase origin/{onto_ref}\n"
    )


def build_rebase_onto_master_plan(
    pr: PrSnapshot,
    reason: str,
    *,
    repo: str,
    start_head: str,
    state_file: Path,
    foreign: bool = False,
) -> AsyncRepairPlan:
    onto_ref = pr.base_ref_name or "master"
    name = rebase_onto_master_plan_name(pr.number, start_head)
    prompt = _rebase_onto_master_prompt(pr, reason, start_head, onto=onto_ref)
    yaml_text = _write_plan_header(name=name, base_branch=pr.base_ref_name, repo=repo)
    yaml_text += _repair_task_yaml(
        description=f"Rebase PR #{pr.number} onto {onto_ref}",
        prompt=prompt,
    )
    yaml_text += _safe_push_task_yaml(
        task_id="safe-push",
        description=f"Safely push PR #{pr.number} only if its head did not move",
        dependencies="repair",
        head_ref=pr.head_ref_name,
        start_head=start_head,
        skip_if_prereq=False,
        foreign=foreign,
    )
    return AsyncRepairPlan(plan_name=name, yaml_text=yaml_text)


def build_repair_bot_thread_plan(
    pr: PrSnapshot,
    thread_id: str,
    *,
    repo: str,
    start_head: str,
    state_file: Path,
    foreign: bool = False,
) -> AsyncRepairPlan:
    name = repair_bot_thread_plan_name(pr.number, start_head)
    prompt = (
        f"Resolve the unresolved review thread {thread_id}. Address the reviewer's feedback with "
        "real code changes, run the narrow proof for the fix, then commit locally. Do not push. "
        "If the thread is already resolved, or the PR is closed or merged, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nHead branch: {pr.head_ref_name}\nHead SHA: {start_head}\nThread: {thread_id}\n"
    )
    yaml_text = _write_plan_header(
        name=name, base_branch=pr.base_ref_name, repo=repo, merge_mode="external_review"
    )
    yaml_text += _repair_task_yaml(description=f"Resolve bot review thread on PR #{pr.number}", prompt=prompt)
    yaml_text += _safe_push_task_yaml(
        task_id="safe-push",
        description=f"Safely push PR #{pr.number} only if its head did not move",
        dependencies="repair",
        head_ref=pr.head_ref_name,
        start_head=start_head,
        skip_if_prereq=False,
        foreign=foreign,
    )
    return AsyncRepairPlan(plan_name=name, yaml_text=yaml_text)


def submit_async_repair_plan(plan: AsyncRepairPlan) -> RepairSubmissionAcknowledgement:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".yaml", prefix=f"{plan.plan_name}-", delete=False
    ) as handle:
        handle.write(plan.yaml_text)
        plan_path = Path(handle.name)
    try:
        submit_cmd = os.environ.get("INVOKER_ADMIN_BYPASS_ASYNC_REPAIR_SUBMIT_CMD")
        if submit_cmd:
            completed = run_headless('"$2" "$3" "$4"', submit_cmd, str(plan_path), plan.plan_name)
        else:
            completed = run_headless('headless_mutation --no-track run "$2"', str(plan_path))
        if completed.returncode != 0:
            raise RuntimeError(
                f"submit_async_repair_plan failed for {plan.plan_name}: "
                f"{completed.stderr.strip() or completed.stdout.strip()}"
            )
        match = _WORKFLOW_ID_RE.search(completed.stdout)
        return RepairSubmissionAcknowledgement(workflow_id=match.group(1) if match else None)
    finally:
        plan_path.unlink(missing_ok=True)
