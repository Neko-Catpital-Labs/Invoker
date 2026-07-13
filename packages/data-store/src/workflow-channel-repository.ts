/**
 * WorkflowChannelRepository — Domain-level API for the Slack workflow↔channel mapping.
 */

import type { PersistenceAdapter, WorkflowChannel } from './adapter.js';

export class WorkflowChannelRepository {
  private adapter: PersistenceAdapter;

  constructor(adapter: PersistenceAdapter) {
    this.adapter = adapter;
  }

  save(rec: WorkflowChannel): void {
    this.adapter.saveWorkflowChannel(rec);
  }

  getByWorkflowId(workflowId: string): WorkflowChannel | null {
    return this.adapter.loadWorkflowChannelByWorkflowId(workflowId) ?? null;
  }

  getByChannelId(channelId: string): WorkflowChannel | null {
    return this.adapter.loadWorkflowChannelByChannelId(channelId) ?? null;
  }

  list(): WorkflowChannel[] {
    return this.adapter.listWorkflowChannels();
  }

  delete(workflowId: string): void {
    this.adapter.deleteWorkflowChannel(workflowId);
  }
}
