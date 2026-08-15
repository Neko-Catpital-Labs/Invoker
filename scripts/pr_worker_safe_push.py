#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Mapping, Sequence


SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
DEFAULT_JSON_LEDGER_RELATIVE_PATH = Path(".invoker/mergify-admin-requeue-state.jsonl")


class SafePushError(RuntimeError):
    def __init__(self, message: str, *, exit_code: int = 1):
        super().__init__(message)
        self.exit_code = exit_code


def run_git(args: Sequence[str], *, cwd: Path | str | None = None) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd is not None else None,
        check=False,
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        details = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
        raise SafePushError(
            f"git {' '.join(args)} failed with exit code {completed.returncode}"
            + (f":\n{details}" if details else ""),
            exit_code=completed.returncode,
        )
    return completed.stdout.strip()


def normalize_branch(branch: str) -> str:
    name = branch.removeprefix("refs/heads/").strip()
    if not name:
        raise SafePushError("branch is required")
    try:
        run_git(["check-ref-format", "--branch", name])
    except SafePushError as exc:
        raise SafePushError(f"invalid branch name {branch!r}: {exc}", exit_code=2) from exc
    return name


def validate_expected_head(expected_head: str) -> str:
    value = expected_head.strip()
    if not SHA_RE.fullmatch(value):
        raise SafePushError(f"expected head must be a 40-character SHA, got {expected_head!r}", exit_code=2)
    return value.lower()


def remote_branch_sha(branch: str, *, remote: str = "origin", cwd: Path | str | None = None) -> str | None:
    ref = f"refs/heads/{normalize_branch(branch)}"
    out = run_git(["ls-remote", remote, ref], cwd=cwd)
    if not out:
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == ref:
            return parts[0].lower()
    return None


def local_head(*, cwd: Path | str | None = None) -> str:
    head = run_git(["rev-parse", "HEAD"], cwd=cwd).strip().lower()
    if not SHA_RE.fullmatch(head):
        raise SafePushError(f"local HEAD is not a 40-character SHA: {head!r}", exit_code=2)
    return head


def terminal_pr_state_if_unchanged(
    *,
    pr_number: int,
    branch: str,
    expected_head: str,
    cwd: Path | str | None = None,
) -> str | None:
    completed = subprocess.run(
        [
            "gh",
            "pr",
            "view",
            str(pr_number),
            "--json",
            "state,headRefName,headRefOid",
        ],
        cwd=str(cwd) if cwd is not None else None,
        check=False,
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        details = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
        raise SafePushError(
            f"could not verify terminal state for PR #{pr_number}"
            + (f":\n{details}" if details else ""),
            exit_code=completed.returncode,
        )
    try:
        detail = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise SafePushError(f"invalid GitHub response for PR #{pr_number}: {exc}", exit_code=2) from exc
    if not isinstance(detail, dict):
        raise SafePushError(f"invalid GitHub response for PR #{pr_number}: expected an object", exit_code=2)

    state = str(detail.get("state") or "").upper()
    if state == "OPEN":
        return None
    if state not in {"CLOSED", "MERGED"}:
        raise SafePushError(f"invalid GitHub state for PR #{pr_number}: {state or 'missing'}", exit_code=2)

    branch_name = normalize_branch(branch)
    live_branch = str(detail.get("headRefName") or "")
    if live_branch != branch_name:
        raise SafePushError(
            f"stale-head: PR #{pr_number} head branch is {live_branch or 'missing'}; expected {branch_name}",
            exit_code=20,
        )
    expected = validate_expected_head(expected_head)
    live_head = str(detail.get("headRefOid") or "").lower()
    if live_head != expected:
        raise SafePushError(
            f"stale-head: PR #{pr_number} head is {live_head or 'missing'}; expected {expected}",
            exit_code=20,
        )
    return state


def safe_push(
    *,
    branch: str,
    expected_head: str | None = None,
    expect_missing: bool = False,
    remote: str = "origin",
    cwd: Path | str | None = None,
) -> str:
    branch_name = normalize_branch(branch)
    if expect_missing and expected_head is not None:
        raise SafePushError("--expect-missing cannot be combined with --expected-head", exit_code=2)
    expected = None if expect_missing else validate_expected_head(expected_head or "")
    live = remote_branch_sha(branch_name, remote=remote, cwd=cwd)
    if expect_missing:
        if live is not None:
            raise SafePushError(
                f"stale-head: refs/heads/{branch_name} exists at {live}; expected it to be missing",
                exit_code=20,
            )
        lease = f"refs/heads/{branch_name}:"
    else:
        if live != expected:
            raise SafePushError(
                f"stale-head: refs/heads/{branch_name} is {live or 'missing'}; expected {expected}",
                exit_code=20,
            )
        lease = f"refs/heads/{branch_name}:{expected}"

    pushed = local_head(cwd=cwd)
    run_git([
        "push",
        f"--force-with-lease={lease}",
        remote,
        f"HEAD:refs/heads/{branch_name}",
    ], cwd=cwd)

    verified = remote_branch_sha(branch_name, remote=remote, cwd=cwd)
    if verified != pushed:
        raise SafePushError(
            f"post-push verification failed: refs/heads/{branch_name} is {verified or 'missing'}; expected {pushed}",
            exit_code=22,
        )
    return pushed


def append_tsv_ledger(path: Path, *, kind: str, key: str, marker: str, epoch: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"{kind}\t{key}\t{marker}\t{epoch if epoch is not None else int(time.time())}\n")


def append_json_ledger(
    path: Path,
    *,
    kind: str,
    pr_number: int,
    head_sha: str,
    key: str,
    epoch: int | None = None,
    meta: Mapping[str, object] | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    row: dict[str, object] = {
        "kind": kind,
        "pr": pr_number,
        "headSha": head_sha,
        "key": key,
        "epoch": epoch if epoch is not None else int(time.time()),
    }
    if meta:
        row["meta"] = dict(meta)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")


def resolve_json_ledger_path(path: str, *, home: Path | None = None) -> Path:
    expanded = Path(path).expanduser()
    parts = expanded.parts
    is_foreign_home_default = (
        len(parts) >= 4
        and parts[-2:] == DEFAULT_JSON_LEDGER_RELATIVE_PATH.parts
        and parts[1] in {"Users", "home"}
    )
    if is_foreign_home_default:
        return (home or Path.home()) / DEFAULT_JSON_LEDGER_RELATIVE_PATH
    return expanded


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Safely update a PR worker-owned branch only when its remote head matches the captured SHA.",
    )
    parser.add_argument("--branch", required=True, help="Branch name, without refs/heads/.")
    expected = parser.add_mutually_exclusive_group(required=True)
    expected.add_argument("--expected-head", help="Captured remote branch head SHA.")
    expected.add_argument("--expect-missing", action="store_true", help="Require the remote branch to be absent before pushing.")
    parser.add_argument("--remote", default="origin", help="Git remote name or URL. Default: origin.")
    parser.add_argument("--cwd", default=".", help="Repository working directory. Default: current directory.")

    parser.add_argument("--record-tsv-ledger", help="Append a TSV marker after successful push verification.")
    parser.add_argument("--tsv-kind", help="TSV ledger kind.")
    parser.add_argument("--tsv-key", help="TSV ledger key.")
    parser.add_argument("--tsv-marker", help="TSV ledger marker.")

    parser.add_argument("--record-json-ledger", help="Append a JSONL marker after successful push verification.")
    parser.add_argument("--json-kind", help="JSONL ledger kind.")
    parser.add_argument("--json-pr", type=int, help="JSONL PR number.")
    parser.add_argument("--json-head-sha", help="JSONL head SHA.")
    parser.add_argument("--json-key", help="JSONL ledger key.")
    parser.add_argument("--json-meta", help="Optional JSON object stored as JSONL ledger meta.")
    return parser.parse_args(argv)


def require_all(label: str, values: Mapping[str, object | None]) -> None:
    missing = [name for name, value in values.items() if value is None or value == ""]
    if missing:
        raise SafePushError(f"{label} requires {', '.join(missing)}", exit_code=2)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        cwd = Path(args.cwd)
        terminal_state = None
        if args.expected_head is not None and args.json_pr is not None:
            live = remote_branch_sha(args.branch, remote=args.remote, cwd=cwd)
            if live is None:
                terminal_state = terminal_pr_state_if_unchanged(
                    pr_number=args.json_pr,
                    branch=args.branch,
                    expected_head=args.expected_head,
                    cwd=cwd,
                )
        if terminal_state is None:
            pushed = safe_push(
                branch=args.branch,
                expected_head=args.expected_head,
                expect_missing=args.expect_missing,
                remote=args.remote,
                cwd=cwd,
            )
        else:
            pushed = validate_expected_head(args.expected_head)
        if args.record_tsv_ledger:
            require_all("TSV ledger recording", {
                "--tsv-kind": args.tsv_kind,
                "--tsv-key": args.tsv_key,
                "--tsv-marker": args.tsv_marker,
            })
            append_tsv_ledger(
                Path(args.record_tsv_ledger).expanduser(),
                kind=args.tsv_kind,
                key=args.tsv_key,
                marker=args.tsv_marker,
            )
        if args.record_json_ledger:
            require_all("JSONL ledger recording", {
                "--json-kind": args.json_kind,
                "--json-pr": args.json_pr,
                "--json-head-sha": args.json_head_sha,
                "--json-key": args.json_key,
            })
            meta = None
            if args.json_meta:
                decoded = json.loads(args.json_meta)
                if not isinstance(decoded, dict):
                    raise SafePushError("--json-meta must decode to a JSON object", exit_code=2)
                meta = decoded
            append_json_ledger(
                resolve_json_ledger_path(args.record_json_ledger),
                kind=args.json_kind,
                pr_number=args.json_pr,
                head_sha=args.json_head_sha,
                key=args.json_key,
                meta=meta,
            )
        if terminal_state is None:
            print(f"pr-worker-safe-push: pushed refs/heads/{normalize_branch(args.branch)} to {pushed}")
        else:
            print(
                f"pr-worker-safe-push: PR #{args.json_pr} is {terminal_state} at {pushed}; "
                f"refs/heads/{normalize_branch(args.branch)} is absent, nothing to push"
            )
        return 0
    except SafePushError as exc:
        print(f"pr-worker-safe-push: {exc}", file=sys.stderr)
        return exc.exit_code or 1
    except json.JSONDecodeError as exc:
        print(f"pr-worker-safe-push: invalid --json-meta: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
