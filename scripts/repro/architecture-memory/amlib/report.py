"""Self-contained HTML report for one recorded pair.

The report states what was exercised, what was not, and what would invalidate
this pair. It carries no transcripts and no credentials.
"""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any, Mapping

from . import manifest

STYLE = """
:root { color-scheme: light dark; }
body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
       margin: 0 auto; max-width: 62rem; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.6rem; margin-bottom: .25rem; }
h2 { font-size: 1.15rem; margin-top: 2.25rem; border-bottom: 1px solid #8884; padding-bottom: .3rem; }
h3 { font-size: 1rem; margin-top: 1.5rem; }
.sub { opacity: .7; margin-top: 0; }
table { border-collapse: collapse; width: 100%; margin: .75rem 0 1.25rem; font-size: .92rem; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; vertical-align: top; }
th { font-weight: 600; opacity: .8; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
.pass { color: #1a7f37; font-weight: 600; }
.fail { color: #b3261e; font-weight: 600; }
.pill { display: inline-block; border: 1px solid #8886; border-radius: 999px;
        padding: .05rem .55rem; font-size: .8rem; }
.note { border-left: 3px solid #8886; padding: .4rem 0 .4rem .85rem; margin: .9rem 0; opacity: .92; }
ul { padding-left: 1.2rem; }
"""


def _verdict(passed: bool) -> str:
    return f'<span class="{"pass" if passed else "fail"}">{"PASS" if passed else "FAIL"}</span>'


def _rows(pairs: list[tuple[str, Any]]) -> str:
    return "".join(
        f"<tr><th>{html.escape(str(key))}</th><td class='mono'>{html.escape(str(value))}</td></tr>"
        for key, value in pairs
    )


def _checks_table(checks: list[Mapping[str, Any]]) -> str:
    body = "".join(
        f"<tr><td class='mono'>{html.escape(check['check_id'])}</td>"
        f"<td>{_verdict(check['passed'])}</td>"
        f"<td class='mono'>{html.escape(str(check.get('exit_code')))}</td>"
        f"<td class='mono'>{html.escape(str(check.get('detail', ''))[:300])}</td></tr>"
        for check in checks
    )
    return (
        "<table><tr><th>check</th><th>result</th><th>exit</th><th>detail</th></tr>"
        f"{body}</table>"
    )


def _observed_outcome(record: Mapping[str, Any]) -> str:
    per_arm = record["conclusions"]["per_arm"]
    rows = "".join(
        f"<tr><td class='mono'>{html.escape(arm)}</td>"
        f"<td class='mono'>{html.escape(payload['trial_status'])}</td>"
        f"<td>{_verdict(payload['graded_pass'])}</td>"
        f"<td class='mono'>{html.escape(', '.join(payload['failing_checks']) or 'none')}</td></tr>"
        for arm, payload in sorted(per_arm.items())
    )
    passes = [arm for arm, payload in per_arm.items() if payload["graded_pass"]]
    if len(passes) == len(per_arm):
        reading = (
            "Both arms produced a graded pass, so this pair separates nothing. "
            "That is a real result about the task, not a failure of the run: this "
            "behavioural task was inside both arms' reach at this model and effort. "
            "A discriminating protocol needs harder tasks, repeats, or both."
        )
    elif not passes:
        reading = (
            "Neither arm produced a graded pass. The task was out of reach for both "
            "at this model and effort. That is valid data and is recorded as-is; it "
            "is not a reason to tune the treatment and rerun."
        )
    else:
        reading = (
            f"Only the {html.escape(passes[0])} arm produced a graded pass. At n=1 per arm "
            "this is a single observation, not an effect: run-to-run variance alone can "
            "produce it. It is a reason to run the repeated protocol, not to conclude from."
        )
    return (
        "<table><tr><th>arm</th><th>trial status</th><th>graded</th>"
        f"<th>failing checks</th></tr>{rows}</table><p>{reading}</p>"
    )


def render(record: Mapping[str, Any], controls: Mapping[str, Any] | None) -> str:
    provenance = record["provenance"]
    conclusions = record["conclusions"]
    arms = record["arms"]

    control_rows = ""
    if controls:
        control_rows = "".join(
            f"<tr><td class='mono'>{html.escape(check['name'])}</td>"
            f"<td>{_verdict(check['passed'])}</td>"
            f"<td class='mono'>{html.escape(str(check['detail'])[:220])}</td></tr>"
            for check in controls.get("checks", [])
        )

    arm_sections = ""
    for variant in record["execution_order"]:
        payload = arms[variant]
        telemetry = payload.get("telemetry") or {}
        tokens = telemetry.get("tokens") or {}
        arm_sections += f"""
<h3>{html.escape(variant)} arm <span class="pill">{html.escape(payload['status'])}</span>
 {_verdict(payload['grade']['passed'])}</h3>
<table>{_rows([
    ("trial status", payload["status"]),
    ("harness exit code", payload["exit_code"]),
    ("timed out", payload.get("timed_out")),
    ("wall seconds", payload["wall_seconds"]),
    ("human intervention", payload.get("human_intervention")),
    ("final diff sha256", payload["diff_sha256"]),
    ("final diff bytes", payload["diff_bytes"]),
    ("replay patch", "records/patches/" + str(payload.get("patch_file"))),
    ("cost usd", telemetry.get("cost_usd")),
    ("cost telemetry", telemetry.get("cost_telemetry")),
    ("input tokens", tokens.get("input")),
    ("output tokens", tokens.get("output")),
    ("cache read tokens", tokens.get("cache_read")),
    ("turns", telemetry.get("num_turns")),
])}</table>
{_checks_table(payload["grade"]["checks"])}
"""

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Architecture-as-memory paired pilot — {html.escape(record['pair_id'])}</title>
<style>{STYLE}</style></head><body>
<h1>Architecture-as-memory paired pilot</h1>
<p class="sub">Experiment <code>{html.escape(record['experiment_id'])}</code> ·
pair <code>{html.escape(record['pair_id'])}</code> · recorded {html.escape(record['created_at'])}</p>

<div class="note"><strong>What this one pair establishes.</strong>
{html.escape(conclusions['statistical_claim'])}</div>

<h2>Provenance</h2>
<table>{_rows([
    ("source commit", provenance["source_commit"]),
    ("source remote", provenance.get("source_remote")),
    ("source archive sha256", provenance["archive_sha256"]),
    ("manifest sha256", provenance["manifest_sha256"]),
    ("grader sha256", provenance["grader_sha256"]),
    ("structural delta sha256", provenance["structural_delta_sha256"]),
    ("task prompt sha256", provenance["prompt_sha256"]),
    ("baseline source tree sha256", provenance["snapshots"]["baseline"]["source_tree_sha256"]),
    ("treatment source tree sha256", provenance["snapshots"]["treatment"]["source_tree_sha256"]),
    ("baseline target file sha256", provenance["snapshots"]["baseline"]["target_file_sha256"]),
    ("treatment target file sha256", provenance["snapshots"]["treatment"]["target_file_sha256"]),
    ("trial workspace redactions", ", ".join(provenance["redactions"])),
])}</table>
<p>{html.escape(record["structural_delta_summary"])}</p>

<h2>Configuration equality</h2>
<table>{_rows([
    ("equal", record["configuration"]["equal"]),
    ("differences", record["configuration"]["differences"] or "none"),
    ("runner", record["configuration"]["baseline"]["runner"]),
    ("harness version", record["configuration"]["baseline"]["version"]),
    ("model", record["configuration"]["baseline"]["model"]),
    ("effort", record["configuration"]["baseline"]["effort"]),
    ("per-trial timeout (s)", record["configuration"]["baseline"]["timeout_seconds"]),
    ("per-trial budget (usd)", record["configuration"]["baseline"]["budget_usd"]),
    ("execution order", " -> ".join(record["execution_order"])),
    ("order seed", record["order_seed"]),
])}</table>

<h2>Controls (run before the pair)</h2>
{"<table><tr><th>control</th><th>result</th><th>detail</th></tr>" + control_rows + "</table>"
 if control_rows else "<p>No controls stamp was bundled with this report.</p>"}

<h2>Trials</h2>
{arm_sections}

<h2>Observed outcome</h2>
{_observed_outcome(record)}

<h2>Cost accounting</h2>
<table>{_rows([
    ("dollar conclusion permitted", conclusions["dollar_conclusion_permitted"]),
    ("reason", conclusions["dollar_conclusion_reason"]),
    ("trials counted", conclusions["trials_counted"]),
])}</table>
<p>Measured trial cost is the per-trial telemetry above. Apparatus development and
setup cost is not part of it and is not reported here as a trial cost.</p>

<h2>What was exercised</h2>
<ul>
  <li>Two snapshots built from one immutable upstream commit, differing only at
      <code>{html.escape(manifest.TARGET_FILE)}</code>.</li>
  <li>Verified filesystem isolation: the grader, the gold patches, and the run
      directory were proven unreadable from inside a trial before any trial ran.</li>
  <li>An external behavioural grader: typecheck, the upstream facade suite, and
      five evaluator-owned checks asserting the requested behaviour and the
      close-review-before-mutation ownership invariant.</li>
  <li>One A/B pair, randomized order, one attempt per arm, no automatic retries.</li>
</ul>

<h2>What was not exercised</h2>
<ul>
  <li>Repetition. One pair cannot separate an architecture effect from run-to-run variance.</li>
  <li>Task breadth. One behavioural task on one module in one package.</li>
  <li>Harness breadth. One registered harness, one pinned model, one effort level.</li>
  <li>The production execution path. Nothing here runs inside the app.</li>
</ul>

<h2>What would invalidate this pair</h2>
<ul>
  <li>A provenance hash that no longer reproduces from the recorded commit.</li>
  <li>Any configuration difference between the arms beyond the structural delta.</li>
  <li>A grader or gold patch reachable from inside a trial workspace.</li>
  <li>A control regression: the unedited snapshot passing, or a gold patch failing.</li>
  <li>More recorded trials than the attempt ledger's terminal entries, or a rerun
      after an unsuccessful result.</li>
</ul>

<h2>The protocol this defers</h2>
<p>The planned expansion is six behavioural tasks by five repeats per arm
(60 trials), with the same apparatus, the same pinned configuration, per-task
randomized order, and per-task control matrices rerun before each batch. It is
deliberately <em>not</em> launched here: the point of this slice is that the
apparatus is trustworthy first.</p>

<h2>Machine-readable record</h2>
<pre class="mono">{html.escape(json.dumps({k: v for k, v in record.items() if k != 'attempts'}, indent=2, sort_keys=True))}</pre>
</body></html>
"""


def write(path: Path, record: Mapping[str, Any], controls: Mapping[str, Any] | None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(record, controls))
    return path
