# UI/backend drift tracing

Use this when the GUI graph disagrees with backend truth: a task changes in the
database, but the renderer misses it, shows it late, removes it unexpectedly, or
keeps a stale workflow rollup. This also covers workflow-level metadata drift —
e.g. detaching a workflow, deleting a workflow, or changing its merge mode not
showing up in the UI until a manual graph refresh.

## Two channels, two sets of trace streams

Task state (status, phase, execution) and workflow metadata (baseBranch,
externalDependencies, mergeMode) travel over **separate** channels with
separate publish paths:

- **Task-delta channel**: every task create/update/remove is a `TaskDelta`,
  published immediately, in order, with a monotonic `streamSequence`.
- **Workflow-metadata channel**: workflow-row field changes are *not* part of
  any `TaskDelta`. They reach the renderer only via a coalesced (50ms),
  sequence-less `invoker:workflows-changed` push, which silently no-ops if the
  window isn't interactive at flush time — there is no retry. Operations that
  go through this channel: `detach-workflow`, `delete`/`delete-task`/
  `delete-all`, `set merge-mode`, `set workflow` metadata, `fork-workflow`.

Each channel has its own pair of trace streams, enabled independently.

## Quick start

Launch the desktop app with all four trace flags enabled:

```bash
INVOKER_TRACE_UI_DELTA=1 INVOKER_TRACE_RENDERER_TASK_GRAPH=1 \
INVOKER_TRACE_UI_WORKFLOW_DELTA=1 INVOKER_TRACE_RENDERER_WORKFLOW_EVENTS=1 \
./run.sh
```

Then reproduce the drift. The traces are written to the Invoker home:

| Stream | File | Meaning |
| --- | --- | --- |
| Backend task-delta publish | `~/.invoker/invoker.log` | Main process accepted an authoritative task delta and attempted to publish it to the renderer. |
| Renderer task-graph receive | `~/.invoker/ui-task-graph-events.jsonl` | Renderer received a task graph event through `useTasks`. |
| Backend workflow-metadata publish | `~/.invoker/invoker.log` | `CoalescedWorkflowMetadataPublisher` flushed and attempted (or dropped) an `invoker:workflows-changed` push. |
| Renderer workflow-metadata receive | `~/.invoker/ui-workflow-events.jsonl` | Renderer received a workflow list through `onWorkflowsChanged` in `useTasks`. |

If you are using an isolated state directory, set `HOME` and `INVOKER_DB_DIR`
together. All three trace files (`invoker.log`, `ui-task-graph-events.jsonl`,
`ui-workflow-events.jsonl`) are keyed off `HOME`/`os.homedir()`, not
`INVOKER_DB_DIR` — set both to the same isolated root so the DB and the traces
live side by side.

```bash
tmp="$(mktemp -d /tmp/invoker-ui-drift.XXXXXX)"
HOME="$tmp/home" \
INVOKER_DB_DIR="$tmp/home/.invoker" \
INVOKER_TRACE_UI_DELTA=1 \
INVOKER_TRACE_RENDERER_TASK_GRAPH=1 \
./run.sh
```

## Read the traces

Backend rows are JSON log entries with `module: "ui"` and a `delta→ui:` payload.

```bash
python3 - <<'PY'
import json
from pathlib import Path

marker = "delta\u2192ui:"
for line in Path.home().joinpath(".invoker/invoker.log").read_text(errors="ignore").splitlines():
    try:
        row = json.loads(line)
    except Exception:
        continue
    msg = row.get("msg", "")
    if row.get("module") == "ui" and marker in msg:
        print(row.get("time"), msg.split(marker, 1)[1].strip())
PY
```

Renderer rows are JSONL entries. Delta events carry the renderer-visible payload
at `event.delta`.

```bash
python3 - <<'PY'
import json
from pathlib import Path

for line in Path.home().joinpath(".invoker/ui-task-graph-events.jsonl").read_text(errors="ignore").splitlines():
    try:
        row = json.loads(line)
    except Exception:
        continue
    event = row.get("event") or {}
    if event.get("type") == "delta":
        print(row.get("time"), json.dumps(event.get("delta"), separators=(",", ":")))
PY
```

For browser-console tracing inside the renderer, add `?traceTaskDeltas=1` to the
app URL. That is useful for checking renderer state transitions, but the JSONL
trace above is easier to archive and compare.

### Workflow-metadata trace

Backend rows use the same `invoker.log`, `module: "ui"`, but a `workflow→ui:`
marker. The payload includes `dropped` (true if the push was skipped because
the window wasn't interactive) and the coalescing stats
(`coalescedRequests`, `reasonCounts`) that produced this flush.

```bash
python3 - <<'PY'
import json
from pathlib import Path

marker = "workflow→ui:"
for line in Path.home().joinpath(".invoker/invoker.log").read_text(errors="ignore").splitlines():
    try:
        row = json.loads(line)
    except Exception:
        continue
    msg = row.get("msg", "")
    if row.get("module") == "ui" and marker in msg:
        print(row.get("time"), msg.split(marker, 1)[1].strip())
PY
```

Renderer rows go to `~/.invoker/ui-workflow-events.jsonl`, one line per
`onWorkflowsChanged` call, each carrying the full workflow list as received.

```bash
python3 - <<'PY'
import json
from pathlib import Path

for line in Path.home().joinpath(".invoker/ui-workflow-events.jsonl").read_text(errors="ignore").splitlines():
    try:
        row = json.loads(line)
    except Exception:
        continue
    event = row.get("event") or {}
    print(row.get("time"), json.dumps(event.get("workflows"), separators=(",", ":")))
PY
```

If backend rows show a publish (`dropped: false`) for a workflow field change
but no corresponding renderer row appears at all, the push was lost between
`webContents.send` and the renderer's IPC listener. If `dropped: true` appears
and no manual refresh follows, that is the exact "stays stale until refresh"
symptom — the backend gave up on the push entirely, and nothing but a snapshot
resync (`refreshTaskGraph()`) will recover it.

## Compare backend and renderer

For a manual investigation:

1. Start the app with both env vars enabled.
2. Reproduce exactly one workflow action, such as `retry`, `recreate`, or
   `rebase-recreate`.
3. Stop the app after the graph settles.
4. Compare `delta→ui:` entries from `invoker.log` with `event.delta` entries
   from `ui-task-graph-events.jsonl`, filtered to the workflow or task id.

Interpret mismatches this way:

| Finding | First place to inspect |
| --- | --- |
| Backend has a delta that renderer never records | Main-process publish path, IPC delivery, renderer subscription lifecycle. |
| Renderer records a remove/update without matching backend delta | Renderer hydration, snapshot replay, delta merge, or stale local state. |
| Both streams include the task, but final status differs | `taskStateVersion`, stream ordering, watermark handling, or snapshot-vs-delta merge behavior. |
| Backend never emits the expected task state | Orchestrator, persistence write, mutation path, or DB polling recovery. |
| Workflow rollup disagrees while tasks match | Workflow rollup projection or renderer workflow metadata refresh. |
| Backend `workflow→ui:` row has `dropped: true`, no manual refresh follows | `CoalescedWorkflowMetadataPublisher`'s `!uiInteractive` no-op — no retry exists today; only a snapshot resync recovers. |
| Workflow field (`baseBranch`, `externalDependencies`, `mergeMode`) changed on backend, no `workflow→ui:` row at all | The mutation path never called `requestWorkflowMetadataPublish` — check whether it went through the headless CLI dispatch (`executeHeadlessExec`), which does not call it, versus the GUI-IPC handler, which does. |

## Repro harness

The checked-in harness runs an isolated GUI owner, submits a one-task workflow,
runs `rebase-recreate`, and compares backend and renderer timelines:

```bash
bash scripts/repro/repro-ui-delta-timeline.sh
```

Keep artifacts even on success:

```bash
INVOKER_UI_DELTA_KEEP_TMP=1 bash scripts/repro/repro-ui-delta-timeline.sh
```

On failure, the script prints an artifacts directory containing:

| File | Use |
| --- | --- |
| `comparison.json` | Structured backend-vs-renderer timeline comparison and final-state mismatch reasons. |
| `backend.raw.log` | Copy of the traced backend `invoker.log`. |
| `renderer.raw.jsonl` | Copy of the renderer task graph JSONL trace. |

The same harness is covered by
`packages/app/e2e/ui-delta-timeline.spec.ts`.

This one harness only covers the task-delta channel (`run` → `rebase-recreate`).
For workflow-metadata-channel scenarios — `detach-workflow`, `delete`,
`set merge-mode`, and combinations/bursts of operations across both channels —
see `packages/app/e2e/drift/`, which drives a live Electron app via Playwright
(required for these scenarios, since the headless CLI dispatch path skips the
workflow-metadata publish entirely) and covers the full mutating-operation
catalog, single-operation drift checks, a dedicated thundering-herd burst
check, and a combinatorial battery runner.

## Operational notes

- Turn these env vars off after the investigation. They intentionally add noisy
  task graph logs.
- Trace files can include task ids, workflow ids, task descriptions, commands,
  paths, and status/error text. Treat them as operational logs.
- `INVOKER_TRACE_UI_DELTA=1` proves what the main process tried to send, not what
  the renderer rendered.
- `INVOKER_TRACE_RENDERER_TASK_GRAPH=1` proves what the renderer received, not
  whether React committed a specific visual frame.
- `INVOKER_TRACE_UI_WORKFLOW_DELTA=1` proves what the main process tried to
  send (or chose to drop) on the workflow-metadata channel.
- `INVOKER_TRACE_RENDERER_WORKFLOW_EVENTS=1` proves what the renderer received
  through `onWorkflowsChanged`, not whether the graph re-rendered from it.
