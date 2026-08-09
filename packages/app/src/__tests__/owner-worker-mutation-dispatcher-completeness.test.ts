import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { AUTO_FIX_BARE_RETRY_CHANNEL, AUTO_FIX_COMMAND_CHANNEL } from '@invoker/execution-engine';

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
describe('standalone owner worker mutation dispatcher completeness', () => {
  function balancedBlockAfter(source: string, marker: string): string {
    const guardIdx = source.indexOf(marker);
    expect(guardIdx, `${marker} not found`).toBeGreaterThan(-1);
    const openBraceIdx = source.indexOf('{', guardIdx);
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

  function isRegistered(registrationBlock: string, channel: string, constantName: string): boolean {
    return registrationBlock.includes(`workflowMutationDispatcher.set('${channel}'`)
      || registrationBlock.includes(`workflowMutationDispatcher.set(${constantName}`);
  }

  it('registers a dispatcher for every auto-fix channel the standalone owner startup block submits through', () => {
    const source = readFileSync(MAIN, 'utf8');
    const registrationBlock = balancedBlockAfter(source, 'if (standaloneMode && messageBus) {');

    // A handler is registered either by the channel's literal string or by
    // importing and passing its exported constant identifier — both forms
    // resolve to the same runtime channel name.
    expect(
      isRegistered(registrationBlock, AUTO_FIX_BARE_RETRY_CHANNEL, 'AUTO_FIX_BARE_RETRY_CHANNEL'),
      `standalone owner startup must register a workflowMutationDispatcher handler for '${AUTO_FIX_BARE_RETRY_CHANNEL}' `
        + '(the auto-fix recovery worker submits its free bare retry through this channel directly, '
        + 'bypassing any IPC/GUI translation layer)',
    ).toBe(true);

    expect(
      isRegistered(registrationBlock, AUTO_FIX_COMMAND_CHANNEL, 'AUTO_FIX_COMMAND_CHANNEL'),
      `standalone owner startup must register a workflowMutationDispatcher handler for '${AUTO_FIX_COMMAND_CHANNEL}' `
        + '(the auto-fix recovery worker submits its AI fix attempts through this channel directly, '
        + 'bypassing any IPC/GUI translation layer)',
    ).toBe(true);
  });

  it('registers auto-fix bare retry in the owner-mode delegation dispatcher block', () => {
    const source = readFileSync(MAIN, 'utf8');
    const marker = '// ── IPC Delegation Handlers';
    const markerIdx = source.indexOf(marker);
    expect(markerIdx, 'IPC delegation handler marker not found').toBeGreaterThan(-1);
    const registrationBlock = balancedBlockAfter(source.slice(markerIdx), 'if (ownerMode) {');

    expect(
      isRegistered(registrationBlock, AUTO_FIX_BARE_RETRY_CHANNEL, 'AUTO_FIX_BARE_RETRY_CHANNEL'),
      `owner-mode delegation startup must register a workflowMutationDispatcher handler for '${AUTO_FIX_BARE_RETRY_CHANNEL}' `
        + '(standalone owner workers submit the bare retry through this channel directly)',
    ).toBe(true);
  });
});
