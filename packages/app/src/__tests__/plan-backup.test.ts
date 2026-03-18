import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { backupPlan } from '../plan-backup.js';
import type { PlanDefinition } from '@invoker/core';

const backupDir = join(homedir(), '.invoker', 'plans');

function cleanupBackups(): void {
  if (existsSync(backupDir)) {
    for (const f of readdirSync(backupDir)) {
      if (f.includes('test-plan') || f.includes('unnamed')) {
        rmSync(join(backupDir, f), { force: true });
      }
    }
  }
}

describe('backupPlan', () => {
  beforeEach(cleanupBackups);
  afterEach(cleanupBackups);

  const plan: PlanDefinition = {
    name: 'Test Plan',
    tasks: [
      { id: 't1', description: 'First task' },
      { id: 't2', description: 'Second task', dependencies: ['t1'] },
    ],
  };

  it('creates a YAML file in ~/.invoker/plans/', () => {
    const filepath = backupPlan(plan);
    expect(existsSync(filepath)).toBe(true);
    expect(filepath).toContain(backupDir);
    expect(filepath).toMatch(/\.yaml$/);
    expect(filepath).toContain('test-plan');
  });

  it('backup file contains valid YAML with the plan name', () => {
    const filepath = backupPlan(plan);
    const content = readFileSync(filepath, 'utf-8');
    expect(content).toContain('Test Plan');
    expect(content).toContain('t1');
    expect(content).toContain('t2');
  });

  it('preserves original YAML source when provided', () => {
    const original = '# My hand-crafted plan\\nname: Test Plan\\ntasks:\\n  - id: t1\\n    description: First task\\n';
    const filepath = backupPlan(plan, original);
    const content = readFileSync(filepath, 'utf-8');
    expect(content).toBe(original);
  });

  it('serializes plan to YAML when no source is provided', () => {
    const filepath = backupPlan(plan);
    const content = readFileSync(filepath, 'utf-8');
    expect(content).toContain('name:');
    expect(content).toContain('tasks:');
  });

  it('generates unique filenames for each backup', () => {
    const path1 = backupPlan(plan);
    const path2 = backupPlan(plan);
    expect(path1).not.toBe(path2);
  });
});
