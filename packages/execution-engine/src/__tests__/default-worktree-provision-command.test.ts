import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from '../default-worktree-provision-command.js';

describe('DEFAULT_WORKTREE_PROVISION_COMMAND', () => {
  it('forces pnpm to install dev dependencies even under production config', () => {
    expect(DEFAULT_WORKTREE_PROVISION_COMMAND).toContain('NODE_ENV=development');
    expect(DEFAULT_WORKTREE_PROVISION_COMMAND).toContain('PNPM_CONFIG_PRODUCTION=false');
    expect(DEFAULT_WORKTREE_PROVISION_COMMAND).toContain('npm_config_production=false');
    expect(DEFAULT_WORKTREE_PROVISION_COMMAND).toContain('NPM_CONFIG_PRODUCTION=false');
    expect(DEFAULT_WORKTREE_PROVISION_COMMAND).toContain('pnpm install --prod=false');
  });

  it('uses the dev-dependency install wrapper for frozen and lockfile refresh installs', () => {
    expect(DEFAULT_WORKTREE_PROVISION_COMMAND).toContain('invoker_pnpm_install_with_dev --frozen-lockfile');
    expect(DEFAULT_WORKTREE_PROVISION_COMMAND).toContain('invoker_pnpm_install_with_dev --lockfile-only');
  });
});
