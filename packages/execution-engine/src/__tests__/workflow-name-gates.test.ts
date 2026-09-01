import { describe, expect, it } from 'vitest';

import { isAdminBypassNamedWorkflow } from '../workflow-name-gates.js';

describe('isAdminBypassNamedWorkflow', () => {
  it('matches Mergify admin-bypass plan name prefixes', () => {
    expect(isAdminBypassNamedWorkflow('admin-bypass-repair-check-pr-1-typescript-abc1234')).toBe(true);
    expect(isAdminBypassNamedWorkflow('admin-bypass-rebase-onto-master-pr-1-abc1234')).toBe(true);
  });

  it('rejects non-admin-bypass names', () => {
    expect(isAdminBypassNamedWorkflow('feature-workflow')).toBe(false);
    expect(isAdminBypassNamedWorkflow('repair-pr-1-fingerprint')).toBe(false);
    expect(isAdminBypassNamedWorkflow(undefined)).toBe(false);
    expect(isAdminBypassNamedWorkflow(null)).toBe(false);
  });
});
