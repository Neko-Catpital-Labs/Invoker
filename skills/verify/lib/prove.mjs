import { spawnSync } from 'node:child_process';
import { findFeature } from './feature-map.mjs';

export function resolveProve(featuresRoot, featureId) {
  const feature = findFeature(featuresRoot, featureId);
  if (!feature) {
    return { ok: false, error: `unknown feature: ${featureId}`, feature: null, command: null };
  }
  if (!feature.prove || !feature.prove.trim()) {
    return { ok: false, error: `feature ${feature.id} has no prove command in frontmatter`, feature, command: null };
  }
  return { ok: true, error: null, feature, command: feature.prove.trim() };
}

export function runProve(opts) {
  const resolved = resolveProve(opts.featuresRoot, opts.featureId);
  if (!resolved.ok) {
    return { ...resolved, exitCode: 1, stdout: '', stderr: resolved.error };
  }
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      feature: resolved.feature,
      command: resolved.command,
      exitCode: 0,
      stdout: resolved.command,
      stderr: '',
    };
  }
  const result = spawnSync(resolved.command, {
    cwd: opts.repoRoot,
    encoding: 'utf8',
    shell: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    dryRun: false,
    feature: resolved.feature,
    command: resolved.command,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
