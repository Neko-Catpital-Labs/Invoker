/** Mergify admin-bypass repair/rebase plans use this plan-name prefix. */
export const ADMIN_BYPASS_WORKFLOW_NAME_PREFIX = 'admin-bypass-';

/** True when a workflow plan name belongs to Mergify admin-bypass automation. */
export function isAdminBypassNamedWorkflow(name: string | undefined | null): boolean {
  return typeof name === 'string' && name.startsWith(ADMIN_BYPASS_WORKFLOW_NAME_PREFIX);
}
