import type { Familiar } from './familiar.js';

export class FamiliarRegistry {
  private familiars = new Map<string, Familiar>();

  register(type: string, familiar: Familiar): void {
    this.familiars.set(type, familiar);
  }

  get(type: string): Familiar | undefined {
    return this.familiars.get(type);
  }

  getDefault(): Familiar {
    const worktree = this.familiars.get('worktree');
    if (!worktree) {
      throw new Error('No "worktree" familiar registered. Register one before calling getDefault().');
    }
    return worktree;
  }

  getAll(): Familiar[] {
    return Array.from(this.familiars.values());
  }
}
