import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { WORKER_SUBMITTED_MUTATION_CHANNELS, WORKFLOW_RESUME_COMMAND_CHANNEL } from '@invoker/execution-engine';

import { buildWorkerMutationHandlers } from '../workflow-mutation-handlers.js';

const MAIN = path.resolve(__dirname, '..', 'main.ts');

// Incident 2026-08-06: the recovery worker's tick calls
// submitRegisteredOwnerWorkerMutation(...) directly (not through any IPC/GUI
// translation layer), so every channel it submits through needs a real
// `workflowMutationDispatcher.set(...)` entry in the standalone owner
// startup block. AUTO_FIX_BARE_RETRY_CHANNEL never got one — every recovery
// tick threw "No workflow mutation dispatcher registered for
// invoker:retry-task" and no failed task was ever auto-fixed. A prior PR
// (#6808) claimed to add this registration plus a regression test, but
// merged as a no-op (identical tree to its parent commit).
//
// That same gap later recurred for the owner-mode IPC-delegation block
// (only `AUTO_FIX_BARE_RETRY_CHANNEL` was ever proven there), and a
// mutation-channel audit found it recurring again for two entirely
// different workers (`invoker:approve`, `invoker:requeue-escalate`) that
// were never registered in either block. The root cause both times was the
// same: hand-written per-channel `.set(...)` calls with nothing forcing the
// standalone block, the owner-mode IPC-delegation block, and GUI mode to
// list the same channels.
//
// This test now covers every channel in `WORKER_SUBMITTED_MUTATION_CHANNELS`
// (the single canonical list — see `worker-mutation-channels.ts`) across both
// registration surfaces that actually dispatch worker-submitted mutations
// (standalone, owner-mode IPC delegation), instead of two hardcoded channels
// in one block, so a future channel added to the list without being wired
// everywhere fails here immediately.
//
// `gui-mutation-handlers.ts` is deliberately NOT checked here. It registers
// direct user-button IPC actions (Approve, Retry, Fix with Agent), a
// different code path that happens to share 3 of the 8 channel names because
// those actions are dual-purpose. It has no entry for background-only
// channels (requeue, requeue-escalate, infra-repair-*, start-ready) because
// there is no button for them, and that's correct: a GUI process acting as
// owner dispatches worker-submitted mutations through the same `if
// (ownerMode)` block checked below (see the `mode: 'gui'` label on its
// `headless.owner-ping` handler in main.ts) — there is no separate
// GUI-specific registration surface for these channels to audit.
function balancedBlockAfter(source: string, marker: string): string {
  const markerIdx = source.indexOf(marker);
  expect(markerIdx, `${marker} not found`).toBeGreaterThan(-1);
  const openBraceIdx = source.indexOf('{', markerIdx);
  let closeBraceIdx = -1;
  let depth = 0;
  for (let idx = openBraceIdx; idx < source.length; idx += 1) {
    if (source[idx] === '{') depth += 1;
    else if (source[idx] === '}') {
      depth -= 1;
      if (depth === 0) {
        closeBraceIdx = idx;
        break;
      }
    }
  }
  expect(closeBraceIdx, `${marker} closing brace not found`).toBeGreaterThan(-1);
  return source.slice(openBraceIdx, closeBraceIdx);
}

describe('worker mutation channel completeness', () => {
  it('buildWorkerMutationHandlers() returns a handler for every worker-submitted channel except invoker:start-ready', () => {
    const handlers = buildWorkerMutationHandlers({
      orchestrator: {} as never,
      commandService: {} as never,
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never,
      runHeadlessCommand: async () => ({ ok: true }),
      getTaskExecutor: () => ({}) as never,
      getMutationTiming: () => undefined,
      contextLabel: 'test',
    });

    for (const channel of WORKER_SUBMITTED_MUTATION_CHANNELS) {
      if (channel === WORKFLOW_RESUME_COMMAND_CHANNEL) continue; // intentionally hand-registered in both blocks, see workflow-mutation-handlers.ts
      expect(
        handlers.has(channel),
        `buildWorkerMutationHandlers() must return a handler for '${channel}' — add it in workflow-mutation-handlers.ts`,
      ).toBe(true);
    }
  });

  it('both main.ts registration blocks call the shared builder and the boot-time completeness assertion', () => {
    const source = readFileSync(MAIN, 'utf8');

    const standaloneBlock = balancedBlockAfter(source, 'if (standaloneMode && messageBus) {');
    expect(standaloneBlock, 'standalone block must call buildWorkerMutationHandlers').toContain('buildWorkerMutationHandlers(');
    expect(standaloneBlock, 'standalone block must call assertAllWorkerMutationChannelsRegistered').toContain('assertAllWorkerMutationChannelsRegistered(');

    const ipcMarkerIdx = source.indexOf('// ── IPC Delegation Handlers');
    expect(ipcMarkerIdx, 'IPC delegation handler marker not found').toBeGreaterThan(-1);
    const ownerBlock = balancedBlockAfter(source.slice(ipcMarkerIdx), 'if (ownerMode) {');
    expect(ownerBlock, 'owner-mode IPC delegation block must call buildWorkerMutationHandlers').toContain('buildWorkerMutationHandlers(');
    expect(ownerBlock, 'owner-mode IPC delegation block must call assertAllWorkerMutationChannelsRegistered').toContain('assertAllWorkerMutationChannelsRegistered(');
  });

  it.each(WORKER_SUBMITTED_MUTATION_CHANNELS)(
    "registers a dispatcher for worker-submitted channel '%s' in both main.ts blocks",
    (channel) => {
      // invoker:start-ready is intentionally hand-registered per block (see
      // workflow-mutation-handlers.ts) rather than routed through the shared
      // builder, so it still needs its own literal check here.
      if (channel !== WORKFLOW_RESUME_COMMAND_CHANNEL) return;

      const source = readFileSync(MAIN, 'utf8');
      const standaloneBlock = balancedBlockAfter(source, 'if (standaloneMode && messageBus) {');
      const ipcMarkerIdx = source.indexOf('// ── IPC Delegation Handlers');
      const ownerBlock = balancedBlockAfter(source.slice(ipcMarkerIdx), 'if (ownerMode) {');

      const isRegistered = (block: string): boolean =>
        block.includes(`workflowMutationDispatcher.set('${channel}'`) || block.includes(`workflowMutationDispatcher.set(${channel}`);

      expect(isRegistered(standaloneBlock), `standalone block must register '${channel}'`).toBe(true);
      expect(isRegistered(ownerBlock), `owner-mode IPC delegation block must register '${channel}'`).toBe(true);
    },
  );
});
