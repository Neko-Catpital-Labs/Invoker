#!/usr/bin/env bash

write_start_running_mece_mock_fixtures() {
  local out_dir="$1"
  mkdir -p "$out_dir"

  cat >"$out_dir/tasks.jsonl" <<'EOF'
{"id":"wf-mock-launch/task-a","workflowId":"wf-mock-launch","status":"failed","runnerKind":"ssh","launchPhase":"launching","launchStartedAt":"2026-05-15T08:39:54Z","launchCompletedAt":null,"startedAt":"2026-05-15T08:40:56Z","completedAt":"2026-05-15T08:40:56Z","error":"Launch stalled: task remained in running/launching for 60s without a spawned execution handle"}
{"id":"wf-mock-remote/task-b","workflowId":"wf-mock-remote","status":"failed","runnerKind":"ssh","launchPhase":"executing","launchStartedAt":"2026-05-15T07:25:54Z","launchCompletedAt":"2026-05-15T07:26:18Z","startedAt":"2026-05-15T07:26:18Z","completedAt":"2026-05-15T07:29:18Z","error":"Execution stalled: task remained in running/executing for 180s without a live execution handle and no completion signal from executor (remote workload heartbeat stale)."}
{"id":"wf-mock-git/task-c","workflowId":"wf-mock-git","status":"failed","runnerKind":"ssh","launchPhase":"launching","launchStartedAt":"2026-05-15T07:26:36Z","launchCompletedAt":"2026-05-15T07:26:47Z","startedAt":"2026-05-15T07:26:47Z","completedAt":"2026-05-15T07:26:47Z","error":"Error: Executor startup failed (ssh): SSH remote script failed (exit=128, phase=bootstrap_clone_fetch)\nSTDERR:\nerror: could not lock config file .git/config: File exists\nfatal: could not set 'remote.invoker-branches.url'"}
{"id":"wf-mock-electron/task-d","workflowId":"wf-mock-electron","status":"failed","runnerKind":"ssh","launchPhase":"executing","launchStartedAt":"2026-05-15T07:25:54Z","launchCompletedAt":"2026-05-15T07:26:12Z","startedAt":"2026-05-15T07:26:12Z","completedAt":"2026-05-15T07:26:25Z","error":"[SshExecutor] Provisioning remote worktree with: pnpm install --frozen-lockfile...\n. postinstall$ node scripts/electron.cjs --ensure-only\n. postinstall: Electron is still unavailable after running its installer.\n. postinstall: Failed\nELIFECYCLE Command failed with exit code 1."}
{"id":"wf-mock-stale/task-e","workflowId":"wf-mock-stale","status":"failed","runnerKind":"worktree","launchPhase":"launching","launchStartedAt":"2026-05-13T18:11:40Z","launchCompletedAt":null,"startedAt":"2026-05-15T07:29:37Z","completedAt":"2026-05-15T07:29:37Z","error":"Launch stalled: task remained in running/launching for 60s without a spawned execution handle"}
{"id":"wf-mock-mixed/task-f","workflowId":"wf-mock-mixed","status":"failed","runnerKind":"ssh","launchPhase":"launching","launchStartedAt":"2026-05-15T07:37:02Z","launchCompletedAt":null,"startedAt":"2026-05-15T07:38:03Z","completedAt":"2026-05-15T07:38:03Z","error":"[Fix with Agent failed] fixWithAgent: task has no valid workspace (workspacePath=undefined).\n\nLaunch stalled: task remained in running/launching for 60s without a spawned execution handle"}
EOF

  cat >"$out_dir/logs.jsonl" <<'EOF'
{"time":"2026-05-15T07:25:54Z","module":"workflow-mutation-timing","workflowId":"wf-mock-wrapper","channel":"headless.exec","intentId":1,"function":"PersistedWorkflowMutationCoordinator.executeIntent","phase":"completed","durationMs":4444527}
{"time":"2026-05-15T07:25:54Z","module":"workflow-mutation-timing","workflowId":"wf-mock-wrapper","channel":"headless.exec","intentId":1,"function":"PersistedWorkflowMutationCoordinator.dispatch","phase":"completed","durationMs":4444525}
{"time":"2026-05-15T07:25:54Z","module":"workflow-mutation-timing","workflowId":"wf-mock-scoped","channel":"headless.exec","intentId":1,"function":"dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks","phase":"completed","durationMs":4416603}
{"time":"2026-05-15T07:26:00Z","module":"workflow-mutation-timing","workflowId":"wf-mock-repo","channel":"headless.exec","intentId":2,"function":"RepoPool.refreshMirrorForRebase.repoChainWait","phase":"completed","durationMs":209341}
{"time":"2026-05-15T07:26:01Z","module":"workflow-mutation-timing","workflowId":"wf-mock-recreate","channel":"headless.exec","intentId":2,"function":"workflow-actions.recreateWorkflowFromFreshBase.preparePoolForRebaseRetry","phase":"completed","durationMs":217990}
{"time":"2026-05-15T07:26:02Z","module":"workflow-mutation-timing","workflowId":"wf-mock-recreate","channel":"headless.exec","intentId":2,"function":"workflow-actions.recreateWorkflowFromFreshBase.orchestrator","phase":"completed","durationMs":218016}
{"time":"2026-05-15T07:23:44Z","module":"process","msg":"uncaughtException: Error: out of memory at sql-wasm.js"}
EOF
}

run_start_running_mece_python_check() {
  local issue="$1"
  local tasks_path="$2"
  local logs_path="$3"

  python3 - "$issue" "$tasks_path" "$logs_path" <<'PY'
import json
import sys
from datetime import datetime
from pathlib import Path

issue = sys.argv[1]
tasks_path = Path(sys.argv[2])
logs_path = Path(sys.argv[3])

def load_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

def parse_ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None

tasks = load_jsonl(tasks_path)
logs = load_jsonl(logs_path)

def slow_logs(predicate):
    return [
        row for row in logs
        if row.get("module") == "workflow-mutation-timing"
        and row.get("durationMs", 0) >= 60_000
        and predicate(row)
    ]

checks = {
    "launch-handle-not-created": lambda: [
        task for task in tasks
        if "Launch stalled: task remained in running/launching" in task.get("error", "")
        and not task.get("launchCompletedAt")
    ],
    "remote-execution-handle-lost": lambda: [
        task for task in tasks
        if "Execution stalled: task remained in running/executing" in task.get("error", "")
        and task.get("launchCompletedAt")
    ],
    "remote-git-bootstrap-lock": lambda: [
        task for task in tasks
        if "bootstrap_clone_fetch" in task.get("error", "")
        and "could not lock config file .git/config" in task.get("error", "")
    ],
    "remote-electron-provisioning": lambda: [
        task for task in tasks
        if "Provisioning remote worktree" in task.get("error", "")
        and "Electron is still unavailable" in task.get("error", "")
    ],
    "repo-mirror-contention": lambda: slow_logs(
        lambda row: row.get("function") == "RepoPool.refreshMirrorForRebase.repoChainWait"
    ),
    "recreate-rebase-preparation-stall": lambda: slow_logs(
        lambda row: row.get("function") in {
            "workflow-actions.recreateWorkflowFromFreshBase.preparePoolForRebaseRetry",
            "workflow-actions.recreateWorkflowFromFreshBase.orchestrator",
        }
    ),
    "scoped-dispatch-blocking": lambda: slow_logs(
        lambda row: row.get("function") == "dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks"
    ),
    "mutation-wrapper-over-attribution": lambda: slow_logs(
        lambda row: row.get("function") in {
            "PersistedWorkflowMutationCoordinator.executeIntent",
            "PersistedWorkflowMutationCoordinator.dispatch",
        }
    ),
    "sqljs-oom-interruption": lambda: [
        row for row in logs
        if "out of memory" in (row.get("msg", "") + row.get("error", "")).lower()
    ],
    "stale-launch-metadata": lambda: [
        task for task in tasks
        if task.get("launchStartedAt")
        and task.get("completedAt")
        and (parse_ts(task["completedAt"]) - parse_ts(task["launchStartedAt"])).total_seconds() > 3600
    ],
    "mixed-error-attribution": lambda: [
        task for task in tasks
        if "[Fix with Agent failed]" in task.get("error", "")
        and "Launch stalled" in task.get("error", "")
    ],
}

expected = {
    "launch-handle-not-created": 3,
    "remote-execution-handle-lost": 1,
    "remote-git-bootstrap-lock": 1,
    "remote-electron-provisioning": 1,
    "repo-mirror-contention": 1,
    "recreate-rebase-preparation-stall": 2,
    "scoped-dispatch-blocking": 1,
    "mutation-wrapper-over-attribution": 2,
    "sqljs-oom-interruption": 1,
    "stale-launch-metadata": 1,
    "mixed-error-attribution": 1,
}

if issue not in checks:
    raise SystemExit(f"unknown issue: {issue}")

matches = checks[issue]()
want = expected[issue]
got = len(matches)
print(f"{issue}: expected={want} observed={got}")
if matches:
    sample = matches[0]
    print(f"sample={sample.get('id') or sample.get('function') or sample.get('msg')}")
if got != want:
    raise SystemExit(1)
PY
}

run_start_running_mece_issue_repro() {
  local issue="$1"
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-${issue}.XXXXXX")"
  write_start_running_mece_mock_fixtures "$tmp_dir"
  local status=0
  run_start_running_mece_python_check "$issue" "$tmp_dir/tasks.jsonl" "$tmp_dir/logs.jsonl" || status=$?
  rm -rf "$tmp_dir"
  return "$status"
}
