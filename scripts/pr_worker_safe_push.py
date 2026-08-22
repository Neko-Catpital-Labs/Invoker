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


def is_ancestor_of_head(sha: str, *, cwd: Path | str | None = None) -> bool:
    completed = subprocess.run(
        ["git", "merge-base", "--is-ancestor", sha, "HEAD"],
        cwd=str(cwd) if cwd is not None else None,
        check=False,
        text=True,
        capture_output=True,
    )
    return completed.returncode == 0


LEASE_REJECTION_MARKER = "cannot lock ref"
MAX_LEASE_ATTEMPTS = 3


def _resolve_safe_lease_sha(
    branch_name: str,
    *,
    live: str | None,
    expected: str,
    cwd: Path | str | None,
    context: str | None = None,
) -> str:
    if live == expected:
        return expected
    if live is not None and is_ancestor_of_head(live, cwd=cwd):
        return live
    message = f"stale-head: refs/heads/{branch_name} is {live or 'missing'}; expected {expected}"
    if context:
        message += f"\n(after push attempt failed: {context})"
    raise SafePushError(message, exit_code=20)


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
    pushed = local_head(cwd=cwd)
    live = remote_branch_sha(branch_name, remote=remote, cwd=cwd)

    if expect_missing:
        if live is not None:
            raise SafePushError(
                f"stale-head: refs/heads/{branch_name} exists at {live}; expected it to be missing",
                exit_code=20,
            )
        lease_sha = ""
    else:
        lease_sha = _resolve_safe_lease_sha(branch_name, live=live, expected=expected, cwd=cwd)

    for attempt in range(1, MAX_LEASE_ATTEMPTS + 1):
        lease = f"refs/heads/{branch_name}:{lease_sha}"
        try:
            run_git([
                "push",
                f"--force-with-lease={lease}",
                remote,
                f"HEAD:refs/heads/{branch_name}",
            ], cwd=cwd)
            break
        except SafePushError as exc:
            if attempt == MAX_LEASE_ATTEMPTS or LEASE_REJECTION_MARKER not in str(exc):
                raise
            live = remote_branch_sha(branch_name, remote=remote, cwd=cwd)
            if expect_missing:
                raise SafePushError(
                    f"stale-head: refs/heads/{branch_name} exists at {live}; expected it to be missing",
                    exit_code=20,
                ) from exc
            lease_sha = _resolve_safe_lease_sha(
                branch_name, live=live, expected=expected, cwd=cwd, context=str(exc)
            )

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
        pushed = safe_push(
            branch=args.branch,
            expected_head=args.expected_head,
            expect_missing=args.expect_missing,
            remote=args.remote,
            cwd=Path(args.cwd),
        )
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
                Path(args.record_json_ledger).expanduser(),
                kind=args.json_kind,
                pr_number=args.json_pr,
                head_sha=args.json_head_sha,
                key=args.json_key,
                meta=meta,
            )
        print(f"pr-worker-safe-push: pushed refs/heads/{normalize_branch(args.branch)} to {pushed}")
        return 0
    except SafePushError as exc:
        print(f"pr-worker-safe-push: {exc}", file=sys.stderr)
        return exc.exit_code or 1
    except json.JSONDecodeError as exc:
        print(f"pr-worker-safe-push: invalid --json-meta: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
