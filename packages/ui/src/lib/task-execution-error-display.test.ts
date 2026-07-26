import { describe, expect, it } from 'vitest';
import { formatTaskExecutionErrorForDisplay } from './task-execution-error-display.js';

describe('formatTaskExecutionErrorForDisplay', () => {
  it('normalizes legacy ssh cleanup-tail blobs after a completed agent turn', () => {
    const raw = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1}}',
      'main: line 1: pop_var_context: head of shell_variables not a function context [SshExecutor] Recording task result and pushing branch on remote...',
    ].join('\n');

    expect(formatTaskExecutionErrorForDisplay(raw)).toBe(
      'Executor cleanup failed (ssh remote finalize): bash pop_var_context after remote run completed.',
    );
  });

  it('leaves unrelated errors unchanged', () => {
    expect(formatTaskExecutionErrorForDisplay('Unit tests failed')).toBe('Unit tests failed');
  });

  it('preserves already-normalized cleanup-tail errors', () => {
    const normalized = 'Executor cleanup failed (ssh remote finalize): bash pop_var_context after remote run completed.';
    expect(formatTaskExecutionErrorForDisplay(normalized)).toBe(normalized);
  });
});
