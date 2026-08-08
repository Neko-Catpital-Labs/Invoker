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
  it('registers a dispatcher for every channel the auto-fix recovery worker submits through', () => {
    const source = readFileSync(MAIN, 'utf8');

    const guardIdx = source.indexOf('if (standaloneMode && messageBus) {');
    expect(guardIdx, 'standalone owner mutation-routing guard not found').toBeGreaterThan(-1);
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
    expect(closeBraceIdx, 'standalone owner mutation-routing guard closing brace not found').toBeGreaterThan(-1);
    const registrationBlock = source.slice(openBraceIdx, closeBraceIdx);

    // A handler is registered either by the channel's literal string or by
    // importing and passing its exported constant identifier — both forms
    // resolve to the same runtime channel name.
    const isRegistered = (channel: string, constantName: string): boolean =>
      registrationBlock.includes(`workflowMutationDispatcher.set('${channel}'`)
      || registrationBlock.includes(`workflowMutationDispatcher.set(${constantName}`);

    expect(
      isRegistered(AUTO_FIX_BARE_RETRY_CHANNEL, 'AUTO_FIX_BARE_RETRY_CHANNEL'),
      `standalone owner startup must register a workflowMutationDispatcher handler for '${AUTO_FIX_BARE_RETRY_CHANNEL}' `
        + '(the auto-fix recovery worker submits its free bare retry through this channel directly, '
        + 'bypassing any IPC/GUI translation layer)',
    ).toBe(true);

    expect(
      isRegistered(AUTO_FIX_COMMAND_CHANNEL, 'AUTO_FIX_COMMAND_CHANNEL'),
      `standalone owner startup must register a workflowMutationDispatcher handler for '${AUTO_FIX_COMMAND_CHANNEL}' `
        + '(the auto-fix recovery worker submits its AI fix attempts through this channel directly, '
        + 'bypassing any IPC/GUI translation layer)',
    ).toBe(true);
  });
});
