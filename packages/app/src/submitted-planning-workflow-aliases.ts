import type { InAppPlanningPlanSummary } from '@invoker/contracts';
import type { Workflow } from '@invoker/data-store';

interface SubmittedPlanningSessionLike {
  status: string;
  draftPlanSummary?: InAppPlanningPlanSummary;
  submittedWorkflowId?: string;
  submittedWorkflowIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export function submittedPlanningStackWorkflowAliases(
  workflows: readonly Pick<Workflow, 'id' | 'name'>[],
  sessions: readonly SubmittedPlanningSessionLike[],
): Workflow[] {
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const workflowNames = new Set(workflows.map((workflow) => workflow.name));
  const aliases: Workflow[] = [];

  const addAlias = (
    session: SubmittedPlanningSessionLike,
    id: string | undefined,
    name: string | undefined,
  ): void => {
    const workflowId = id?.trim();
    const workflowName = name?.trim();
    if (!workflowId || !workflowName) return;
    if (workflowIds.has(workflowId) || workflowNames.has(workflowName)) return;

    workflowIds.add(workflowId);
    workflowNames.add(workflowName);
    aliases.push({
      id: workflowId,
      name: workflowName,
      description: 'Recovered submitted in-app planning stack identity; workflow row is missing.',
      status: 'closed',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      generation: 0,
    });
  };

  for (const session of sessions) {
    if (session.status !== 'submitted') continue;
    const summary = session.draftPlanSummary;
    const steps = summary?.steps ?? [];
    if (!summary || (summary.workflowCount ?? 0) < 2 || steps.length === 0) continue;

    const submittedWorkflowIds = session.submittedWorkflowIds?.filter((id) => id.trim().length > 0) ?? [];
    if (submittedWorkflowIds.length === steps.length) {
      submittedWorkflowIds.forEach((workflowId, index) => addAlias(session, workflowId, steps[index]));
      continue;
    }

    addAlias(session, session.submittedWorkflowId, steps.at(-1));
  }

  return aliases;
}
