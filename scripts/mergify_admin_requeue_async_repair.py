from __future__ import annotations

import dataclasses
import json
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
    return f"admin-bypass-repair-conflict-pr-{pr_number}-{start_head[:7]}"


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


def _write_plan_header(*, name: str, base_branch: str, repo: str) -> str:
    return (
        f"name: {name}\n"
        "onFinish: none\n"
        "mergeMode: manual\n"
        f"repoUrl: {_yaml_str(_repo_url(repo))}\n"
        f"baseBranch: {_yaml_str(base_branch)}\n"
        "tasks:\n"
    )


def _repair_task_yaml(*, description: str, prompt: str) -> str:
    return (
        "  - id: repair\n"
        f"    description: {_yaml_str(description)}\n"
        "    prompt: |\n"
        f"{_indent_block(prompt, 6)}\n"
    )


def _safe_push_task_yaml(
    *,
    task_id: str,
    description: str,
    dependencies: str,
    head_ref: str,
    start_head: str,
    state_file: Path,
    json_kind: str,
    pr_number: int,
    json_key: str,
    skip_if_prereq: bool,
) -> str:
    skip_guard = (
        "if [ -f .invoker-repair-prereq-created ]; then\n"
        "  echo \"prerequisite PR already published this attempt; nothing to push\"\n"
        "  exit 0\n"
        "fi\n"
        if skip_if_prereq
        else ""
    )
    command = (
        "set -euo pipefail\n"
        f"{skip_guard}"
        "python3 scripts/pr_worker_safe_push.py \\\n"
        f"  --branch {_shlex(head_ref)} --expected-head {_shlex(start_head)} --cwd . \\\n"
        f"  --record-json-ledger {_shlex(str(state_file))} \\\n"
        f"  --json-kind {_shlex(json_kind)} --json-pr {_shlex(str(pr_number))} \\\n"
        f"  --json-head-sha {_shlex(start_head)} --json-key {_shlex(json_key)}\n"
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


_RESTRUCTURE_ESCAPE_HATCH = (
    "If the real fix requires restructuring this PR instead of editing it in place -- for example, splitting "
    "unrelated files into their own PR because they can't ship together -- do not force that into a single "
    "local commit here. Instead, submit an Invoker plan to do the restructuring, the same way a human would "
    "via the plan-to-invoker skill (see skills/plan-to-invoker/SKILL.md and ./submit-plan.sh). Then make no "
    "commit in this checkout and exit 0.\n"
)


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
) -> AsyncRepairPlan:
    name = repair_check_plan_name(pr.number, check_name, start_head)
    prompt = (
        "This PR's CI check is failing. Diagnose why it is failing, then fix it. Add or "
        "update a repro if the failure is reproducible.\n\n"
        "If a code change fixes it: make the change in this checkout. Commit locally if "
        "needed, do not push. If local proof shows the check is already green on the "
        "current head, make no commit and exit 0.\n\n"
        f"{_RESTRUCTURE_ESCAPE_HATCH}\n"
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
    normalize_command = (
        "set -euo pipefail\n"
        "python3 scripts/mergify_admin_requeue_repair_normalize.py \\\n"
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
        state_file=state_file,
        json_kind="repair-check-settled",
        pr_number=pr.number,
        json_key=check_name,
        skip_if_prereq=True,
    )
    return AsyncRepairPlan(plan_name=name, yaml_text=yaml_text)


def build_repair_conflict_plan(
    pr: PrSnapshot,
    reason: str,
    *,
    repo: str,
    start_head: str,
    state_file: Path,
) -> AsyncRepairPlan:
    name = repair_conflict_plan_name(pr.number, start_head)
    prompt = (
        "This PR has a merge conflict blocking it from merging. Diagnose why, then fix it.\n\n"
        "If rebasing the head branch onto its base branch (preserving the PR's intended changes) resolves it: "
        "do that, run the narrow proof for the conflict resolution, then commit locally. Do not push.\n\n"
        "If the real fix requires restructuring this PR instead of a straightforward rebase, do not force that "
        "into a single local commit here. Instead, submit an Invoker plan to do the restructuring, the same way "
        "a human would via the plan-to-invoker skill (see skills/plan-to-invoker/SKILL.md and ./submit-plan.sh). "
        "Then make no commit in this checkout and exit 0.\n\n"
        "If the PR is already closed or merged, or the head branch no longer exists, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nBase branch: {pr.base_ref_name}\nHead branch: {pr.head_ref_name}\n"
        f"Head SHA: {start_head}\nReason: {reason}\n"
    )
    yaml_text = _write_plan_header(name=name, base_branch=pr.base_ref_name, repo=repo)
    yaml_text += _repair_task_yaml(description=f"Repair merge conflict on PR #{pr.number}", prompt=prompt)
    yaml_text += _safe_push_task_yaml(
        task_id="safe-push",
        description=f"Safely push PR #{pr.number} only if its head did not move",
        dependencies="repair",
        head_ref=pr.head_ref_name,
        start_head=start_head,
        state_file=state_file,
        json_kind="conflict-repair-settled",
        pr_number=pr.number,
        json_key=f"conflict:{pr.number}",
        skip_if_prereq=False,
    )
    return AsyncRepairPlan(plan_name=name, yaml_text=yaml_text)


def build_repair_bot_thread_plan(
    pr: PrSnapshot,
    thread_id: str,
    *,
    repo: str,
    start_head: str,
    state_file: Path,
) -> AsyncRepairPlan:
    name = repair_bot_thread_plan_name(pr.number, start_head)
    prompt = (
        f"Resolve the unresolved review thread {thread_id}. Address the reviewer's feedback with "
        "real code changes, run the narrow proof for the fix, then commit locally. Do not push. "
        "If the thread is already resolved, or the PR is closed or merged, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nHead branch: {pr.head_ref_name}\nHead SHA: {start_head}\nThread: {thread_id}\n"
    )
    yaml_text = _write_plan_header(name=name, base_branch=pr.base_ref_name, repo=repo)
    yaml_text += _repair_task_yaml(description=f"Resolve bot review thread on PR #{pr.number}", prompt=prompt)
    yaml_text += _safe_push_task_yaml(
        task_id="safe-push",
        description=f"Safely push PR #{pr.number} only if its head did not move",
        dependencies="repair",
        head_ref=pr.head_ref_name,
        start_head=start_head,
        state_file=state_file,
        json_kind="repair-bot-thread-settled",
        pr_number=pr.number,
        json_key=thread_id,
        skip_if_prereq=False,
    )
    return AsyncRepairPlan(plan_name=name, yaml_text=yaml_text)


def submit_async_repair_plan(plan: AsyncRepairPlan) -> None:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".yaml", prefix=f"{plan.plan_name}-", delete=False
    ) as handle:
        handle.write(plan.yaml_text)
        plan_path = Path(handle.name)
    try:
        completed = run_headless('headless_mutation --no-track run "$2"', str(plan_path))
        if completed.returncode != 0:
            raise RuntimeError(
                f"submit_async_repair_plan failed for {plan.plan_name}: "
                f"{completed.stderr.strip() or completed.stdout.strip()}"
            )
    finally:
        plan_path.unlink(missing_ok=True)
