import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeatureMap } from './feature-map.mjs';

export const REQUIRED_SIDEBAR_TESTIDS = [
  'app-sidebar',
  'sidebar-home',
  'sidebar-planning',
  'sidebar-attention',
  'sidebar-workers',
  'sidebar-workflows',
];

export function runCatalogCheck(opts) {
  const features = loadFeatureMap(opts.featuresRoot);
  const errors = [];
  const warnings = [];
  const covered = new Set();

  if (features.length === 0) {
    errors.push('no feature files under references/features (expected *.md besides README.md)');
  }

  for (const feature of features) {
    for (const id of feature.testids) covered.add(id);
    if (!feature.prove || !feature.prove.trim()) {
      errors.push(`${feature.id}: missing prove: frontmatter`);
      continue;
    }
    const prove = feature.prove.trim();
    const pathMatch = prove.match(/(?:^|\s)((?:packages|scripts)\/[^\s]+\.(?:ts|tsx|js|mjs|sh|spec\.ts))/);
    if (pathMatch) {
      const rel = pathMatch[1];
      const abs = join(opts.repoRoot, rel);
      if (!existsSync(abs)) {
        errors.push(`${feature.id}: prove path does not exist: ${rel}`);
      }
    }
  }

  for (const required of REQUIRED_SIDEBAR_TESTIDS) {
    if (!covered.has(required)) {
      errors.push(`required sidebar testid not covered by any feature: ${required}`);
    }
  }

  const multi = features.find((f) => f.id === 'multi-surface-journeys');
  if (!multi) {
    warnings.push('missing multi-surface-journeys.md (recommended for broad sweeps)');
  }

  return {
    ok: errors.length === 0,
    featureCount: features.length,
    coveredTestids: [...covered].sort(),
    errors,
    warnings,
  };
}
