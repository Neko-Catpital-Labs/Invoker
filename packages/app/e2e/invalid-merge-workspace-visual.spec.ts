import { test, expect, loadPlan, injectTaskStates, captureScreenshot, getTasks, E2E_REPO_URL } from './fixtures/electron-app.js';

type TaskLike = {
  id: string;
  config?: {
    isMergeNode?: boolean;
  };
};

function asTaskList(value: unknown): TaskLike[] {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && 'tasks' in value
      ? (value as { tasks: unknown }).tasks
      : [];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((entry): entry is TaskLike => {
    return Boolean(
      entry &&
      typeof entry === 'object' &&
      'id' in entry &&
      typeof (entry as { id: unknown }).id === 'string',
    );
  });
}

const PLAN = {
  name: 'Invalid merge workspace visual proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review',
  tasks: [
    {
      id: 'implementation',
      description: 'Implementation task before merge gate',
      command: 'echo ok',
      dependencies: [] as string[],
    },
  ],
};

test('invalid merge workspace error appears in task panel', async ({ page }) => {
  await loadPlan(page, PLAN);

  const tasks = asTaskList(await getTasks(page));
  const mergeTask = tasks.find((task) => task.config?.isMergeNode === true);
  expect(mergeTask, 'merge gate task exists').toBeTruthy();
  if (!mergeTask) return;

  const message = "[Fix with Agent failed] Cannot apply a fix because this merge gate's saved workspace is missing or is not a git repository: /Users/edbertchan/.invoker/merge-launches/launch-__merge__wf-1782192504629-22-f7dhPo. This task state is stale or corrupted. Recreate this merge-gate task from a fresh base, then rerun the gate.\n\nUnable to resolve merge worktree ref \"plan/old-base\"";

  await injectTaskStates(page, [
    {
      taskId: mergeTask.id,
      changes: {
        status: 'failed',
        execution: {
          error: message,
          workspacePath: '/Users/edbertchan/.invoker/merge-launches/launch-__merge__wf-1782192504629-22-f7dhPo',
          pendingFixError: undefined,
          completedAt: new Date(),
        },
      },
    },
  ]);

  await page.getByTestId(`rf__node-${mergeTask.id}`).click();
  await expect(page.getByText('Cannot apply a fix because this merge gate')).toBeVisible({ timeout: 5000 });
  await captureScreenshot(page, 'invalid-merge-workspace-error');
});
