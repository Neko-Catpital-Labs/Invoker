import { createHash, randomUUID } from 'node:crypto';
import type { PersistenceAdapter, PlanningDraft } from './adapter.js';

export class PlanningDraftRepository {
  constructor(private readonly adapter: PersistenceAdapter) {}

  createCurrent(conversationId: string, planText: string): PlanningDraft {
    const normalized = planText.trim();
    if (!normalized) {
      throw new Error('Cannot persist an empty planning draft.');
    }
    return this.adapter.createCurrentPlanningDraft({
      id: randomUUID(),
      conversationId,
      planText: normalized,
      contentHash: createHash('sha256').update(normalized).digest('hex'),
      createdAt: new Date().toISOString(),
    });
  }

  getCurrent(conversationId: string): PlanningDraft | undefined {
    return this.adapter.loadCurrentPlanningDraft(conversationId);
  }

  get(id: string): PlanningDraft | undefined {
    return this.adapter.loadPlanningDraft(id);
  }

  supersedeCurrent(conversationId: string): void {
    this.adapter.supersedeCurrentPlanningDraft(conversationId, new Date().toISOString());
  }

  supersede(id: string): void {
    this.adapter.supersedePlanningDraft(id, new Date().toISOString());
  }

  markSubmitted(id: string): void {
    this.adapter.markPlanningDraftSubmitted(id, new Date().toISOString());
    if (this.adapter.loadPlanningDraft(id)?.status !== 'submitted') {
      throw new Error(`Planning draft ${id} is not the current draft and cannot be submitted.`);
    }
  }
}
