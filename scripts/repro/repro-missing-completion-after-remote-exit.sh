#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="bug"
MIN_STALE_SECONDS="${MIN_STALE_SECONDS:-600}"
EXECUTOR_FILTER="${EXECUTOR_FILTER:-ssh}"
STRICT_MODE="${STRICT_MODE:-0}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-missing-completion-after-remote-exit.sh \
    [--expect bug|fixed] [--min-stale-seconds N] [--executor ssh|all] [--strict]

What it checks:
  Detects tasks that look orphaned after remote execution ended:
    - task status is running
    - task phase is executing
    - task age >= min-stale-seconds
    - no matching process found on any configured SSH remote
    - no terminal audit event (failed/completed/review_ready/awaiting_approval)
      after the current attempt started
  By default only `executorType=ssh` tasks are considered.
  Use --strict to print per-task proof (remote checks + last terminal event).

Exit codes:
  0  observed behavior matches --expect
  1  observed behavior does not match --expect
  2  invalid args or tooling/runtime error
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --min-stale-seconds)
      MIN_STALE_SECONDS="${2:-}"
      shift 2
      ;;
    --executor)
      EXECUTOR_FILTER="${2:-}"
      shift 2
      ;;
    --strict)
      STRICT_MODE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires bug|fixed" >&2
  exit 2
fi

if ! [[ "$MIN_STALE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "repro: --min-stale-seconds must be an integer >= 0" >&2
  exit 2
fi

if [[ "$EXECUTOR_FILTER" != "ssh" && "$EXECUTOR_FILTER" != "all" ]]; then
  echo "repro: --executor requires ssh|all" >&2
  exit 2
fi

command -v python3 >/dev/null 2>&1 || { echo "repro: missing python3" >&2; exit 2; }
command -v ssh >/dev/null 2>&1 || { echo "repro: missing ssh" >&2; exit 2; }

cd "$ROOT_DIR"

python3 - "$EXPECTATION" "$MIN_STALE_SECONDS" "$EXECUTOR_FILTER" "$STRICT_MODE" <<'PY'
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

EXPECT = sys.argv[1]
MIN_STALE = int(sys.argv[2])
EXEC_FILTER = sys.argv[3]
STRICT_MODE = sys.argv[4] == "1"
ROOT = Path("/Users/edbertchan/Documents/GitHub/Invoker")
SSH_KEY = Path.home() / ".ssh" / "id_ed25519"
CONFIG_PATH = Path.home() / ".invoker" / "config.json"


def run(cmd: str) -> str:
    p = subprocess.run(cmd, cwd=ROOT, shell=True, text=True, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip() or f"command failed: {cmd}")
    return p.stdout


def parse_last_json_object(output: str) -> dict:
    for line in reversed(output.splitlines()):
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                return json.loads(s)
            except json.JSONDecodeError:
                continue
    raise RuntimeError("could not parse json object from command output")


def parse_jsonl_events(output: str) -> list[dict]:
    rows: list[dict] = []
    for line in output.splitlines():
        s = line.strip()
        if not (s.startswith("{") and '"eventType"' in s and '"taskId"' in s):
            continue
        try:
            rows.append(json.loads(s))
        except json.JSONDecodeError:
            continue
    return rows


def parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_audit_created_at(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def load_remote_hosts() -> list[tuple[str, str, str]]:
    if not CONFIG_PATH.exists():
        return []
    cfg = json.loads(CONFIG_PATH.read_text())
    targets = (cfg.get("remoteTargets") or {})
    out: list[tuple[str, str, str]] = []
    for target_id, target in targets.items():
        host = (target or {}).get("host")
        user = (target or {}).get("user")
        if host and user:
            out.append((target_id, host, user))
    return out


def collect_remote_ps(hosts: list[tuple[str, str, str]]) -> dict[str, dict]:
    by_target: dict[str, dict] = {}
    for target_id, host, user in hosts:
        cmd = (
            f"ssh -i {json.dumps(str(SSH_KEY))} "
            f"{json.dumps(f'{user}@{host}')} "
            f"{json.dumps('ps -eo pid,etimes,args')}"
        )
        p = subprocess.run(cmd, shell=True, text=True, capture_output=True)
        by_target[target_id] = {
            "ok": p.returncode == 0,
            "stdout": p.stdout if p.returncode == 0 else "",
            "error": (p.stderr or "").strip(),
        }
    return by_target


queue_obj = parse_last_json_object(run("./run.sh --headless query queue --output json"))
running = queue_obj.get("running", [])

remote_hosts = load_remote_hosts()
remote_ps = collect_remote_ps(remote_hosts)

now = datetime.now(timezone.utc)
suspects: list[dict] = []
considered: list[dict] = []

terminal_events = {"task.failed", "task.completed", "task.review_ready", "task.awaiting_approval"}

for row in running:
    task_id = row.get("taskId")
    attempt_id = row.get("attemptId")
    if not task_id:
        continue

    task_obj = parse_last_json_object(run(f"./run.sh --headless query task {task_id} --output json"))
    status = task_obj.get("status")
    execution = task_obj.get("execution") or {}
    phase = execution.get("phase")
    started_at = parse_iso(execution.get("startedAt"))
    age_s = int((now - started_at).total_seconds()) if started_at else -1
    executor_type = (task_obj.get("config") or {}).get("executorType")

    # Only judge stale remote-command-like paths.
    if status != "running" or phase != "executing" or age_s < MIN_STALE:
        continue
    if EXEC_FILTER == "ssh" and executor_type != "ssh":
        continue

    # Check remote process match by task/attempt token.
    task_match_targets: list[str] = []
    attempt_token = ""
    if isinstance(attempt_id, str) and attempt_id:
        attempt_token = attempt_id.split("-a")[-1][:10]
    remote_matches: list[dict] = []
    remote_failures: list[str] = []
    checked_targets: list[str] = []
    for target_id, remote_result in remote_ps.items():
        checked_targets.append(target_id)
        if not remote_result.get("ok"):
            remote_failures.append(target_id)
            continue
        ps_out = remote_result.get("stdout") or ""
        if task_id in ps_out:
            task_match_targets.append(target_id)
            remote_matches.append({"target": target_id, "matchBy": "taskId"})
            continue
        if attempt_id and attempt_id in ps_out:
            task_match_targets.append(target_id)
            remote_matches.append({"target": target_id, "matchBy": "attemptId"})
            continue
        if attempt_token and attempt_token in ps_out:
            task_match_targets.append(target_id)
            remote_matches.append({"target": target_id, "matchBy": "attemptToken"})
            continue

    # Check for terminal event after this attempt started.
    events = parse_jsonl_events(run(f"./run.sh --headless query audit {task_id} --output jsonl"))
    terminal_after_start = False
    terminal_after_start_event: Optional[dict] = None
    last_terminal_event: Optional[dict] = None
    if started_at:
        for ev in events:
            if ev.get("eventType") not in terminal_events:
                continue
            ev_at = parse_audit_created_at(ev.get("createdAt"))
            if ev_at and (
                last_terminal_event is None
                or ev_at > (parse_audit_created_at(last_terminal_event.get("createdAt")) or datetime.min.replace(tzinfo=timezone.utc))
            ):
                last_terminal_event = ev
            if ev_at and ev_at >= started_at:
                terminal_after_start = True
                terminal_after_start_event = ev
                break

    if not task_match_targets and not terminal_after_start:
        suspects.append(
            {
                "taskId": task_id,
                "attemptId": attempt_id or "",
                "executorType": executor_type or "",
                "ageSeconds": age_s,
                "startedAt": execution.get("startedAt") or "",
                "lastHeartbeatAt": execution.get("lastHeartbeatAt") or "",
                "checkedTargets": checked_targets,
                "remoteFailures": remote_failures,
                "remoteMatches": remote_matches,
                "lastTerminalEvent": last_terminal_event or {},
                "terminalAfterStartEvent": terminal_after_start_event or {},
            }
        )
    if STRICT_MODE:
        considered.append(
            {
                "taskId": task_id,
                "attemptId": attempt_id or "",
                "executorType": executor_type or "",
                "ageSeconds": age_s,
                "startedAt": execution.get("startedAt") or "",
                "lastHeartbeatAt": execution.get("lastHeartbeatAt") or "",
                "checkedTargets": checked_targets,
                "remoteFailures": remote_failures,
                "remoteMatches": remote_matches,
                "lastTerminalEvent": last_terminal_event or {},
                "terminalAfterStartEvent": terminal_after_start_event or {},
                "isSuspect": (not task_match_targets and not terminal_after_start),
            }
        )

print("repro-summary:")
print(f"  running_tasks_total: {len(running)}")
print(f"  stale_threshold_s : {MIN_STALE}")
print(f"  executor_filter   : {EXEC_FILTER}")
print(f"  configured_remotes: {len(remote_hosts)}")
print(f"  strict_mode       : {str(STRICT_MODE).lower()}")
if STRICT_MODE:
    print(f"  considered_tasks  : {len(considered)}")
print(f"  suspects          : {len(suspects)}")

if suspects:
    print("")
    print("suspects (running/executing, no remote process match, no terminal event after start):")
    print("task_id\tage_s\texecutor\tstarted_at\tlast_heartbeat\tattempt_id")
    for s in suspects:
        print(
            f"{s['taskId']}\t{s['ageSeconds']}\t{s['executorType']}\t"
            f"{s['startedAt']}\t{s['lastHeartbeatAt']}\t{s['attemptId']}"
        )

if STRICT_MODE and suspects:
    print("")
    print("strict-evidence:")
    for s in suspects:
        print(f"- task_id: {s['taskId']}")
        print(f"  attempt_id: {s['attemptId']}")
        print(f"  executor: {s['executorType']}")
        print(f"  age_seconds: {s['ageSeconds']}")
        print(f"  started_at: {s['startedAt']}")
        print(f"  last_heartbeat_at: {s['lastHeartbeatAt']}")
        print(f"  remote_targets_checked: {','.join(s['checkedTargets']) if s['checkedTargets'] else '<none>'}")
        print(f"  remote_targets_unreachable: {','.join(s['remoteFailures']) if s['remoteFailures'] else '<none>'}")
        if s["remoteMatches"]:
            print("  remote_match: " + ",".join([f"{m['target']}({m['matchBy']})" for m in s["remoteMatches"]]))
        else:
            print("  remote_match: <none>")
        lte = s.get("lastTerminalEvent") or {}
        if lte:
            print(f"  last_terminal_event: {lte.get('eventType')} at {lte.get('createdAt')}")
        else:
            print("  last_terminal_event: <none>")
        ate = s.get("terminalAfterStartEvent") or {}
        if ate:
            print(f"  terminal_event_after_start: {ate.get('eventType')} at {ate.get('createdAt')}")
        else:
            print("  terminal_event_after_start: <none>")

observed = "bug" if suspects else "fixed"
print("")
print(f"observed: {observed}")
print(f"expect  : {EXPECT}")

if observed != EXPECT:
    sys.exit(1)
PY
