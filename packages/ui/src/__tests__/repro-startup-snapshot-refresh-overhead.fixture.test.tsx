/**
 * Fixture for scripts/repro/repro-startup-snapshot-refresh-overhead.sh.
 *
 * Drives the real `useTasks` hook in jsdom against a synthetic multi-workflow
 * preload bootstrap, captures the renderer ui-perf events (which the running
 * Electron app would persist to activity_log), and writes them to the path in
 * INVOKER_REPRO_STARTUP_SNAPSHOT_OUTPUT_PATH so the bash wrapper can assert
 * whether a non-forced `useTasks_snapshot_replace` lands after
 * `preload_bootstrap_sync` (the redundant post-bootstrap snapshot refresh).
 *
 * Gated by the env var so a normal `pnpm test` skips this test entirely
 * (large synthetic states would otherwise inflate test wall-clock).
 */

import { describe, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { writeFileSync } from 'node:fs';
import { useTasks } from '../hooks/useTasks.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState, WorkflowMeta } from '../types.js';

const outputPath = process.env.INVOKER_REPRO_STARTUP_SNAPSHOT_OUTPUT_PATH;
const workflowCount = Math.max(
  1,
  Number.parseInt(process.env.INVOKER_REPRO_WORKFLOW_COUNT ?? '8', 10) || 8,
);
const tasksPerWorkflow = Math.max(
  1,
  Number.parseInt(process.env.INVOKER_REPRO_TASKS_PER_WORKFLOW ?? '12', 10) || 12,
);

interface CapturedEvent {
  metric: string;
  data: Record<string, unknown>;
  relTsMs: number;
}

describe('repro: startup snapshot refresh overhead', () => {
  it.skipIf(Boolean(outputPath))(
    'only runs when INVOKER_REPRO_STARTUP_SNAPSHOT_OUTPUT_PATH is set',
    () => {
      // Placeholder so vitest never sees a file with zero registered tests.
    },
  );

  it.runIf(Boolean(outputPath))(
    'captures preload_bootstrap_sync and the follow-up useTasks_snapshot_replace',
    async () => {
      const tasks: TaskState[] = [];
      const workflows: WorkflowMeta[] = [];
      let depEdgeCount = 0;
      for (let w = 0; w < workflowCount; w++) {
        const wfId = `repro-wf-${w}`;
        workflows.push({
          id: wfId,
          name: `Repro workflow ${w}`,
          status: 'running',
        });
        let previousTaskId: string | undefined;
        for (let t = 0; t < tasksPerWorkflow; t++) {
          const taskId = `${wfId}/task-${t}`;
          const dependencies = previousTaskId ? [previousTaskId] : [];
          if (previousTaskId) depEdgeCount += 1;
          tasks.push(
            makeUITask({
              id: taskId,
              workflowId: wfId,
              description: `Repro task ${w}.${t}`,
              status: t === 0 ? 'running' : 'pending',
              dependencies,
            }),
          );
          previousTaskId = taskId;
        }
      }

      const bootstrapPayload = { tasks, workflows };
      const jsonSizeBytes = Buffer.byteLength(
        JSON.stringify(bootstrapPayload),
        'utf8',
      );

      (window as unknown as { __INVOKER_BOOTSTRAP__: unknown }).__INVOKER_BOOTSTRAP__ =
        bootstrapPayload;

      const startedAt = performance.now();
      const events: CapturedEvent[] = [];
      const reportUiPerf = vi.fn(
        (metric: string, data?: Record<string, unknown>) => {
          events.push({
            metric,
            data: data ?? {},
            relTsMs: performance.now() - startedAt,
          });
        },
      );

      // Mirror preload.ts: emit preload_bootstrap_sync once contextBridge has
      // exposed the bootstrap snapshot to the renderer.
      const preloadFetchDurationMs = Math.max(
        0.1,
        Math.round((jsonSizeBytes / (50 * 1024)) * 100) / 100,
      );
      reportUiPerf('preload_bootstrap_sync', {
        durationMs: preloadFetchDurationMs,
        taskCount: tasks.length,
        workflowCount: workflows.length,
        jsonSizeBytes,
      });

      // Simulate the redundant getTasks() IPC: it returns exactly the same
      // authoritative snapshot the bootstrap already carried.
      const getTasks = vi.fn(
        (_forceRefresh?: boolean) =>
          new Promise<{ tasks: TaskState[]; workflows: WorkflowMeta[] }>(
            (resolve) => {
              queueMicrotask(() => resolve({ tasks, workflows }));
            },
          ),
      );

      (window as unknown as { invoker: Record<string, unknown> }).invoker = {
        getTasks,
        reportUiPerf,
        onTaskDelta: vi.fn(() => () => {}),
        onWorkflowsChanged: vi.fn(() => () => {}),
        checkPrStatuses: vi.fn(),
      };

      renderHook(() => useTasks());

      // Wait for either the redundant replace, or the skip path that the fix
      // is expected to take (both are terminal events for this scenario).
      await waitFor(() => {
        const resolved = events.some(
          (e) =>
            e.metric === 'useTasks_snapshot_replace' ||
            e.metric === 'startup_snapshot_skipped_smaller_than_bootstrap' ||
            e.metric === 'startup_snapshot_applied',
        );
        if (!resolved) {
          throw new Error('snapshot resolution not observed yet');
        }
      });

      // Synthesize startup_graph_visible the same way TaskDAG.tsx emits it
      // once the snapshot has populated the DAG. We do not mount TaskDAG here
      // (it brings in elkjs/xyflow, irrelevant for the snapshot-refresh path),
      // so node/edge counts are computed from the same data the renderer
      // would have laid out: tasks + merge node per workflow, and the
      // dependency edges declared on the tasks themselves.
      const graphElapsedMs = performance.now() - startedAt;
      const nodeCount = tasks.length + workflows.length;
      reportUiPerf('startup_graph_visible', {
        nodeCount,
        edgeCount: depEdgeCount,
        elapsedMs: Math.round(graphElapsedMs),
      });

      writeFileSync(
        outputPath as string,
        `${JSON.stringify(
          {
            config: { workflowCount, tasksPerWorkflow },
            bootstrap: {
              taskCount: tasks.length,
              workflowCount: workflows.length,
              jsonSizeBytes,
              preloadFetchDurationMs,
            },
            events,
          },
          null,
          2,
        )}\n`,
      );
    },
  );
});
