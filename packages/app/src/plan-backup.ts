/**
 * Plan Backup — Saves submitted plans to ~/.invoker/plans/ for disaster recovery.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import type { PlanDefinition } from '@invoker/core';

let backupCounter = 0;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Back up a submitted plan to ~/.invoker/plans/.
 *
 * @param plan     The parsed plan definition.
 * @param yamlSource  Original YAML source text. If omitted, the plan is
 *                    serialized back to YAML via the `yaml` package.
 * @returns The absolute path of the backup file.
 */
export function backupPlan(plan: PlanDefinition, yamlSource?: string): string {
  const dir = join(homedir(), '.invoker', 'plans');
  mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = slugify(plan.name ?? 'unnamed');
  const filename = `${ts}-${++backupCounter}-${slug}.yaml`;
  const filepath = join(dir, filename);

  const content = yamlSource ?? stringifyYaml(plan);
  writeFileSync(filepath, content, 'utf-8');
  console.log(`[backup] Plan saved to ${filepath}`);

  return filepath;
}
