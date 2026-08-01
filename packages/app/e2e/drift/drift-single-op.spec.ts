/**
 * One drift check per catalog entry in scenario-catalog.ts. Some entries may
 * fail until their underlying drift bug is fixed -- this harness is for
 * reproducing and diagnosing drift, not a green-required CI gate.
 * See docs/ui-backend-drift-tracing.md.
 */
if (!process.env.INVOKER_TRACE_UI_DELTA) process.env.INVOKER_TRACE_UI_DELTA = '1';
if (!process.env.INVOKER_TRACE_RENDERER_TASK_GRAPH) process.env.INVOKER_TRACE_RENDERER_TASK_GRAPH = '1';
if (!process.env.INVOKER_TRACE_UI_WORKFLOW_DELTA) process.env.INVOKER_TRACE_UI_WORKFLOW_DELTA = '1';
if (!process.env.INVOKER_TRACE_RENDERER_WORKFLOW_EVENTS) process.env.INVOKER_TRACE_RENDERER_WORKFLOW_EVENTS = '1';

import { expect, test } from '../fixtures/electron-app.js';
import { DRIFT_SCENARIOS } from './scenario-catalog.js';
import { compareDriftTimeline } from './trace-compare.js';

test.describe('UI/backend drift — single operation', () => {
  for (const scenario of DRIFT_SCENARIOS) {
    test(`${scenario.id} (${scenario.channel}/${scenario.driver})`, async ({ page, testDir }) => {
      const ctx = await scenario.setup(page, testDir);
      const result = await scenario.act(ctx);
      // Let the coalescing windows (25ms task-graph batch, 50ms workflow-metadata
      // flush) settle before reading the trace files back.
      await page.waitForTimeout(1000);

      const comparison = compareDriftTimeline(scenario.channel, testDir, result.workflowId);
      if (process.env.INVOKER_DRIFT_DEBUG_DUMP === '1') {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const home = path.join(testDir, 'home', '.invoker');
        console.log('DEBUG workflowId', result.workflowId);
        console.log('DEBUG invoker.log', fs.readFileSync(path.join(home, 'invoker.log'), 'utf8'));
        console.log('DEBUG ui-task-graph-events.jsonl', fs.readFileSync(path.join(home, 'ui-task-graph-events.jsonl'), 'utf8'));
      }
      expect(comparison.ok, JSON.stringify({ scenario: scenario.id, ...comparison }, null, 2)).toBe(true);
    });
  }
});
