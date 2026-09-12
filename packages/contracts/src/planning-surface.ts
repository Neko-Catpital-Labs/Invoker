export type PlanningHostSurface = 'in_app' | 'slack';

export type PlanningSubmitAction = 'prepare_review' | 'submit_ready';

function normalizedPlanningCommand(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
}

export function isExactPlanningSubmitCommand(text: string): boolean {
  return [
    'submit',
    'submit it',
    'submit to invoker',
  ].includes(normalizedPlanningCommand(text));
}

export function resolvePlanningSubmitAction(
  text: string,
  hasReadyDraft: boolean,
): PlanningSubmitAction | null {
  if (!isExactPlanningSubmitCommand(text)) return null;
  return hasReadyDraft ? 'submit_ready' : 'prepare_review';
}

export function planningHostContext(surface: PlanningHostSurface): string {
  if (surface === 'in_app') {
    return [
      'Current planning host: Invoker in-app planner.',
      '- Never direct the user to Slack or claim that a Slack review card exists.',
      '- When you write valid YAML, the in-app host stages that exact draft in its review panel.',
      '- Writing YAML does not submit or execute it; the user must approve the staged draft.',
    ].join('\n');
  }

  return [
    'Current planning host: Invoker Slack planner.',
    '- When you write valid YAML, the Slack host stages that exact draft in an Approve/Cancel review card.',
    '- Writing YAML does not submit or execute it; the user must approve the staged draft.',
  ].join('\n');
}

export function formatPlanningHostedTurn(
  surface: PlanningHostSurface,
  userMessage: string,
): string {
  return `${planningHostContext(surface)}\n\nUser message:\n${userMessage}`;
}
