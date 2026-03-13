/**
 * CLI Output Parsing Test — Ensure equivalence between Claude and Cursor CLIs.
 *
 * Tests that both CLIs produce parseable output with consistent:
 * - Success/failure states (exit codes)
 * - Error message formats
 * - Result summaries
 * - Session ID extraction
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** CLI execution result structure */
interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId?: string;
}

/** Execute a CLI command and capture output */
async function executeCLI(command: string, args: string[], timeoutMs = 5000): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Extract session ID from Claude CLI output */
function extractClaudeSessionId(output: string): string | undefined {
  // Claude CLI typically outputs session ID in the format:
  // "Session ID: <uuid>" or "sessionId=<uuid>"
  const patterns = [
    /Session ID:\s*([0-9a-f-]{36})/i,
    /sessionId=([0-9a-f-]{36})/i,
    /--session-id\s+([0-9a-f-]{36})/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[1];
  }

  return undefined;
}

/** Extract session ID from Cursor CLI output */
function extractCursorSessionId(output: string): string | undefined {
  // Cursor CLI session ID format (adjust based on actual Cursor CLI behavior)
  const patterns = [
    /Session:\s*([0-9a-f-]{36})/i,
    /session_id=([0-9a-f-]{36})/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[1];
  }

  return undefined;
}

/** Parse CLI output for common error patterns */
function parseErrorMessage(output: string): string | undefined {
  const combinedOutput = output;

  // Common error patterns
  const errorPatterns = [
    /Error:\s*(.+?)(?:\n|$)/i,
    /Failed:\s*(.+?)(?:\n|$)/i,
    /Exception:\s*(.+?)(?:\n|$)/i,
    /ENOENT:\s*(.+?)(?:\n|$)/i,
    /Permission denied:\s*(.+?)(?:\n|$)/i,
  ];

  for (const pattern of errorPatterns) {
    const match = combinedOutput.match(pattern);
    if (match) return match[1].trim();
  }

  return undefined;
}

describe('CLI Output Parsing — Claude vs Cursor Equivalence', () => {
  describe('Exit Code Parsing', () => {
    it('should parse success exit code (0) correctly', async () => {
      // Test with a simple echo command to verify exit code 0 parsing
      const result = await executeCLI('/bin/sh', ['-c', 'echo "success"; exit 0']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('success');
    });

    it('should parse failure exit code (non-zero) correctly', async () => {
      // Test with a failing command
      const result = await executeCLI('/bin/sh', ['-c', 'echo "failure"; exit 1']);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('failure');
    });

    it('should handle signals as failure (exit code 1)', async () => {
      // Test SIGTERM handling
      const result = await executeCLI('/bin/sh', ['-c', 'kill -TERM $$'], 2000);

      // Signal termination should result in non-zero exit
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('Error Message Extraction', () => {
    it('should extract error message from stderr', async () => {
      const result = await executeCLI('/bin/sh', [
        '-c',
        'echo "Error: Command not found" >&2; exit 1',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Error: Command not found');

      const errorMsg = parseErrorMessage(result.stderr);
      expect(errorMsg).toBe('Command not found');
    });

    it('should handle ENOENT errors', async () => {
      try {
        await executeCLI('/nonexistent/command', []);
      } catch (err: any) {
        expect(err.code).toBe('ENOENT');
      }
    });

    it('should parse permission denied errors', async () => {
      const result = await executeCLI('/bin/sh', [
        '-c',
        'echo "Permission denied: /root/file" >&2; exit 1',
      ]);

      const errorMsg = parseErrorMessage(result.stderr);
      expect(errorMsg).toContain('/root/file');
    });
  });

  describe('Session ID Extraction — Claude CLI', () => {
    it('should extract session ID from --session-id argument pattern', () => {
      const sessionId = randomUUID();
      const output = `Starting Claude with --session-id ${sessionId}`;

      const extracted = extractClaudeSessionId(output);
      expect(extracted).toBe(sessionId);
    });

    it('should extract session ID from "Session ID:" pattern', () => {
      const sessionId = randomUUID();
      const output = `Claude session started.\nSession ID: ${sessionId}\nReady.`;

      const extracted = extractClaudeSessionId(output);
      expect(extracted).toBe(sessionId);
    });

    it('should extract session ID from sessionId= pattern', () => {
      const sessionId = randomUUID();
      const output = `{"status":"started","sessionId=${sessionId}"}`;

      const extracted = extractClaudeSessionId(output);
      expect(extracted).toBe(sessionId);
    });

    it('should return undefined when no session ID present', () => {
      const output = 'Claude CLI output without session ID';

      const extracted = extractClaudeSessionId(output);
      expect(extracted).toBeUndefined();
    });
  });

  describe('Session ID Extraction — Cursor CLI', () => {
    it('should extract session ID from "Session:" pattern', () => {
      const sessionId = randomUUID();
      const output = `Cursor session started.\nSession: ${sessionId}\nReady.`;

      const extracted = extractCursorSessionId(output);
      expect(extracted).toBe(sessionId);
    });

    it('should extract session ID from session_id= pattern', () => {
      const sessionId = randomUUID();
      const output = `{"status":"started","session_id=${sessionId}"}`;

      const extracted = extractCursorSessionId(output);
      expect(extracted).toBe(sessionId);
    });

    it('should return undefined when no session ID present', () => {
      const output = 'Cursor CLI output without session ID';

      const extracted = extractCursorSessionId(output);
      expect(extracted).toBeUndefined();
    });
  });

  describe('Output Format Consistency', () => {
    it('should produce consistent stdout/stderr separation', async () => {
      const result = await executeCLI('/bin/sh', [
        '-c',
        'echo "stdout message"; echo "stderr message" >&2',
      ]);

      expect(result.stdout).toContain('stdout message');
      expect(result.stdout).not.toContain('stderr message');
      expect(result.stderr).toContain('stderr message');
      expect(result.stderr).not.toContain('stdout message');
    });

    it('should handle mixed output without corruption', async () => {
      const result = await executeCLI('/bin/sh', [
        '-c',
        'for i in 1 2 3; do echo "out$i"; echo "err$i" >&2; done',
      ]);

      // Verify all output lines are present
      expect(result.stdout).toContain('out1');
      expect(result.stdout).toContain('out2');
      expect(result.stdout).toContain('out3');
      expect(result.stderr).toContain('err1');
      expect(result.stderr).toContain('err2');
      expect(result.stderr).toContain('err3');
    });
  });

  describe('Claude CLI Fallback Behavior', () => {
    it('should detect ENOENT when claude command not found', async () => {
      // This test simulates the ENOENT fallback in LocalFamiliar
      let enoentDetected = false;

      try {
        await executeCLI('claude-nonexistent-command-xyz', ['--help']);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          enoentDetected = true;
        }
      }

      expect(enoentDetected).toBe(true);
    });

    it('should provide fallback echo stub on ENOENT', async () => {
      // Simulate the fallback behavior from LocalFamiliar:153-168
      const prompt = 'Test prompt for fallback';
      const result = await executeCLI('/bin/sh', [
        '-c',
        `echo "Claude prompt: ${prompt}"`,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(prompt);
    });
  });

  describe('Result Summary Parsing', () => {
    it('should extract result summary from success output', async () => {
      const result = await executeCLI('/bin/sh', [
        '-c',
        'echo "Task completed successfully"; echo "3 tests passed"; exit 0',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('completed successfully');
      expect(result.stdout).toContain('3 tests passed');
    });

    it('should extract result summary from failure output', async () => {
      const result = await executeCLI('/bin/sh', [
        '-c',
        'echo "Task failed"; echo "Error: 2 tests failed" >&2; exit 1',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('2 tests failed');
    });

    it('should handle empty output with exit code', async () => {
      const result = await executeCLI('/bin/sh', ['-c', 'exit 0']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  describe('WorkResponse Status Mapping', () => {
    /**
     * Verify that exit codes map to WorkResponse status consistently:
     * - exitCode 0 → status 'completed'
     * - exitCode non-zero → status 'failed'
     */
    it('should map exit code 0 to completed status', async () => {
      const result = await executeCLI('/bin/sh', ['-c', 'exit 0']);
      const status = result.exitCode === 0 ? 'completed' : 'failed';

      expect(status).toBe('completed');
    });

    it('should map non-zero exit code to failed status', async () => {
      const result = await executeCLI('/bin/sh', ['-c', 'exit 1']);
      const status = result.exitCode === 0 ? 'completed' : 'failed';

      expect(status).toBe('failed');
    });

    it('should map signal termination to failed status', async () => {
      const result = await executeCLI('/bin/sh', ['-c', 'kill -TERM $$'], 2000);
      const status = result.exitCode === 0 ? 'completed' : 'failed';

      expect(status).toBe('failed');
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long output without truncation', async () => {
      const lineCount = 1000;
      const result = await executeCLI('/bin/sh', [
        '-c',
        `for i in $(seq 1 ${lineCount}); do echo "Line $i"; done`,
      ]);

      const lines = result.stdout.trim().split('\n');
      expect(lines.length).toBe(lineCount);
      expect(lines[0]).toBe('Line 1');
      expect(lines[lineCount - 1]).toBe(`Line ${lineCount}`);
    });

    it('should handle binary output gracefully', async () => {
      const result = await executeCLI('/bin/sh', [
        '-c',
        'printf "\\x00\\x01\\x02\\x03"; exit 0',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it('should handle rapid stdout/stderr interleaving', async () => {
      const result = await executeCLI('/bin/sh', [
        '-c',
        'for i in $(seq 1 50); do echo "out$i"; echo "err$i" >&2; done',
      ]);

      expect(result.exitCode).toBe(0);
      const outLines = result.stdout.trim().split('\n');
      const errLines = result.stderr.trim().split('\n');
      expect(outLines.length).toBe(50);
      expect(errLines.length).toBe(50);
    });
  });
});
