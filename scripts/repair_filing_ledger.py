"""Python bridge to the shared repair_filings dedup ledger.

Mirrors scripts/repair-filing-ledger.mjs. Both scripts/e2e-regression-watch.mjs
(in-process, JS) and this module (subprocess, Python) call the same underlying
`repair-filing insert`/`repair-filing release` headless commands, backed by
the `repair_filings` SQLite table (packages/data-store/src/sqlite-schema.ts),
so mergify_admin_requeue_* and ci-regression-watch dedup state lives in one
place and each system can see the other's filings.

Precedent: scripts/mergify_admin_requeue_plan.py's retry_decision() already
shells out to `node scripts/retry-ledger.mjs decide` for shared retry/backoff
logic instead of re-deriving it in Python -- this module is the same pattern,
one primitive deeper (atomic cross-process claim instead of a pure decision
function).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

try:
    from .mergify_admin_requeue_headless_shell import run_headless
except ImportError:
    from mergify_admin_requeue_headless_shell import run_headless

REPO_ROOT = Path(__file__).resolve().parents[1]


class RepairFilingLedgerError(RuntimeError):
    """Raised when the headless_mutation call itself fails or its output can't be parsed."""


def _extract(stdout: str, required_key: str) -> dict[str, Any] | None:
    """Scan stdout lines from the last backwards for a JSON object carrying
    required_key, unwrapping an IPC-delegated owner's {..., response: {...}}
    envelope the same way scripts/repair-filing-ledger.mjs does."""
    lines = [line for line in stdout.strip().splitlines() if line.strip()]
    for line in reversed(lines):
        try:
            parsed = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        if required_key in parsed:
            return parsed
        response = parsed.get("response")
        if isinstance(response, dict) and required_key in response:
            return response
    return None


def insert_repair_filing(
    kind: str,
    subject: str,
    state_sha: str,
    metadata: Mapping[str, Any] | None = None,
    *,
    run_headless_fn=run_headless,
) -> dict[str, Any]:
    """Atomic insert-if-not-exists for (kind, subject, state_sha).

    Returns {"inserted": bool, "row": {...}}. Raises RepairFilingLedgerError
    on any failure to reach the ledger or parse its response -- callers that
    want fail-closed-on-error semantics (matching e2e-regression-watch.mjs's
    claimRepairFiling) should catch this and treat it as "already claimed".
    """
    if not kind or not subject or not state_sha:
        raise ValueError("insert_repair_filing requires kind, subject, and state_sha")
    command = 'headless_mutation repair-filing insert --kind "$2" --subject "$3" --state-sha "$4"'
    args = [kind, subject, state_sha]
    if metadata is not None:
        command += ' --metadata "$5"'
        args.append(json.dumps(dict(metadata)))
    completed = run_headless_fn(command, *args)
    if completed.returncode != 0:
        raise RepairFilingLedgerError(
            f"repair-filing insert failed (exit {completed.returncode}): {completed.stderr.strip()}"
        )
    result = _extract(completed.stdout, "inserted")
    if result is None:
        raise RepairFilingLedgerError(
            f"could not parse insert result from headless_mutation output: {completed.stdout!r}"
        )
    return result


def release_repair_filing(
    kind: str,
    subject: str,
    state_sha: str,
    *,
    run_headless_fn=run_headless,
) -> dict[str, Any]:
    """Releases a claim made by insert_repair_filing whose downstream filing
    then failed, so a later attempt can reclaim the identical key. Never
    raises on a ledger-side failure -- callers should not let a failed
    release crash their own error-handling path; they should log and move on
    (the key just stays claimed until manually cleared or the sha changes)."""
    if not kind or not subject or not state_sha:
        raise ValueError("release_repair_filing requires kind, subject, and state_sha")
    completed = run_headless_fn(
        'headless_mutation repair-filing release --kind "$2" --subject "$3" --state-sha "$4"',
        kind, subject, state_sha,
    )
    if completed.returncode != 0:
        raise RepairFilingLedgerError(
            f"repair-filing release failed (exit {completed.returncode}): {completed.stderr.strip()}"
        )
    result = _extract(completed.stdout, "released")
    if result is None:
        raise RepairFilingLedgerError(
            f"could not parse release result from headless_mutation output: {completed.stdout!r}"
        )
    return result
