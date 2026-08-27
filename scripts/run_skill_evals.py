#!/usr/bin/env python3
"""Validate, run, and score paired response-quality evaluations for a skill.

Ported from the i-have-adhd project's evals/ harness (github.com skill repo
"i-have-adhd", scripts/run_evals.py). Same paired baseline/candidate design;
adapted here to test procedural/decision-making skills (e.g. plan-to-invoker)
rather than a response-style skill, so the injected wrapper talks about
"skill instructions" instead of "response style."
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = ROOT / "evals" / "plan-to-invoker" / "cases.jsonl"
DEFAULT_RUNNER_CONFIG = ROOT / "evals" / "plan-to-invoker" / "runners.example.json"
DEFAULT_REPORT_TEMPLATE = ROOT / "scripts" / "report_template.html"
WEIGHTS = {
    "correctness": 0.35,
    "autonomy": 0.25,
    "actionability": 0.20,
    "safety": 0.10,
    "concision": 0.10,
}
CONDITIONS = {"baseline", "candidate", "comparator"}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}: line {number}: {exc.msg}") from exc
        if not isinstance(row, dict):
            raise ValueError(f"{path}: line {number}: expected a JSON object")
        rows.append(row)
    return rows


def load_cases(path: Path = DEFAULT_CASES) -> list[dict[str, Any]]:
    return read_jsonl(path)


def completed_keys(rows: list[dict[str, Any]]) -> set[tuple[str, int, str, str]]:
    keys: set[tuple[str, int, str, str]] = set()
    for row in rows:
        fields = (row.get("case_id"), row.get("trial"), row.get("condition"), row.get("runner"))
        if isinstance(fields[0], str) and isinstance(fields[1], int) and all(
            isinstance(value, str) for value in fields[2:]
        ):
            keys.add(fields)  # type: ignore[arg-type]
    return keys


def validate_cases(cases: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    required = {"id", "category", "prompt", "risk", "criteria"}
    for index, case in enumerate(cases, start=1):
        missing = sorted(required - set(case))
        if missing:
            errors.append(f"Case {index}: missing fields: {', '.join(missing)}")
            continue
        case_id = case["id"]
        if not isinstance(case_id, str) or not case_id:
            errors.append(f"Case {index}: id must be a non-empty string")
        elif case_id in seen:
            errors.append(f"Duplicate case id: {case_id}")
        else:
            seen.add(case_id)
        if case["risk"] not in {"low", "medium", "high"}:
            errors.append(f"Case {case_id}: risk must be low, medium, or high")
        if not isinstance(case["criteria"], list) or not case["criteria"]:
            errors.append(f"Case {case_id}: criteria must be a non-empty list")
    return errors


def _validate_score(row: dict[str, Any], index: int) -> None:
    required = {"case_id", "trial", "condition", *WEIGHTS, "blocker", "notes"}
    missing = sorted(required - set(row))
    if missing:
        raise ValueError(f"Score row {index}: missing fields: {', '.join(missing)}")
    if row["condition"] not in CONDITIONS:
        raise ValueError(f"Score row {index}: unsupported condition {row['condition']!r}")
    for metric in WEIGHTS:
        value = row[metric]
        if not isinstance(value, (int, float)) or not 1 <= value <= 5:
            raise ValueError(f"Score row {index}: {metric} must be between 1 and 5")
    if not isinstance(row["blocker"], bool):
        raise ValueError(f"Score row {index}: blocker must be boolean")


def _describe_rows(keys: list[tuple[str, Any]]) -> str:
    return ", ".join(f"{case_id}/trial {trial}" for case_id, trial in keys)


def _check_pairing(grouped: dict[str, list[dict[str, Any]]]) -> None:
    """Conditions are only comparable when judged on identical rows."""
    coverage = {
        condition: Counter((row["case_id"], row["trial"]) for row in rows)
        for condition, rows in grouped.items()
    }
    for condition, counts in sorted(coverage.items()):
        repeated = sorted(key for key, count in counts.items() if count > 1)
        if repeated:
            raise ValueError(
                f"{condition}: duplicate score rows for {_describe_rows(repeated)}"
            )
    baseline = coverage["baseline"]
    for condition, counts in sorted(coverage.items()):
        if condition == "baseline" or counts == baseline:
            continue
        details = []
        missing = sorted(set(baseline) - set(counts))
        if missing:
            details.append(f"missing {_describe_rows(missing)}")
        unmatched = sorted(set(counts) - set(baseline))
        if unmatched:
            details.append(f"unmatched {_describe_rows(unmatched)}")
        raise ValueError(
            f"{condition} was not judged on the same rows as baseline: "
            + "; ".join(details)
        )


def summarize_scores(scores: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for index, row in enumerate(scores, start=1):
        _validate_score(row, index)
        grouped[row["condition"]].append(row)
    if "baseline" not in grouped or "candidate" not in grouped:
        raise ValueError("Scores must include baseline and candidate conditions")
    _check_pairing(grouped)

    conditions: dict[str, dict[str, Any]] = {}
    for condition, rows in sorted(grouped.items()):
        metrics = {
            metric: sum(float(row[metric]) for row in rows) / len(rows)
            for metric in WEIGHTS
        }
        conditions[condition] = {
            "rows": len(rows),
            **metrics,
            "weighted_score": sum(metrics[metric] * weight for metric, weight in WEIGHTS.items()),
            "blocking_findings": sum(bool(row["blocker"]) for row in rows),
        }

    baseline = conditions["baseline"]
    candidate = conditions["candidate"]
    reasons: list[str] = []
    if candidate["blocking_findings"]:
        reasons.append("Candidate has blocking safety or correctness findings.")
    if candidate["correctness"] < baseline["correctness"] - 0.1:
        reasons.append("Candidate correctness regressed by more than 0.1 points.")
    if candidate["safety"] < baseline["safety"] - 0.1:
        reasons.append("Candidate safety regressed by more than 0.1 points.")
    if candidate["weighted_score"] <= baseline["weighted_score"]:
        reasons.append("Candidate weighted score did not beat baseline.")

    return {
        "weights": WEIGHTS,
        "conditions": conditions,
        "release_gate": {"passed": not reasons, "reasons": reasons},
    }


def _condition_prompt(task: str, condition: str, skill_path: Path | None) -> str:
    if condition == "baseline":
        return task
    if skill_path is None:
        raise ValueError(f"--condition-skill is required for the {condition} condition")
    instructions = skill_path.read_text(encoding="utf-8")
    return (
        "Follow the skill instructions below while deciding what to do next. "
        "Answer as the decision itself (what you would do, in what order), "
        "not as a discussion of the skill.\n\n"
        f"<skill_instructions>\n{instructions}\n</skill_instructions>\n\n"
        f"<task>\n{task}\n</task>"
    )


def _parse_response(output: str, response_format: str) -> tuple[str, dict[str, Any], float | None]:
    if response_format == "text":
        return output.strip(), {}, None
    if response_format == "claude-json":
        payload = json.loads(output)
        return (
            str(payload.get("result", "")).strip(),
            payload.get("usage", {}) or {},
            payload.get("total_cost_usd"),
        )
    if response_format == "codex-jsonl":
        events = [json.loads(line) for line in output.splitlines() if line.strip()]
        text = ""
        usage: dict[str, Any] = {}
        for event in events:
            item = event.get("item", {})
            if event.get("type") == "item.completed" and item.get("type") == "agent_message":
                text = item.get("text", text)
            if event.get("type") == "turn.completed":
                usage = event.get("usage", usage)
        return str(text).strip(), usage, None
    raise ValueError(f"Unsupported response format: {response_format}")


def parse_response(output: str, response_format: str) -> tuple[str, dict[str, Any], float | None]:
    """Public alias for spend benches that must reuse the same cost parser."""
    return _parse_response(output, response_format)


def run_evaluations(args: argparse.Namespace) -> int:
    cases = load_cases(args.cases)
    errors = validate_cases(cases)
    if errors:
        raise ValueError("\n".join(errors))
    unknown = sorted(set(args.case or []) - {case["id"] for case in cases})
    if unknown:
        raise ValueError(f"--case matched no evaluation case: {', '.join(unknown)}")
    config = json.loads(args.runner_config.read_text(encoding="utf-8"))
    runner = config[args.runner]
    command = list(runner["command"])
    response_format = runner.get("response_format", "text")
    if response_format != "claude-json" and not args.allow_unmetered:
        raise RuntimeError(
            f"The {response_format!r} response format never reports dollar cost; rerun with "
            "--allow-unmetered only when the provider has a separate hard spending cap."
        )
    reported_cost = 0.0
    prior_rows = read_jsonl(args.output) if args.output.exists() else []
    done = completed_keys(prior_rows)
    reported_cost = sum(
        float(row.get("cost_usd") or 0)
        for row in prior_rows
        if row.get("condition") == args.condition and row.get("runner") == args.runner
    )

    if args.budget_usd <= 0 or args.budget_usd > 25:
        raise ValueError("--budget-usd must be greater than 0 and no more than 25")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("a", encoding="utf-8") as destination:
        for trial in range(1, args.trials + 1):
            for case in cases:
                if args.case and case["id"] not in args.case:
                    continue
                key = (case["id"], trial, args.condition, args.runner)
                if key in done:
                    print(f"skip completed {args.condition} trial {trial}: {case['id']}")
                    continue
                remaining = args.budget_usd - reported_cost
                if remaining <= 0:
                    print("Budget exhausted; stopping.", file=sys.stderr)
                    return 2
                prompt = _condition_prompt(case["prompt"], args.condition, args.condition_skill)
                invocation = [*command]
                if runner.get("budget_flag"):
                    invocation.extend([runner["budget_flag"], f"{remaining:.4f}"])
                invocation.append(prompt)
                completed = None
                for attempt in range(args.retries + 1):
                    completed = subprocess.run(
                        invocation,
                        check=False,
                        capture_output=True,
                        text=True,
                        cwd=ROOT,
                    )
                    if completed.returncode == 0:
                        break
                    if attempt < args.retries:
                        time.sleep(min(2**attempt, 5))
                assert completed is not None
                if completed.returncode:
                    detail = completed.stderr.strip() or completed.stdout.strip()
                    if completed.stdout.strip():
                        try:
                            parsed_text, _, _ = _parse_response(completed.stdout, response_format)
                            detail = parsed_text or detail
                        except (ValueError, json.JSONDecodeError):
                            pass
                    raise RuntimeError(
                        f"Runner failed after {args.retries + 1} attempts "
                        f"({shlex.join(invocation[:-1])}):\n{detail}"
                    )
                text, usage, cost = _parse_response(completed.stdout, response_format)
                if cost is None and not args.allow_unmetered:
                    raise RuntimeError(
                        "Runner did not report dollar cost; rerun with --allow-unmetered only when "
                        "the provider has a separate hard spending cap."
                    )
                reported_cost += float(cost or 0)
                row = {
                    "case_id": case["id"],
                    "trial": trial,
                    "condition": args.condition,
                    "runner": args.runner,
                    "response": text,
                    "usage": usage,
                    "cost_usd": cost,
                }
                destination.write(json.dumps(row, ensure_ascii=False) + "\n")
                destination.flush()
                print(f"{args.condition} trial {trial}: {case['id']}")
    print(f"Reported cost: ${reported_cost:.4f}")
    return 0


def _fmt_usd(value: float) -> str:
    return f"${value:.2f}"


def _nice_ticks(raw_max: float) -> tuple[float, list[float]]:
    """Pick a rounded axis ceiling and 5 evenly spaced ticks from 0 to it."""
    if raw_max <= 0:
        return 1.0, [0.0, 0.2, 0.4, 0.6, 0.8]
    steps = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100]
    target = raw_max / 4
    step = next((candidate for candidate in steps if candidate >= target), None)
    while step is None:
        steps = [value * 10 for value in steps]
        step = next((candidate for candidate in steps if candidate >= target), None)
    ticks = [round(step * i, 6) for i in range(5)]
    max_val = round(step * 4 * 1.08, 6)
    return max_val, ticks


def generate_report(args: argparse.Namespace) -> int:
    cases = {case["id"]: case for case in load_cases(args.cases)}
    responses = read_jsonl(args.responses)

    grouped: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for row in responses:
        grouped[row["case_id"]][row["condition"]].append(row)

    missing_baseline = sorted(cid for cid in cases if not grouped[cid]["baseline"])
    missing_candidate = sorted(cid for cid in cases if not grouped[cid]["candidate"])
    if missing_baseline or missing_candidate:
        raise ValueError(
            "A report needs both conditions for every case.\n"
            f"Missing baseline responses: {missing_baseline or 'none'}\n"
            f"Missing candidate responses: {missing_candidate or 'none'}"
        )

    entries = []
    for case_id, case in cases.items():
        baseline_rows = grouped[case_id]["baseline"]
        candidate_rows = grouped[case_id]["candidate"]
        baseline_cost = sum(float(row.get("cost_usd") or 0) for row in baseline_rows) / len(baseline_rows)
        candidate_cost = sum(float(row.get("cost_usd") or 0) for row in candidate_rows) / len(candidate_rows)
        entries.append({
            "id": case_id,
            "category": case.get("category", ""),
            "prompt": case.get("prompt", ""),
            "risk": case.get("risk", "medium"),
            "baseline": round(baseline_cost, 6),
            "candidate": round(candidate_cost, 6),
            "baselineResponse": baseline_rows[0].get("response", ""),
            "candidateResponse": candidate_rows[0].get("response", ""),
        })
    entries.sort(key=lambda entry: entry["candidate"], reverse=True)

    case_count = len(entries)
    baseline_calls = sum(len(grouped[cid]["baseline"]) for cid in cases)
    candidate_calls = sum(len(grouped[cid]["candidate"]) for cid in cases)
    total_calls = baseline_calls + candidate_calls
    baseline_total = sum(entry["baseline"] for entry in entries)
    candidate_total = sum(entry["candidate"] for entry in entries)
    baseline_avg = baseline_total / case_count if case_count else 0.0
    candidate_avg = candidate_total / case_count if case_count else 0.0
    multiplier = (candidate_avg / baseline_avg) if baseline_avg else 0.0

    raw_max = max((entry["baseline"] for entry in entries), default=0.0)
    raw_max = max(raw_max, max((entry["candidate"] for entry in entries), default=0.0))
    max_val, ticks = _nice_ticks(raw_max)

    if args.condition_skill:
        skill_line_count = len(args.condition_skill.read_text(encoding="utf-8").splitlines())
        skill_lines_label = f"{skill_line_count} lines"
        skill_path_label = str(args.condition_skill)
    else:
        skill_lines_label = "an unrecorded number of lines"
        skill_path_label = "(skill file not given to `report`)"

    trial_counts = [len(rows) for by_condition in grouped.values() for rows in by_condition.values()]
    max_trials = max(trial_counts, default=1)
    trials_label = "1 per case" if max_trials <= 1 else f"up to {max_trials} per case, averaged"

    cases_json = {
        entry["id"]: {"category": entry["category"], "prompt": entry["prompt"], "risk": entry["risk"]}
        for entry in entries
    }
    data_json = [
        {"id": entry["id"], "baseline": entry["baseline"], "candidate": entry["candidate"]}
        for entry in entries
    ]
    responses_json = {
        entry["id"]: {"baseline": entry["baselineResponse"], "candidate": entry["candidateResponse"]}
        for entry in entries
    }

    replacements = {
        "{{TITLE}}": args.title,
        "{{EYEBROW}}": args.eyebrow,
        "{{CASE_COUNT}}": str(case_count),
        "{{SKILL_PATH}}": skill_path_label,
        "{{MODEL}}": args.model,
        "{{TOTAL_CALLS}}": str(total_calls),
        "{{TRIALS_LABEL}}": trials_label,
        "{{RECORDED_DATE}}": args.recorded_date or date.today().strftime("%b %d, %Y"),
        "{{TOTAL_COST}}": _fmt_usd(baseline_total + candidate_total),
        "{{BASELINE_TOTAL}}": _fmt_usd(baseline_total),
        "{{BASELINE_AVG}}": _fmt_usd(baseline_avg),
        "{{CANDIDATE_TOTAL}}": _fmt_usd(candidate_total),
        "{{CANDIDATE_AVG}}": _fmt_usd(candidate_avg),
        "{{MULTIPLIER}}": f"{multiplier:.1f}",
        "{{SKILL_LINES}}": skill_lines_label,
        "{{CANDIDATE_CALLS}}": str(candidate_calls),
        "{{CASES_PATH}}": str(args.cases),
        "{{RESPONSES_PATH}}": str(args.responses),
        "{{CASES_JSON}}": json.dumps(cases_json, ensure_ascii=False),
        "{{DATA_JSON}}": json.dumps(data_json, ensure_ascii=False),
        "{{RESPONSES_JSON}}": json.dumps(responses_json, ensure_ascii=False),
        "{{MAX_VAL}}": repr(max_val),
        "{{TICKS_JSON}}": json.dumps(ticks),
    }

    output_html = args.template.read_text(encoding="utf-8")
    for token, value in replacements.items():
        output_html = output_html.replace(token, value)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output_html, encoding="utf-8")
    print(
        f"Wrote report: {args.output} "
        f"({case_count} cases, {total_calls} calls, {_fmt_usd(baseline_total + candidate_total)} total)"
    )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="Validate the case catalog")
    validate.add_argument("--cases", type=Path, default=DEFAULT_CASES)

    plan = subparsers.add_parser("plan", help="Print the paired run matrix as JSONL")
    plan.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    plan.add_argument("--trials", type=int, default=3)
    plan.add_argument("--include-comparator", action="store_true")

    score = subparsers.add_parser("score", help="Aggregate manually judged score rows")
    score.add_argument("scores", type=Path)

    run = subparsers.add_parser("run", help="Run one evaluation condition")
    run.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    run.add_argument("--runner-config", type=Path, default=DEFAULT_RUNNER_CONFIG)
    run.add_argument("--runner", required=True)
    run.add_argument("--condition", choices=sorted(CONDITIONS), required=True)
    run.add_argument("--condition-skill", type=Path)
    run.add_argument("--case", action="append")
    run.add_argument("--trials", type=int, default=3)
    run.add_argument("--retries", type=int, default=2)
    run.add_argument("--budget-usd", type=float, default=25.0)
    run.add_argument("--allow-unmetered", action="store_true")
    run.add_argument("--output", type=Path, required=True)
    run.set_defaults(handler=run_evaluations)

    report = subparsers.add_parser("report", help="Render a cost/conversation HTML report from run results")
    report.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    report.add_argument("--responses", type=Path, required=True, help="A results JSONL file written by `run`")
    report.add_argument("--condition-skill", type=Path, help="The skill file used for the candidate condition")
    report.add_argument("--template", type=Path, default=DEFAULT_REPORT_TEMPLATE)
    report.add_argument("--output", type=Path, required=True)
    report.add_argument("--title", default="Skill Eval Cost Report")
    report.add_argument("--eyebrow", default="Eval cost benchmark")
    report.add_argument("--model", default="(model not recorded)", help="Label only; not read from the results file")
    report.add_argument("--recorded-date", help="Defaults to today; pass to keep a report reproducibly dated")
    report.set_defaults(handler=generate_report)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if hasattr(args, "handler"):
        return args.handler(args)
    if args.command == "validate":
        errors = validate_cases(load_cases(args.cases))
        if errors:
            for error in errors:
                print(f"ERROR: {error}", file=sys.stderr)
            return 1
        print("Evaluation cases are valid.")
        return 0
    if args.command == "plan":
        cases = load_cases(args.cases)
        errors = validate_cases(cases)
        if errors:
            raise ValueError("\n".join(errors))
        conditions = ["baseline", "candidate"]
        if args.include_comparator:
            conditions.append("comparator")
        for trial in range(1, args.trials + 1):
            for case in cases:
                for condition in conditions:
                    print(json.dumps({"case_id": case["id"], "trial": trial, "condition": condition}))
        return 0
    if args.command == "score":
        print(json.dumps(summarize_scores(read_jsonl(args.scores)), indent=2))
        return 0
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
