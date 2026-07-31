# UI/backend drift tracing

Use this when the GUI graph disagrees with backend truth: a task changes in the
database, but the renderer misses it, shows it late, removes it unexpectedly, or
keeps a stale workflow rollup.

## Quick start

Launch the desktop app with both trace streams enabled:

```bash
INVOKER_TRACE_UI_DELTA=1 INVOKER_TRACE_RENDERER_TASK_GRAPH=1 ./run.sh
```

Then reproduce the drift. The two traces are written to the Invoker home:

| Stream | File | Meaning |
| --- | --- | --- |
| Backend delta publish | `~/.invoker/invoker.log` | Main process accepted an authoritative task delta and attempted to publish it to the renderer. |
| Renderer task-graph receive | `~/.invoker/ui-task-graph-events.jsonl` | Renderer received a task graph event through `useTasks`. |

If you are using an isolated state directory, set `HOME` and `INVOKER_DB_DIR`
together. The backend log follows `INVOKER_DB_DIR`; the renderer trace path uses
the process home directory.

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

## Operational notes

- Turn these env vars off after the investigation. They intentionally add noisy
  task graph logs.
- Trace files can include task ids, workflow ids, task descriptions, commands,
  paths, and status/error text. Treat them as operational logs.
- `INVOKER_TRACE_UI_DELTA=1` proves what the main process tried to send, not what
  the renderer rendered.
- `INVOKER_TRACE_RENDERER_TASK_GRAPH=1` proves what the renderer received, not
  whether React committed a specific visual frame.
