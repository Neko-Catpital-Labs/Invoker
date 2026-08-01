/**
 * Backend-vs-renderer drift comparator, generalized from the Python
 * compare_timelines() logic in scripts/repro/repro-ui-delta-timeline.sh to
 * cover both trace channels documented in docs/ui-backend-drift-tracing.md.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface AcceptanceFailure {
  kind: string;
  message: string;
  /**
   * Whether this finding alone should fail the drift check. Non-blocking
   * findings (e.g. a duplicate re-send by the DB-polling reconciliation
   * safety net, renderer-task-feed.ts:335-355) are reported for diagnostic
   * value but don't indicate visible drift by themselves -- only a wrong
   * *final* state, or the renderer never seeing something at all, does.
   */
  blocking: boolean;
  [key: string]: unknown;
}

export interface TimelineComparisonResult {
  ok: boolean;
  acceptanceFailures: AcceptanceFailure[];
  backendCount: number;
  rendererCount: number;
}

export function traceHomeDir(testDir: string): string {
  return path.join(testDir, 'home', '.invoker');
}

function readJsonLines(filePath: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return rows;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val).sort().reduce((acc: Record<string, unknown>, key) => {
        acc[key] = (val as Record<string, unknown>)[key];
        return acc;
      }, {});
    }
    return val;
  });
}

// ── Task-delta channel ──────────────────────────────────────

interface TaskDeltaRecord {
  time?: string;
  delta: Record<string, unknown>;
}

function taskIdFor(delta: Record<string, unknown>): string | undefined {
  if (delta.type === 'created') {
    const task = (delta.task ?? {}) as Record<string, unknown>;
    return task.id as string | undefined;
  }
  return delta.taskId as string | undefined;
}

function belongsToWorkflow(delta: unknown, workflowId: string): boolean {
  if (!delta || typeof delta !== 'object') return false;
  const record = delta as Record<string, unknown>;
  const mergeId = `__merge__${workflowId}`;
  if (record.type === 'created') {
    const task = (record.task ?? {}) as Record<string, unknown>;
    const taskId = String(task.id ?? '');
    const config = (task.config ?? {}) as Record<string, unknown>;
    return (
      taskId === mergeId ||
      taskId === workflowId ||
      config.workflowId === workflowId ||
      taskId.startsWith(`${workflowId}/`)
    );
  }
  const taskId = String(record.taskId ?? '');
  return taskId === mergeId || taskId === workflowId || taskId.startsWith(`${workflowId}/`);
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'streamSequence') continue;
      out[key] = scrub(val);
    }
    return out;
  }
  return value;
}

function readBackendTaskDeltas(testDir: string, workflowId: string): TaskDeltaRecord[] {
  const logPath = path.join(traceHomeDir(testDir), 'invoker.log');
  const marker = 'delta→ui:';
  const records: TaskDeltaRecord[] = [];
  for (const row of readJsonLines(logPath)) {
    const msg = String(row.msg ?? '');
    if (row.module !== 'ui' || !msg.includes(marker)) continue;
    const raw = msg.slice(msg.indexOf(marker) + marker.length).trim();
    let delta: Record<string, unknown>;
    try {
      delta = JSON.parse(raw);
    } catch {
      continue;
    }
    if (belongsToWorkflow(delta, workflowId)) {
      records.push({ time: row.time as string | undefined, delta });
    }
  }
  return records;
}

function readRendererTaskDeltas(testDir: string, workflowId: string): TaskDeltaRecord[] {
  const jsonlPath = path.join(traceHomeDir(testDir), 'ui-task-graph-events.jsonl');
  const records: TaskDeltaRecord[] = [];
  for (const row of readJsonLines(jsonlPath)) {
    const event = (row.event ?? {}) as Record<string, unknown>;
    if (event.type !== 'delta') continue;
    const delta = event.delta as Record<string, unknown>;
    if (belongsToWorkflow(delta, workflowId)) {
      records.push({ time: row.time as string | undefined, delta });
    }
  }
  return records;
}

function finalTaskState(records: TaskDeltaRecord[]): Map<string, Record<string, unknown>> {
  const tasks = new Map<string, Record<string, unknown>>();
  for (const { delta } of records) {
    const id = taskIdFor(delta);
    if (!id) continue;
    if (delta.type === 'created') {
      tasks.set(id, delta.task as Record<string, unknown>);
    } else if (delta.type === 'removed') {
      tasks.delete(id);
    } else if (delta.type === 'updated') {
      const previous = tasks.get(id) ?? {};
      const changes = (delta.changes ?? {}) as Record<string, unknown>;
      tasks.set(id, { ...previous, ...changes, taskStateVersion: delta.taskStateVersion });
    }
  }
  return tasks;
}

function summarizeTasks(tasks: Map<string, Record<string, unknown>>): Record<string, { status?: unknown; phase?: unknown }> {
  const out: Record<string, { status?: unknown; phase?: unknown }> = {};
  for (const [id, task] of tasks) {
    const execution = (task.execution ?? {}) as Record<string, unknown>;
    out[id] = { status: task.status, phase: execution.phase };
  }
  return out;
}

/** Diffs the task-delta channel (delta→ui: / ui-task-graph-events.jsonl) for one workflow. */
export function compareTaskDeltaTimeline(testDir: string, workflowId: string): TimelineComparisonResult {
  const backend = readBackendTaskDeltas(testDir, workflowId);
  const renderer = readRendererTaskDeltas(testDir, workflowId);
  const backendCanonical = backend.map((r) => scrub(r.delta));
  const rendererCanonical = renderer.map((r) => scrub(r.delta));

  const acceptanceFailures: AcceptanceFailure[] = [];
  const minLen = Math.min(backendCanonical.length, rendererCanonical.length);
  for (let i = 0; i < minLen; i += 1) {
    if (stableStringify(backendCanonical[i]) !== stableStringify(rendererCanonical[i])) {
      // Informational only: the DB-polling reconciliation safety net
      // (renderer-task-feed.ts:335-355) can independently re-publish a
      // duplicate `type: 'created'` for a task the renderer already knows
      // about (most often triggered by test-only shortcuts like
      // injectTaskStates that write the DB directly). That reorders/pads the
      // raw sequence without changing the converged final state, so it
      // doesn't indicate drift by itself -- see the final-state check below.
      acceptanceFailures.push({
        kind: 'sequence-mismatch',
        message: `backend and renderer task-delta timelines diverge at index ${i}`,
        blocking: false,
        index: i,
        backend: backend[i],
        renderer: renderer[i],
      });
      break;
    }
  }
  if (backendCanonical.length !== rendererCanonical.length) {
    const rendererHasFewer = backendCanonical.length > rendererCanonical.length;
    acceptanceFailures.push({
      kind: rendererHasFewer ? 'missing-renderer-event' : 'renderer-extra-event',
      message: `backend emitted ${backendCanonical.length} task delta(s), renderer recorded ${rendererCanonical.length}`,
      // Renderer receiving fewer events than the backend sent is the real
      // signature of drift; renderer receiving *more* (harmless duplicate
      // resends) is not, on its own.
      blocking: rendererHasFewer,
      backendCount: backendCanonical.length,
      rendererCount: rendererCanonical.length,
    });
  }

  const backendFinal = summarizeTasks(finalTaskState(backend));
  const rendererFinal = summarizeTasks(finalTaskState(renderer));
  if (stableStringify(backendFinal) !== stableStringify(rendererFinal)) {
    acceptanceFailures.push({
      kind: 'final-task-state-mismatch',
      message: 'final backend and renderer task states disagree',
      blocking: true,
      backend: backendFinal,
      renderer: rendererFinal,
    });
  }

  return {
    ok: !acceptanceFailures.some((failure) => failure.blocking),
    acceptanceFailures,
    backendCount: backendCanonical.length,
    rendererCount: rendererCanonical.length,
  };
}

// ── Workflow-metadata channel ───────────────────────────────

interface WorkflowMetadataRecord {
  time?: string;
  dropped?: boolean;
  coalescedRequests?: number;
  reasonCounts?: Record<string, number>;
  workflows: Array<Record<string, unknown>>;
}

interface WorkflowSnapshotFields {
  id: unknown;
  status?: unknown;
  mergeMode?: unknown;
  baseBranch?: unknown;
  externalDependencies?: unknown;
  generation?: unknown;
}

function pickWorkflowFields(workflow: Record<string, unknown> | undefined): WorkflowSnapshotFields {
  return {
    id: workflow?.id,
    status: workflow?.status,
    mergeMode: workflow?.mergeMode,
    baseBranch: workflow?.baseBranch,
    externalDependencies: workflow?.externalDependencies,
    generation: workflow?.generation,
  };
}

function readBackendWorkflowMetadataEvents(testDir: string): WorkflowMetadataRecord[] {
  const logPath = path.join(traceHomeDir(testDir), 'invoker.log');
  const marker = 'workflow→ui:';
  const records: WorkflowMetadataRecord[] = [];
  for (const row of readJsonLines(logPath)) {
    const msg = String(row.msg ?? '');
    if (row.module !== 'ui' || !msg.includes(marker)) continue;
    const raw = msg.slice(msg.indexOf(marker) + marker.length).trim();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      continue;
    }
    records.push({
      time: row.time as string | undefined,
      dropped: payload.dropped as boolean | undefined,
      coalescedRequests: payload.coalescedRequests as number | undefined,
      reasonCounts: payload.reasonCounts as Record<string, number> | undefined,
      workflows: (payload.workflows as Array<Record<string, unknown>>) ?? [],
    });
  }
  return records;
}

function readRendererWorkflowMetadataEvents(testDir: string): WorkflowMetadataRecord[] {
  const jsonlPath = path.join(traceHomeDir(testDir), 'ui-workflow-events.jsonl');
  const records: WorkflowMetadataRecord[] = [];
  for (const row of readJsonLines(jsonlPath)) {
    const event = (row.event ?? {}) as Record<string, unknown>;
    if (event.type !== 'workflows-changed') continue;
    records.push({
      time: row.time as string | undefined,
      workflows: (event.workflows as Array<Record<string, unknown>>) ?? [],
    });
  }
  return records;
}

/** Diffs the workflow-metadata channel (workflow→ui: / ui-workflow-events.jsonl) for one workflow. */
export function compareWorkflowMetadataTimeline(testDir: string, workflowId: string): TimelineComparisonResult {
  const backend = readBackendWorkflowMetadataEvents(testDir);
  const renderer = readRendererWorkflowMetadataEvents(testDir);
  const acceptanceFailures: AcceptanceFailure[] = [];

  const backendRows = backend.filter((row) => row.workflows.some((w) => w?.id === workflowId));
  const rendererRows = renderer.filter((row) => row.workflows.some((w) => w?.id === workflowId));

  if (backendRows.length === 0) {
    // Every scenario tagged 'workflow-metadata' is expected to trigger a publish
    // attempt for its workflow. Zero rows means the mutation path never called
    // requestWorkflowMetadataPublish at all (e.g. the headless CLI dispatch gap
    // documented in docs/ui-backend-drift-tracing.md) -- that is itself a drift
    // finding, not something to pass silently.
    return {
      ok: false,
      acceptanceFailures: [{
        kind: 'workflow-metadata-publish-never-triggered',
        message: `no workflow→ui: publish was observed for ${workflowId} at all after a workflow-metadata-channel operation`,
        blocking: true,
      }],
      backendCount: 0,
      rendererCount: renderer.filter((row) => row.workflows.some((w) => w?.id === workflowId)).length,
    };
  }

  const lastBackendRow = backendRows[backendRows.length - 1];
  const lastNonDroppedBackendRow = [...backendRows].reverse().find((row) => row.dropped !== true);

  if (rendererRows.length === 0) {
    acceptanceFailures.push({
      kind: 'workflow-metadata-never-republished',
      message: `backend published ${backendRows.length} workflow-metadata event(s) for ${workflowId} but the renderer never received onWorkflowsChanged for it`,
      blocking: true,
      backendCount: backendRows.length,
    });
  }

  if (lastBackendRow.dropped === true) {
    acceptanceFailures.push({
      kind: 'workflow-publish-dropped-noninteractive',
      message: `last workflow-metadata publish for ${workflowId} was dropped (window not interactive); no retry exists today`,
      blocking: true,
      coalescedRequests: lastBackendRow.coalescedRequests,
      reasonCounts: lastBackendRow.reasonCounts,
    });
  }

  if (lastNonDroppedBackendRow && rendererRows.length > 0) {
    const backendWorkflow = pickWorkflowFields(lastNonDroppedBackendRow.workflows.find((w) => w?.id === workflowId));
    const lastRendererRow = rendererRows[rendererRows.length - 1];
    const rendererWorkflow = pickWorkflowFields(lastRendererRow.workflows.find((w) => w?.id === workflowId));
    if (stableStringify(backendWorkflow) !== stableStringify(rendererWorkflow)) {
      acceptanceFailures.push({
        kind: 'stale-workflow-field-after-op',
        message: `renderer's workflow fields for ${workflowId} disagree with the last successfully published backend state`,
        blocking: true,
        backend: backendWorkflow,
        renderer: rendererWorkflow,
      });
    }
  }

  return {
    ok: !acceptanceFailures.some((failure) => failure.blocking),
    acceptanceFailures,
    backendCount: backendRows.length,
    rendererCount: rendererRows.length,
  };
}

/** Dispatches to the right comparator for a scenario's channel. */
export function compareDriftTimeline(
  channel: 'task-delta' | 'workflow-metadata',
  testDir: string,
  workflowId: string,
): TimelineComparisonResult {
  return channel === 'task-delta'
    ? compareTaskDeltaTimeline(testDir, workflowId)
    : compareWorkflowMetadataTimeline(testDir, workflowId);
}
