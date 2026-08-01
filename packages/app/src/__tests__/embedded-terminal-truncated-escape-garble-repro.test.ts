// @vitest-environment jsdom
/**
 * Reproduces the tmux/planning-terminal remount garble bug.
 *
 * Root cause chain (confirmed by prior investigation):
 *   - packages/ui/src/components/InvokerTerminal.tsx:692-700 unmounts/remounts
 *     PlanningTmuxPane's xterm.js Terminal when the UI toggles chat<->tmux mode.
 *   - packages/app/src/embedded-terminal-manager.ts:656-659 `trimOutputSnapshot`
 *     is a byte-count `slice()` with zero ANSI/VT escape-sequence awareness.
 *   - packages/ui/src/components/InvokerTerminal.tsx:147-182
 *     `seedTerminalOutputSnapshot` replays that raw (possibly mid-escape-sequence)
 *     buffer straight into the freshly created Terminal via `term.write(...)`.
 *
 * This test drives the REAL, unexported `trimOutputSnapshot` through
 * EmbeddedTerminalManager's public `emitOutput` code path (a fake backend
 * captures the `emitOutput` callback the same way the real pty/bash backends
 * do), then feeds the real trimmed snapshot into a real `xterm` `Terminal`
 * instance (loaded from packages/ui's node_modules, since @invoker/app does
 * not depend on xterm) the same way `seedTerminalOutputSnapshot` does on
 * remount. `trimOutputSnapshot` is a pure "keep last N chars of the stream"
 * operation, so simulating the whole history as a single oversized chunk is
 * equivalent to many incremental writes accumulating to the same length.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TerminalSpec } from '@invoker/execution-engine';
import {
  EmbeddedTerminalManager,
  MAX_OUTPUT_SNAPSHOT_CHARS,
  type EmbeddedTerminalBackend,
} from '../embedded-terminal-manager.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

function loadRealXtermTerminal() {
  const requireFromUi = createRequire(path.join(rootDir, '../../../ui/package.json'));
  const { Terminal } = requireFromUi('xterm') as {
    Terminal: new (options?: Record<string, unknown>) => {
      write(data: string, callback?: () => void): void;
      buffer: { active: { getLine(n: number): { translateToString(trimRight?: boolean): string } | undefined } };
    };
  };
  return Terminal;
}

function writeAndWait(term: { write(data: string, callback?: () => void): void }, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe('embedded terminal truncated-escape garble repro', () => {
  it('replays a clean cursor-move escape sequence without printing literal escape text', async () => {
    const ESC = '\x1b';
    const escSeq = `${ESC}[24;1H`; // cursor-position sequence, matches the hypothesized garble trigger
    const cleanPayload = `before${escSeq}AFTER_CURSOR_MOVE`;

    const Terminal = loadRealXtermTerminal();
    const term = new Terminal({ cols: 40, rows: 5, scrollback: 5000 });
    await writeAndWait(term, cleanPayload);

    const line0 = term.buffer.active.getLine(0)?.translateToString(true) ?? '';
    expect(line0).not.toContain('24;1H');
  });

  it('garbles a fresh xterm.js terminal when the real trimOutputSnapshot cuts an escape sequence mid-way', async () => {
    const ESC = '\x1b';
    const escSeq = `${ESC}[24;1H`; // 7 chars: ESC [ 2 4 ; 1 H
    const cutIndex = 2; // drop "ESC [", keep the trailing "24;1H" fragment
    const escSeqPrefix = escSeq.slice(0, cutIndex);
    const escSeqSuffix = escSeq.slice(cutIndex);

    const marker = 'CLEAN_TAIL_AFTER_ESCAPE';
    const restText = marker.padEnd(MAX_OUTPUT_SNAPSHOT_CHARS - escSeqSuffix.length, 'z');
    const expectedTrimmedTail = escSeqSuffix + restText;
    expect(expectedTrimmedTail.length).toBe(MAX_OUTPUT_SNAPSHOT_CHARS);

    const droppedPadding = 'a'.repeat(1000) + escSeqPrefix;
    const fullPtyOutput = droppedPadding + expectedTrimmedTail;
    expect(fullPtyOutput.length).toBeGreaterThan(MAX_OUTPUT_SNAPSHOT_CHARS);

    let emitOutput: ((data: string) => void) | undefined;
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn(opts) {
        emitOutput = opts.emitOutput;
        return { write() {}, resize() {}, close() {} };
      },
    };
    const manager = new EmbeddedTerminalManager({ backend });
    const spec: TerminalSpec = { cwd: '/tmp/garble-repro' };
    const session = manager.openOrReuse({ taskId: 'task-garble-repro', spec, cwd: '/tmp/garble-repro' });
    expect(emitOutput).toBeDefined();

    // Single oversized chunk stands in for many incremental PTY writes that
    // accumulate to the same total length; trimOutputSnapshot's "keep last N
    // chars of the stream" behavior is identical either way.
    emitOutput!(fullPtyOutput);

    const trimmedSnapshot = manager.get(session.sessionId)?.outputSnapshot ?? '';
    // trimOutputSnapshot is now escape-sequence-aware: it may keep a small
    // bounded amount more than MAX_OUTPUT_SNAPSHOT_CHARS rather than slice
    // through the middle of an escape sequence.
    expect(trimmedSnapshot.length).toBeGreaterThanOrEqual(MAX_OUTPUT_SNAPSHOT_CHARS);
    expect(trimmedSnapshot.length).toBeLessThan(MAX_OUTPUT_SNAPSHOT_CHARS + 512);
    expect(trimmedSnapshot.endsWith(restText)).toBe(true);
    // The full escape sequence is preserved intact, not cut mid-way.
    expect(trimmedSnapshot.startsWith(escSeq)).toBe(true);

    // seedTerminalOutputSnapshot (InvokerTerminal.tsx:171) does exactly this:
    // term.write(outputSnapshot) into a brand-new Terminal created on remount.
    const Terminal = loadRealXtermTerminal();
    const remountedTerm = new Terminal({ cols: 40, rows: 5, scrollback: 5000 });
    await writeAndWait(remountedTerm, trimmedSnapshot);

    const line0 = remountedTerm.buffer.active.getLine(0)?.translateToString(true) ?? '';
    // A correctly replayed cursor-position escape sequence prints nothing
    // visible. A dangling "24;1H" fragment with no leading ESC byte is
    // instead printed as literal garbage text at the top of the fresh
    // terminal — this assertion is what should hold and currently fails.
    expect(line0).not.toContain('24;1H');
  });
});
