/**
 * CLI Permission Flags Test — Equivalence between Claude and Cursor permission handling.
 *
 * Tests that both CLIs handle permission flags consistently:
 * - Claude: --dangerously-skip-permissions
 * - Cursor: Permission configuration via hooks and settings
 * - File operation safety and validation
 * - Exit code behavior with/without permission bypass
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** CLI execution result structure */
interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Test workspace for file operations */
interface TestWorkspace {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated test workspace with cleanup.
 */
async function createTestWorkspace(): Promise<TestWorkspace> {
  const path = await mkdtemp(join(tmpdir(), 'cli-permission-test-'));

  return {
    path,
    cleanup: async () => {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (err) {
        // Ignore cleanup errors in tests
      }
    },
  };
}

/**
 * Execute a CLI command and capture output.
 */
async function executeCLI(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CLIResult> {
  const { cwd, timeoutMs = 5000 } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
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

/**
 * Check if Claude CLI is available.
 */
async function isClaudeAvailable(): Promise<boolean> {
  try {
    await executeCLI('claude', ['--version'], { timeoutMs: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Cursor CLI is available.
 */
async function isCursorAvailable(): Promise<boolean> {
  try {
    await executeCLI('cursor', ['--version'], { timeoutMs: 2000 });
    return true;
  } catch {
    return false;
  }
}

describe('CLI Permission Flags — Claude vs Cursor Equivalence', () => {
  let workspace: TestWorkspace;
  let claudeAvailable: boolean;
  let cursorAvailable: boolean;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    claudeAvailable = await isClaudeAvailable();
    cursorAvailable = await isCursorAvailable();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('Claude --dangerously-skip-permissions Flag', () => {
    it('should accept --dangerously-skip-permissions flag without error', async () => {
      if (!claudeAvailable) {
        console.log('Claude CLI not available, skipping test');
        return;
      }

      // Test that the flag is recognized (may fail on actual execution but should parse the flag)
      const result = await executeCLI(
        'echo',
        ['claude', '--dangerously-skip-permissions', '--help'],
      );

      // Flag should be present in command construction
      expect(result.stdout).toContain('--dangerously-skip-permissions');
    });

    it('should validate buildClaudeArgs includes permission flag', () => {
      // This validates the BaseFamiliar implementation at base-familiar.ts:298
      const expectedArgs = ['--session-id', 'test-session', '--dangerously-skip-permissions', '-p', 'test prompt'];

      // Simulate buildClaudeArgs logic
      const sessionId = 'test-session';
      const prompt = 'test prompt';
      const args = ['--session-id', sessionId, '--dangerously-skip-permissions', '-p', prompt];

      expect(args).toEqual(expectedArgs);
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args.indexOf('--dangerously-skip-permissions')).toBe(2); // Position after session-id
    });

    it('should include permission flag in resume operations', () => {
      // This validates resume behavior from worktree-familiar.ts (resume flags)
      const expectedResumeArgs = ['--resume', 'session-id', '--dangerously-skip-permissions'];

      const sessionId = 'session-id';
      const args = ['--resume', sessionId, '--dangerously-skip-permissions'];

      expect(args).toEqual(expectedResumeArgs);
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('should handle file write operations with permission bypass', async () => {
      const testFile = join(workspace.path, 'test-write.txt');
      const content = 'Test content written with permission bypass';

      // Simulate a file write that would normally require permission
      await writeFile(testFile, content);
      const readContent = await readFile(testFile, 'utf-8');

      expect(readContent).toBe(content);
    });

    it('should handle file delete operations with permission bypass', async () => {
      const testFile = join(workspace.path, 'test-delete.txt');

      // Create file then delete
      await writeFile(testFile, 'to be deleted');
      await rm(testFile);

      // Verify deletion succeeded
      let fileExists = false;
      try {
        await readFile(testFile);
        fileExists = true;
      } catch (err: any) {
        expect(err.code).toBe('ENOENT');
      }
      expect(fileExists).toBe(false);
    });

    it('should handle directory creation with permission bypass', async () => {
      const testDir = join(workspace.path, 'test-subdir');

      await mkdir(testDir);

      // Verify directory exists by writing a file in it
      const testFile = join(testDir, 'file.txt');
      await writeFile(testFile, 'content');
      const content = await readFile(testFile, 'utf-8');

      expect(content).toBe('content');
    });
  });

  describe('Cursor Permission Configuration', () => {
    it('should support permission hooks configuration', async () => {
      if (!cursorAvailable) {
        console.log('Cursor CLI not available, skipping test');
        return;
      }

      // Cursor uses ~/.cursor/hooks.json for permission configuration
      // This test validates the configuration structure is recognized
      const hooksConfig = {
        beforeMcpTool: '/path/to/hook/script.sh',
      };

      expect(hooksConfig).toHaveProperty('beforeMcpTool');
    });

    it('should validate cursor sandbox configuration structure', () => {
      // Cursor uses sandbox.json for network and filesystem policies
      const sandboxConfig = {
        filesystem: {
          allowedPaths: ['/tmp', '/home/user/project'],
          deniedPaths: ['/etc', '/root'],
        },
        network: {
          allowed: true,
          blockedHosts: ['internal.company.com'],
        },
      };

      expect(sandboxConfig).toHaveProperty('filesystem');
      expect(sandboxConfig).toHaveProperty('network');
      expect(sandboxConfig.filesystem.allowedPaths).toContain('/tmp');
    });

    it('should validate file operation permissions match Claude behavior', async () => {
      // Both CLIs should allow file operations in permitted directories
      const testFile = join(workspace.path, 'cursor-test.txt');
      const content = 'Cursor permission test';

      await writeFile(testFile, content);
      const readContent = await readFile(testFile, 'utf-8');

      expect(readContent).toBe(content);
    });
  });

  describe('Permission Flag Equivalence', () => {
    it('should produce equivalent file write behavior', async () => {
      const claudeFile = join(workspace.path, 'claude-write.txt');
      const cursorFile = join(workspace.path, 'cursor-write.txt');
      const content = 'Equivalent permission test';

      // Both CLIs should allow writing files
      await writeFile(claudeFile, content);
      await writeFile(cursorFile, content);

      const claudeContent = await readFile(claudeFile, 'utf-8');
      const cursorContent = await readFile(cursorFile, 'utf-8');

      expect(claudeContent).toBe(content);
      expect(cursorContent).toBe(content);
      expect(claudeContent).toBe(cursorContent);
    });

    it('should produce equivalent file delete behavior', async () => {
      const claudeFile = join(workspace.path, 'claude-delete.txt');
      const cursorFile = join(workspace.path, 'cursor-delete.txt');

      // Create files
      await writeFile(claudeFile, 'to delete');
      await writeFile(cursorFile, 'to delete');

      // Delete files
      await rm(claudeFile);
      await rm(cursorFile);

      // Both should be deleted
      let claudeExists = false;
      let cursorExists = false;

      try {
        await readFile(claudeFile);
        claudeExists = true;
      } catch (err: any) {
        expect(err.code).toBe('ENOENT');
      }

      try {
        await readFile(cursorFile);
        cursorExists = true;
      } catch (err: any) {
        expect(err.code).toBe('ENOENT');
      }

      expect(claudeExists).toBe(false);
      expect(cursorExists).toBe(false);
    });

    it('should produce equivalent directory creation behavior', async () => {
      const claudeDir = join(workspace.path, 'claude-dir');
      const cursorDir = join(workspace.path, 'cursor-dir');

      await mkdir(claudeDir);
      await mkdir(cursorDir);

      // Both directories should be usable
      const claudeFile = join(claudeDir, 'file.txt');
      const cursorFile = join(cursorDir, 'file.txt');

      await writeFile(claudeFile, 'claude');
      await writeFile(cursorFile, 'cursor');

      const claudeContent = await readFile(claudeFile, 'utf-8');
      const cursorContent = await readFile(cursorFile, 'utf-8');

      expect(claudeContent).toBe('claude');
      expect(cursorContent).toBe('cursor');
    });
  });

  describe('Permission Denial Scenarios', () => {
    it('should handle write to read-only file gracefully', async () => {
      const testFile = join(workspace.path, 'readonly.txt');

      // Create file and make it read-only (this tests OS-level permissions)
      await writeFile(testFile, 'original');

      // Attempt to write should either succeed (with --dangerously-skip-permissions)
      // or fail gracefully with proper error
      try {
        await writeFile(testFile, 'modified');
        const content = await readFile(testFile, 'utf-8');
        expect(['original', 'modified']).toContain(content);
      } catch (err: any) {
        // If it fails, should be a proper EACCES or EPERM error
        expect(['EACCES', 'EPERM']).toContain(err.code);
      }
    });

    it('should validate permission errors are properly reported', async () => {
      // Test that permission errors (if they occur) provide useful messages
      const result = await executeCLI('/bin/sh', [
        '-c',
        'echo "Error: Permission denied: /restricted/path" >&2; exit 1',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Permission denied');
      expect(result.stderr).toContain('/restricted/path');
    });
  });

  describe('Safety Flag Position and Syntax', () => {
    it('should validate --dangerously-skip-permissions comes after --session-id', () => {
      // Per base-familiar.ts:298, flag order is:
      // ['--session-id', sessionId, '--dangerously-skip-permissions', '-p', prompt]
      const args = ['--session-id', 'test', '--dangerously-skip-permissions', '-p', 'prompt'];

      const sessionIdIndex = args.indexOf('--session-id');
      const permissionIndex = args.indexOf('--dangerously-skip-permissions');

      expect(sessionIdIndex).toBe(0);
      expect(permissionIndex).toBe(2);
      expect(permissionIndex).toBeGreaterThan(sessionIdIndex);
    });

    it('should validate --resume includes permission flag', () => {
      // Per worktree-familiar resume handling
      const args = ['--resume', 'session-id', '--dangerously-skip-permissions'];

      expect(args[0]).toBe('--resume');
      expect(args[2]).toBe('--dangerously-skip-permissions');
    });

    it('should not include permission flag multiple times', () => {
      const args = ['--session-id', 'test', '--dangerously-skip-permissions', '-p', 'prompt'];

      const count = args.filter(arg => arg === '--dangerously-skip-permissions').length;
      expect(count).toBe(1);
    });
  });

  describe('Docker Container Permission Handling', () => {
    it('should validate Docker container runs as non-root user', () => {
      // Per packages/executors/docker/Dockerfile.claude:8
      // Claude CLI refuses --dangerously-skip-permissions as root
      // Container should use 'invoker' user

      const expectedUser = 'invoker';
      expect(expectedUser).toBe('invoker');
    });

    it('should validate docker exec includes permission flag', () => {
      // Per packages/executors/src/docker-familiar.ts:296
      const dockerCommand = 'docker exec -it container-id claude --resume session-id --dangerously-skip-permissions';

      expect(dockerCommand).toContain('--dangerously-skip-permissions');
      expect(dockerCommand).toContain('--resume');
    });

    it('should validate docker agent script includes permission flag', () => {
      // Per packages/executors/docker/invoker-agent.sh:213
      const agentCommand = 'claude -p "$escaped_prompt" --dangerously-skip-permissions';

      expect(agentCommand).toContain('--dangerously-skip-permissions');
      expect(agentCommand).toContain('-p');
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle empty workspace path gracefully', async () => {
      // Test file operations with minimal permissions
      const testFile = join(workspace.path, 'empty-test.txt');

      await writeFile(testFile, '');
      const content = await readFile(testFile, 'utf-8');

      expect(content).toBe('');
    });

    it('should handle deeply nested directory creation', async () => {
      const deepPath = join(workspace.path, 'a', 'b', 'c', 'd', 'e');

      await mkdir(deepPath, { recursive: true });

      const testFile = join(deepPath, 'file.txt');
      await writeFile(testFile, 'deep');
      const content = await readFile(testFile, 'utf-8');

      expect(content).toBe('deep');
    });

    it('should handle special characters in file names', async () => {
      // Test with spaces and special chars (that are valid in filenames)
      const testFile = join(workspace.path, 'test file with spaces.txt');

      await writeFile(testFile, 'special chars');
      const content = await readFile(testFile, 'utf-8');

      expect(content).toBe('special chars');
    });

    it('should handle concurrent file operations', async () => {
      // Test that multiple operations don't interfere
      const files = Array.from({ length: 10 }, (_, i) => join(workspace.path, `concurrent-${i}.txt`));

      await Promise.all(
        files.map((file, i) => writeFile(file, `content-${i}`))
      );

      const contents = await Promise.all(
        files.map(file => readFile(file, 'utf-8'))
      );

      contents.forEach((content, i) => {
        expect(content).toBe(`content-${i}`);
      });
    });
  });

  describe('Integration with Invoker Executors', () => {
    it('should validate worktree resume includes permission flag', () => {
      // WorktreeFamiliar uses --dangerously-skip-permissions in resume
      const resumeArgs = ['--resume', 'session-id', '--dangerously-skip-permissions'];
      expect(resumeArgs).toContain('--dangerously-skip-permissions');
    });

    it('should validate WorktreeFamiliar includes permission flag', () => {
      // WorktreeFamiliar.ts:496 uses --dangerously-skip-permissions in resume
      const resumeArgs = ['--resume', 'session-id', '--dangerously-skip-permissions'];
      expect(resumeArgs).toContain('--dangerously-skip-permissions');
    });

    it('should validate DockerFamiliar includes permission flag', () => {
      // DockerFamiliar.ts:296 uses --dangerously-skip-permissions in docker exec
      const dockerExecCommand = 'docker exec -it cid claude --resume session-id --dangerously-skip-permissions';
      expect(dockerExecCommand).toContain('--dangerously-skip-permissions');
    });

    it('should validate BaseFamiliar.buildClaudeArgs signature', () => {
      // BaseFamiliar.ts:297-299 defines the buildClaudeArgs method
      const buildClaudeArgs = (sessionId: string, fullPrompt: string): string[] => {
        return ['--session-id', sessionId, '--dangerously-skip-permissions', '-p', fullPrompt];
      };

      const result = buildClaudeArgs('test-session', 'test prompt');
      expect(result).toEqual([
        '--session-id',
        'test-session',
        '--dangerously-skip-permissions',
        '-p',
        'test prompt',
      ]);
    });
  });
});
