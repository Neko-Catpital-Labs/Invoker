#!/usr/bin/env python3
"""Paired coding evaluator for the architecture-as-memory experiment.

    python3 scripts/repro/architecture-memory/run.py self-test
    python3 scripts/repro/architecture-memory/run.py pilot
    python3 scripts/repro/architecture-memory/run.py verify-recorded

self-test proves the apparatus: verified isolation, process timeouts, wrong
controls failing and correct controls passing in both variants, record rejection,
and replay. pilot spends exactly one A/B pair. verify-recorded re-derives a
recorded pair from its committed artefacts without any model call.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from amlib import manifest, pilot, records, report, selftest, verify  # noqa: E402
from amlib.checks import Results  # noqa: E402
from amlib.context import build_context, default_run_root  # noqa: E402
from amlib.ledger import AttemptLedger  # noqa: E402

REPO_ROOT = ROOT.parents[2]
RECORDS_DIR = ROOT / "records"
REPORTS_DIR = ROOT / "reports"
DEFAULT_TRIAL_TIMEOUT_SECONDS = 900
DEFAULT_TRIAL_BUDGET_USD = 12.0


def _run_id(prefix: str) -> str:
    return f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"


def _resolve_run_root(args, prefix: str) -> Path:
    return Path(args.run_root).resolve() if args.run_root else default_run_root(_run_id(prefix))


def _finish(results: Results, keep: bool, run_root: Path) -> int:
    print()
    print(results.summary(), flush=True)
    for outcome in results.failed:
        print("  failed: " + outcome.line(), flush=True)
    workspaces_root = run_root.parent / f"{run_root.name}-workspaces"
    if keep:
        print(f"run root kept at {run_root}", flush=True)
        print(f"trial workspaces kept at {workspaces_root}", flush=True)
    else:
        shutil.rmtree(run_root, ignore_errors=True)
        shutil.rmtree(workspaces_root, ignore_errors=True)
    return results.exit_code()


def cmd_self_test(args) -> int:
    run_root = _resolve_run_root(args, "selftest")
    context = build_context(ROOT, REPO_ROOT, run_root, commit=args.commit)
    results = selftest.run(context)
    if not results.failed:
        stamp = pilot.write_controls_stamp(RECORDS_DIR, context, results)
        print(f"[PASS] selftest:controls-stamp :: wrote {stamp.relative_to(REPO_ROOT)}", flush=True)
    return _finish(results, args.keep_run_root, run_root)


def cmd_pilot(args) -> int:
    run_root = _resolve_run_root(args, "pilot")
    context = build_context(ROOT, REPO_ROOT, run_root, commit=args.commit)
    record, results = pilot.run(
        context,
        records_dir=RECORDS_DIR,
        reports_dir=REPORTS_DIR,
        pair_id=args.pair_id,
        runner_name=args.runner,
        budget_usd=args.budget_usd,
        timeout_seconds=args.trial_timeout_seconds,
        model_override=args.model,
        effort_override=args.effort,
        order_seed=args.order_seed,
    )
    controls_path = RECORDS_DIR / pilot.CONTROLS_STAMP
    controls = json.loads(controls_path.read_text()) if controls_path.exists() else None
    written = report.write(REPORTS_DIR / f"pair-{args.pair_id}.html", record, controls)
    results.add("pilot:report-written", True, str(written.relative_to(REPO_ROOT)))
    return _finish(results, args.keep_run_root, run_root)


def cmd_verify_recorded(args) -> int:
    run_root = _resolve_run_root(args, "verify")
    record_paths = (
        [Path(args.record).resolve()]
        if args.record
        else sorted(RECORDS_DIR.glob("pair-*.json"))
    )
    results = Results("verify-recorded")
    if not record_paths:
        results.add("verify:records-present", False, f"no pair records under {RECORDS_DIR}")
        return _finish(results, args.keep_run_root, run_root)

    context = build_context(ROOT, REPO_ROOT, run_root, commit=args.commit, require_isolation=False)
    ledger = AttemptLedger(RECORDS_DIR / "attempt-ledger.json")
    results.add(
        "verify:no-model-calls",
        True,
        "this subcommand rebuilds, reapplies, and regrades only; it never invokes a harness",
    )

    for record_path in record_paths:
        label = record_path.stem
        record = records.load_record(record_path)
        complete = verify.verify_completeness(results, record, label)
        verify.verify_provenance(results, record, context, label)
        verify.verify_ledger(results, record, ledger.entries(), label)
        verify.verify_cost_claim(results, record, label)
        if complete:
            verify.verify_regrade(results, record, context, RECORDS_DIR / "patches", label)
        else:
            results.add(
                f"verify:{label}:regrade", False, "skipped: record failed the completeness gate"
            )
        html_path = REPORTS_DIR / f"{label}.html"
        results.add(
            f"verify:{label}:report-present",
            html_path.exists(),
            "a report file alone proves nothing; the regrade above is the proof",
        )
    return _finish(results, args.keep_run_root, run_root)


def cmd_report(args) -> int:
    """Regenerate HTML from committed records. Derived output only, no model call."""
    results = Results("report")
    record_paths = (
        [Path(args.record).resolve()] if args.record else sorted(RECORDS_DIR.glob("pair-*.json"))
    )
    controls_path = RECORDS_DIR / pilot.CONTROLS_STAMP
    controls = json.loads(controls_path.read_text()) if controls_path.exists() else None
    for record_path in record_paths:
        record = records.load_record(record_path)
        written = report.write(REPORTS_DIR / f"{record_path.stem}.html", record, controls)
        results.add(f"report:{record_path.stem}", True, str(written.relative_to(REPO_ROOT)))
    if not record_paths:
        results.add("report:records-present", False, f"no pair records under {RECORDS_DIR}")
    print()
    print(results.summary(), flush=True)
    return results.exit_code()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="run.py", description=__doc__)
    parser.add_argument("--commit", default=manifest.EXPERIMENT_SOURCE_COMMIT)
    parser.add_argument("--run-root", default=None)
    parser.add_argument("--keep-run-root", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("self-test", help="run every control; refuse the pilot until they pass")

    pilot_parser = sub.add_parser("pilot", help="run exactly one real A/B pair")
    pilot_parser.add_argument("--pair-id", default="pilot-001")
    pilot_parser.add_argument("--runner", default=None)
    pilot_parser.add_argument("--model", default=None)
    pilot_parser.add_argument("--effort", default=None)
    pilot_parser.add_argument("--budget-usd", type=float, default=DEFAULT_TRIAL_BUDGET_USD)
    pilot_parser.add_argument(
        "--trial-timeout-seconds", type=int, default=DEFAULT_TRIAL_TIMEOUT_SECONDS
    )
    pilot_parser.add_argument("--order-seed", type=int, default=None)

    verify_parser = sub.add_parser(
        "verify-recorded", help="re-derive and regrade recorded pairs with no model call"
    )
    verify_parser.add_argument("--record", default=None)

    report_parser = sub.add_parser(
        "report", help="regenerate HTML from committed pair records"
    )
    report_parser.add_argument("--record", default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "self-test":
        return cmd_self_test(args)
    if args.command == "pilot":
        return cmd_pilot(args)
    if args.command == "report":
        return cmd_report(args)
    return cmd_verify_recorded(args)


if __name__ == "__main__":
    raise SystemExit(main())
