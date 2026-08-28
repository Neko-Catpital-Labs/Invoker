import { describe, expect, it } from 'vitest';
import {
  assertNoConfigWriteOnAllDeclined,
  assertNoSecretPrinted,
  assertOptionalToolPromptedBeforeInstall,
  assertRemoteTargetOnlyPersistedAfterAllChecksPass,
  assertWorkerToggleHasSingleSource,
} from '../onboarding-invariants.js';

describe('assertOptionalToolPromptedBeforeInstall', () => {
  it('passes when nothing was installed for the tool', () => {
    expect(() => assertOptionalToolPromptedBeforeInstall(['Invoker setup', "You're ready."], 'Drafter')).not.toThrow();
  });

  it('passes when an optional prompt naming the tool precedes the install', () => {
    const lines = [
      'Drafter is an optional tool that suggests task ordering for plans.',
      'Enable Drafter now? [y/N] y',
      'Installed Drafter into ~/.invoker/mcp.json.',
    ];
    expect(() => assertOptionalToolPromptedBeforeInstall(lines, 'Drafter')).not.toThrow();
  });

  it('rejects an install with no prior optional-naming prompt — the exact Drafter-MCP regression', () => {
    const lines = [
      'Invoker setup',
      'Experimental planner MCP installed into ~/.invoker/mcp.json.',
    ];
    expect(() => assertOptionalToolPromptedBeforeInstall(lines, 'Experimental planner MCP')).toThrow(/without an earlier prompt/);
  });

  it('rejects when the prompt exists but never uses the word "optional"', () => {
    const lines = [
      'Enable Drafter now? [y/N] y',
      'Installed Drafter into ~/.invoker/mcp.json.',
    ];
    expect(() => assertOptionalToolPromptedBeforeInstall(lines, 'Drafter')).toThrow(/without an earlier prompt/);
  });
});

describe('assertNoConfigWriteOnAllDeclined', () => {
  it('passes when nothing was written', () => {
    expect(() => assertNoConfigWriteOnAllDeclined([], true)).not.toThrow();
  });

  it('is a no-op when the user did not decline everything', () => {
    expect(() => assertNoConfigWriteOnAllDeclined(['/tmp/x/.invoker/config.json'], false)).not.toThrow();
  });

  it('rejects a config.json write on an all-declined run', () => {
    expect(() => assertNoConfigWriteOnAllDeclined(['/tmp/x/.invoker/config.json'], true)).toThrow(/must not write any file/);
  });

  it('rejects an mcp.json or .env write on an all-declined run', () => {
    expect(() => assertNoConfigWriteOnAllDeclined(['/tmp/x/.invoker/mcp.json'], true)).toThrow(/must not write any file/);
    expect(() => assertNoConfigWriteOnAllDeclined(['/tmp/x/.invoker/.env'], true)).toThrow(/must not write any file/);
  });
});

describe('assertRemoteTargetOnlyPersistedAfterAllChecksPass', () => {
  it('passes when all checks are ok and the target was written', () => {
    expect(() => assertRemoteTargetOnlyPersistedAfterAllChecksPass(
      [{ id: 'git', status: 'ok' }, { id: 'push-auth', status: 'ok' }],
      true,
    )).not.toThrow();
  });

  it('passes when a check failed but the target was correctly not written', () => {
    expect(() => assertRemoteTargetOnlyPersistedAfterAllChecksPass(
      [{ id: 'push-auth', status: 'error' }],
      false,
    )).not.toThrow();
  });

  it('rejects a written target with a failing required check', () => {
    expect(() => assertRemoteTargetOnlyPersistedAfterAllChecksPass(
      [{ id: 'push-auth', status: 'error' }],
      true,
    )).toThrow(/persisted to config despite failing checks/);
  });

  it('treats warn-status checks as non-blocking', () => {
    expect(() => assertRemoteTargetOnlyPersistedAfterAllChecksPass(
      [{ id: 'disk-space', status: 'warn' }],
      true,
    )).not.toThrow();
  });
});

describe('assertNoSecretPrinted', () => {
  it('passes when no secret appears in the output', () => {
    expect(() => assertNoSecretPrinted(['Machine name: build-a'], ['sk-live-abcdef123456'])).not.toThrow();
  });

  it('ignores trivially short values to avoid false positives on empty fields', () => {
    expect(() => assertNoSecretPrinted(['SSH port: 22'], ['22'])).not.toThrow();
  });

  it('rejects a line that echoes a real secret value', () => {
    const secret = 'xoxb-1234567890-abcdefg';
    expect(() => assertNoSecretPrinted([`Bot token: ${secret}`], [secret])).toThrow(/secret value was printed/);
  });
});

describe('assertWorkerToggleHasSingleSource', () => {
  it('passes for a desired-state start preset', () => {
    expect(() => assertWorkerToggleHasSingleSource({
      id: 'pr-maintenance',
      workerKinds: ['pr-admin-bypass-land', 'pr-orphan-repair'],
    })).not.toThrow();
  });

  it('passes for a policy config path', () => {
    expect(() => assertWorkerToggleHasSingleSource({
      id: 'auto-approve',
      configPath: 'autoApproveAIFixes',
    })).not.toThrow();
  });

  it('rejects a bare env var name — the exact disk-headroom-cleanup regression', () => {
    expect(() => assertWorkerToggleHasSingleSource({
      id: 'disk-headroom-cleanup',
      configPath: 'INVOKER_DISK_CLEANUP_ENABLED',
    })).toThrow(/bare env var name/);
  });

  it('rejects a config start flag path', () => {
    expect(() => assertWorkerToggleHasSingleSource({
      id: 'pr-maintenance',
      configPath: 'prMaintenance.enabled',
    })).toThrow(/worker start flag/);
  });

  it('rejects declaring both or neither source', () => {
    expect(() => assertWorkerToggleHasSingleSource({ id: 'bad' })).toThrow(/exactly one/);
    expect(() => assertWorkerToggleHasSingleSource({
      id: 'bad',
      workerKinds: ['x'],
      configPath: 'autoApproveAIFixes',
    })).toThrow(/exactly one/);
  });
});
