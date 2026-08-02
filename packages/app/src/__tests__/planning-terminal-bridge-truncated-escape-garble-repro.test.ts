/**
 * Reproduces a THIRD occurrence of the same bug class already fixed once in
 * embedded-terminal-manager.ts's trimOutputSnapshot: raw PTY output gets
 * trimmed to a byte-count budget with zero awareness of ANSI escape
 * sequences, so the cut can land mid-sequence and produce a dangling
 * fragment that a terminal renders as garbled literal text / a corrupted
 * cursor position.
 *
 * Root cause: in-app-planner.ts's ensurePlanningTerminalSummaryBridge splices
 * a plain-text status banner into the live output snapshot, then -- when the
 * combined length exceeds maxLength -- trims the *surrounding real PTY
 * output* with a blind `rest.slice(rest.length - keepableRestLength)`. That
 * surrounding output is a real shell session's raw bytes (prompt themes,
 * cursor positioning, etc.), so the same escape-sequence-safety gap that
 * trimOutputSnapshot had applies here too.
 */

import { describe, it, expect } from 'vitest';
import {
  ensurePlanningTerminalSummaryBridge,
  buildPlanningTerminalSummaryBridge,
  type InAppPlanningChatSession,
} from '../in-app-planner.js';
import { PlanConversation } from '@invoker/surfaces';

function makeSession(): InAppPlanningChatSession {
  return {
    id: 'planning-bridge-trim-repro',
    title: 'Untitled plan',
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [],
    conversation: new PlanConversation({}),
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    nextMessageId: 1,
  };
}

describe('ensurePlanningTerminalSummaryBridge truncated-escape garble repro', () => {
  it('does not cut a raw ANSI escape sequence in half when trimming surrounding output to fit maxLength', () => {
    const session = makeSession();
    const bridge = buildPlanningTerminalSummaryBridge(session);

    const ESC = '\x1b';
    const escSeq = `${ESC}[24;1H`; // 7 chars: ESC [ 2 4 ; 1 H (cursor-position sequence)
    const cutIndex = 2; // naive cut drops "ESC [", keeping only the dangling "24;1H"
    const escSeqPrefix = escSeq.slice(0, cutIndex);
    const escSeqSuffix = escSeq.slice(cutIndex);

    const maxLength = 400;
    const keepableRestLength = maxLength - bridge.length;
    const marker = 'CLEAN_TAIL_AFTER_ESCAPE';
    const restTail = escSeqSuffix + marker.padEnd(keepableRestLength - escSeqSuffix.length, 'z');
    // No existing bridge markers in this snapshot, so prefix='' and
    // suffix=snapshot -- `rest` inside the function is this whole string.
    const droppedPadding = 'a'.repeat(500) + escSeqPrefix;
    const fullSnapshot = droppedPadding + restTail;
    expect(fullSnapshot.length).toBeGreaterThan(maxLength);

    const result = ensurePlanningTerminalSummaryBridge(session, fullSnapshot, maxLength);
    expect(result.startsWith(bridge)).toBe(true);
    const trimmedRest = result.slice(bridge.length);

    // The full escape sequence must survive intact, not be sliced in half.
    expect(trimmedRest.startsWith(escSeq)).toBe(true);
    expect(trimmedRest.startsWith(escSeqSuffix) && !trimmedRest.startsWith(escSeq)).toBe(false);
  });
});
