import type { TaskState, WorkflowMeta } from '../types.js';

export type SearchResult =
  | { kind: 'workflow'; id: string; title: string; subtitle: string }
  | { kind: 'task'; id: string; workflowId: string | null; title: string; subtitle: string };

export function normalizedSearchText(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

const MAX_SEARCH_RESULTS = 12;

export function computeSearchResults(
  query: string,
  tasks: Map<string, TaskState>,
  workflows: Map<string, WorkflowMeta>,
): SearchResult[] {
  const needle = normalizedSearchText(query.trim());
  if (!needle) return [];

  const tasksByWorkflowId = new Map<string, TaskState[]>();
  for (const task of tasks.values()) {
    const wid = task.config.workflowId;
    if (!wid) continue;
    let list = tasksByWorkflowId.get(wid);
    if (list === undefined) {
      list = [];
      tasksByWorkflowId.set(wid, list);
    }
    list.push(task);
  }

  const results: SearchResult[] = [];
  for (const workflow of workflows.values()) {
    const workflowTasks = tasksByWorkflowId.get(workflow.id) ?? [];
    const reviewUrl = workflowTasks.find((task) => task.execution.reviewUrl)?.execution.reviewUrl;
    const haystack = [
      workflow.id,
      workflow.name,
      workflow.status,
      workflow.repoUrl,
      workflow.intermediateRepoUrl,
      reviewUrl,
    ].map(normalizedSearchText).join(' ');
    if (haystack.includes(needle)) {
      results.push({
        kind: 'workflow',
        id: workflow.id,
        title: workflow.name || workflow.id,
        subtitle: `Workflow · ${workflow.status}`,
      });
    }
  }
  for (const task of tasks.values()) {
    const workflow = task.config.workflowId ? workflows.get(task.config.workflowId) : null;
    const haystack = [
      task.id,
      task.description,
      task.status,
      task.config.summary,
      task.config.prompt,
      task.config.command,
      task.execution.reviewUrl,
      workflow?.name,
    ].map(normalizedSearchText).join(' ');
    if (haystack.includes(needle)) {
      results.push({
        kind: 'task',
        id: task.id,
        workflowId: task.config.workflowId ?? null,
        title: task.description || task.id,
        subtitle: `Task · ${workflow?.name ?? task.config.workflowId ?? 'unknown workflow'}`,
      });
    }
  }
  return results.slice(0, MAX_SEARCH_RESULTS);
}
