import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeExecutionAgent,
  ensureClaudeWorkerConfigDir,
  mergeWaitNeedsWakeupSettings,
  resolveClaudeWorkerConfigDir,
} from '../agents/claude-execution-agent.js';

describe('ClaudeExecutionAgent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('buildCommand', () => {
    it('returns claude command with session ID and prompt', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildCommand('Fix the bug');

      expect(spec.cmd).toBe('claude');
      expect(spec.args).toContain('--session-id');
      expect(spec.args).toContain('--dangerously-skip-permissions');
      expect(spec.args).toContain('-p');
      expect(spec.args).toContain('Fix the bug');
      expect(spec.sessionId).toBeDefined();
      expect(spec.fullPrompt).toBe('Fix the bug');
    });

    it('generates unique session IDs per call', () => {
      const agent = new ClaudeExecutionAgent();
      const spec1 = agent.buildCommand('prompt 1');
      const spec2 = agent.buildCommand('prompt 2');

      expect(spec1.sessionId).not.toBe(spec2.sessionId);
    });

    it('uses custom command from config', () => {
      const agent = new ClaudeExecutionAgent({ command: '/usr/local/bin/claude' });
      const spec = agent.buildCommand('test');

      expect(spec.cmd).toBe('/usr/local/bin/claude');
    });

    it('places args in correct order: --session-id, id, --dangerously-skip-permissions, -p, prompt', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildCommand('my prompt');

      expect(spec.args[0]).toBe('--session-id');
      expect(spec.args[1]).toBe(spec.sessionId);
      expect(spec.args[2]).toBe('--dangerously-skip-permissions');
      expect(spec.args[3]).toBe('-p');
      expect(spec.args[4]).toBe('my prompt');
    });
    it('passes executionModel through as --model', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildCommand('my prompt', { executionModel: 'opus' });

      expect(spec.args).toEqual([
        '--session-id',
        spec.sessionId,
        '--dangerously-skip-permissions',
        '--model',
        'opus',
        '-p',
        'my prompt',
      ]);
    });

    it('passes maxTurns through as --max-turns', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildCommand('my prompt', { maxTurns: 30 });
      expect(spec.args).toContain('--max-turns');
      expect(spec.args).toContain('30');
    });

    it('omits --max-turns when maxTurns is unset', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildCommand('my prompt');
      expect(spec.args).not.toContain('--max-turns');
    });

  });

  describe('buildFixCommand', () => {
    it('returns claude command with session ID, prompt, and dangerously-skip-permissions', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildFixCommand('Fix the bug');

      expect(spec.cmd).toBe('claude');
      expect(spec.args).toContain('--session-id');
      expect(spec.args).toContain('-p');
      expect(spec.args).toContain('Fix the bug');
      expect(spec.args).toContain('--dangerously-skip-permissions');
      expect(spec.sessionId).toBeDefined();
    });

    it('generates unique session IDs per call', () => {
      const agent = new ClaudeExecutionAgent();
      const spec1 = agent.buildFixCommand('prompt 1');
      const spec2 = agent.buildFixCommand('prompt 2');

      expect(spec1.sessionId).not.toBe(spec2.sessionId);
    });

    it('uses custom command from config', () => {
      const agent = new ClaudeExecutionAgent({ command: '/usr/local/bin/claude' });
      const spec = agent.buildFixCommand('test');

      expect(spec.cmd).toBe('/usr/local/bin/claude');
    });

    it('prefers fixCommand for fix flows', () => {
      const agent = new ClaudeExecutionAgent({
        command: 'claude',
        fixCommand: '/tmp/claude-fix-stub',
      });
      const spec = agent.buildFixCommand('test');

      expect(spec.cmd).toBe('/tmp/claude-fix-stub');
    });

    it('falls back to INVOKER_CLAUDE_FIX_COMMAND for fix flows', () => {
      process.env.INVOKER_CLAUDE_FIX_COMMAND = '/tmp/env-claude-fix-stub';
      const agent = new ClaudeExecutionAgent({ command: 'claude' });
      const spec = agent.buildFixCommand('test');

      expect(spec.cmd).toBe('/tmp/env-claude-fix-stub');
    });

    it('places --session-id and its value at the start of args', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildFixCommand('my prompt');

      expect(spec.args[0]).toBe('--session-id');
      expect(spec.args[1]).toBe(spec.sessionId);
    });
    it('passes executionModel through for fix flows', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildFixCommand('my prompt', { executionModel: 'sonnet' });

      expect(spec.args).toEqual([
        '--session-id',
        spec.sessionId,
        '--model',
        'sonnet',
        '-p',
        'my prompt',
        '--dangerously-skip-permissions',
      ]);
    });


    it('stored sessionId matches the CLI --session-id value', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildFixCommand('my prompt');

      const idx = spec.args.indexOf('--session-id');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(spec.args[idx + 1]).toBe(spec.sessionId);
    });
  });

  describe('buildResumeArgs', () => {
    it('returns claude resume command with session ID', () => {
      const agent = new ClaudeExecutionAgent();
      const result = agent.buildResumeArgs('test-session-id');

      expect(result.cmd).toBe('claude');
      expect(result.args).toEqual(['--resume', 'test-session-id', '--dangerously-skip-permissions']);
    });

    it('uses custom command from config', () => {
      const agent = new ClaudeExecutionAgent({ command: 'claude-dev' });
      const result = agent.buildResumeArgs('sid');

      expect(result.cmd).toBe('claude-dev');
    });
  });

  describe('getContainerRequirements', () => {
    it('returns mounts for .claude config dir', () => {
      const agent = new ClaudeExecutionAgent({ configDir: '/test/.claude' });
      const reqs = agent.getContainerRequirements();

      expect(reqs.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ hostPath: '/test/.claude', containerPath: '/home/invoker/.claude' }),
        ]),
      );
    });

    it('returns ANTHROPIC_API_KEY in env', () => {
      const agent = new ClaudeExecutionAgent({ apiKey: 'sk-test-key' });
      const reqs = agent.getContainerRequirements();

      expect(reqs.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    });

    it('uses custom containerHomePath for mount targets', () => {
      const agent = new ClaudeExecutionAgent({ configDir: '/test/.claude', containerHomePath: '/root' });
      const reqs = agent.getContainerRequirements();

      expect(reqs.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ containerPath: '/root/.claude' }),
        ]),
      );
    });

    it('falls back to process.env.ANTHROPIC_API_KEY', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-from-env';
      const agent = new ClaudeExecutionAgent();
      const reqs = agent.getContainerRequirements();

      expect(reqs.env.ANTHROPIC_API_KEY).toBe('sk-from-env');
    });
  });

  describe('worker-scoped Claude config', () => {
    it('defaults CLAUDE_CONFIG_DIR to worker dir, not interactive home', () => {
      delete process.env.INVOKER_CLAUDE_CONFIG_DIR;
      const agent = new ClaudeExecutionAgent();
      const reqs = agent.getContainerRequirements();
      expect(reqs.env.CLAUDE_CONFIG_DIR).toBe(resolveClaudeWorkerConfigDir());
      expect(reqs.env.CLAUDE_CONFIG_DIR).toContain('.invoker');
    });

    it('honors INVOKER_CLAUDE_CONFIG_DIR', () => {
      const configDir = mkdtempSync(join(tmpdir(), 'claude-override-'));
      process.env.INVOKER_CLAUDE_CONFIG_DIR = configDir;
      try {
        const agent = new ClaudeExecutionAgent();
        expect(agent.getContainerRequirements().env.CLAUDE_CONFIG_DIR).toBe(configDir);
      } finally {
        delete process.env.INVOKER_CLAUDE_CONFIG_DIR;
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('includes CLAUDE_CONFIG_DIR when configDir is explicit', () => {
      const configDir = mkdtempSync(join(tmpdir(), 'claude-cfg-'));
      try {
        const agent = new ClaudeExecutionAgent({ apiKey: 'sk-test-key', configDir });
        const reqs = agent.getContainerRequirements();
        expect(reqs.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
        expect(reqs.env.CLAUDE_CONFIG_DIR).toBe(configDir);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('copies only wait-needs-wakeup hooks from interactive settings', () => {
      const interactive = {
        enabledPlugins: { noise: true },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'python3 $HOME/.claude/hooks/wait-needs-wakeup/claude_pretooluse.py' }],
            },
            {
              matcher: 'Agent',
              hooks: [{ type: 'command', command: 'python3 $HOME/.claude/hooks/cat-mode-default/claude_pretooluse_agent.py' }],
            },
          ],
          Stop: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'python3 $HOME/.claude/hooks/wait-needs-wakeup/claude_stop_check.py' }],
            },
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'python3 $HOME/.claude/hooks/diu-stop/claude_stop_check.py' }],
            },
          ],
        },
      };
      const worker = { enabledPlugins: {} };
      const merged = mergeWaitNeedsWakeupSettings(interactive, worker);
      expect(merged.enabledPlugins).toEqual({});
      expect(merged.hooks?.PreToolUse).toHaveLength(1);
      expect(merged.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash');
      expect(merged.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toContain('wait-needs-wakeup/');
      expect(merged.hooks?.Stop).toHaveLength(1);
      expect(merged.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain('wait-needs-wakeup/');
      expect(JSON.stringify(merged)).not.toContain('cat-mode-default');
      expect(JSON.stringify(merged)).not.toContain('diu-stop');
    });

    it('does not duplicate wait-needs-wakeup on a second merge', () => {
      const interactive = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'python3 wait-needs-wakeup/claude_pretooluse.py' }],
            },
          ],
        },
      };
      const once = mergeWaitNeedsWakeupSettings(interactive, { enabledPlugins: {} });
      const twice = mergeWaitNeedsWakeupSettings(interactive, once);
      expect(twice.hooks?.PreToolUse).toHaveLength(1);
    });

    it('leaves worker hooks unchanged when interactive settings are missing', () => {
      const root = mkdtempSync(join(tmpdir(), 'claude-worker-miss-'));
      const interactiveHome = join(root, 'home');
      const configDir = join(root, 'worker');
      mkdirSync(join(interactiveHome, '.claude'), { recursive: true });
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'settings.json'), `${JSON.stringify({
        enabledPlugins: {},
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'python3 already-there.py' }],
            },
          ],
        },
      }, null, 2)}\n`);
      try {
        ensureClaudeWorkerConfigDir(configDir, { interactiveHome });
        const worker = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
        expect(worker.hooks.PreToolUse).toHaveLength(1);
        expect(worker.hooks.PreToolUse[0].hooks[0].command).toBe('python3 already-there.py');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('does not rewrite interactive ~/.claude/settings.json bytes', () => {
      const root = mkdtempSync(join(tmpdir(), 'claude-worker-copy-'));
      const interactiveHome = join(root, 'home');
      const configDir = join(root, 'worker');
      const interactiveSettingsPath = join(interactiveHome, '.claude', 'settings.json');
      mkdirSync(join(interactiveHome, '.claude'), { recursive: true });
      const interactiveBytes = `${JSON.stringify({
        enabledPlugins: { keep: true },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'python3 $HOME/.claude/hooks/wait-needs-wakeup/claude_pretooluse.py' }],
            },
            {
              matcher: 'Agent',
              hooks: [{ type: 'command', command: 'python3 $HOME/.claude/hooks/other/hook.py' }],
            },
          ],
        },
      }, null, 2)}\n`;
      writeFileSync(interactiveSettingsPath, interactiveBytes);
      try {
        ensureClaudeWorkerConfigDir(configDir, { interactiveHome });
        expect(readFileSync(interactiveSettingsPath, 'utf8')).toBe(interactiveBytes);
        const worker = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
        expect(worker.enabledPlugins).toEqual({});
        expect(worker.hooks.PreToolUse).toHaveLength(1);
        expect(worker.hooks.PreToolUse[0].hooks[0].command).toContain('wait-needs-wakeup/');
        expect(JSON.stringify(worker)).not.toContain('other/hook');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });


  describe('properties', () => {
    it('has name = "claude"', () => {
      const agent = new ClaudeExecutionAgent();
      expect(agent.name).toBe('claude');
    });

    it('has stdinMode = "ignore"', () => {
      const agent = new ClaudeExecutionAgent();
      expect(agent.stdinMode).toBe('ignore');
    });
  });
});
