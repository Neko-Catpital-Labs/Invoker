import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from '../default-worktree-provision-command.js';

describe('DEFAULT_WORKTREE_PROVISION_COMMAND', () => {
  it('is empty so managed worktrees never auto-provision repos', () => {
    expect(DEFAULT_WORKTREE_PROVISION_COMMAND).toBe('');
    expect(DEFAULT_WORKTREE_PROVISION_COMMAND.trim()).toBe('');
  });
});
