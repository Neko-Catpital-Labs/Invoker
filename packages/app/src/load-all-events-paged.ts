import { MAX_EVENTS_PAGE, type TaskEvent } from '@invoker/contracts';

export interface LoadAllEventsPagedPersistence {
  getEvents(
    taskId: string,
    sortBy: 'asc' | 'desc',
    limit: number,
    beforeId?: number,
  ): TaskEvent[];
}

/** Server-side full history via repeated pages. Never used by UI/IPC gesture paths. */
export function loadAllEventsPaged(
  persistence: LoadAllEventsPagedPersistence,
  taskId: string,
): TaskEvent[] {
  const newestFirst: TaskEvent[] = [];
  let beforeId: number | undefined;
  for (;;) {
    const page = persistence.getEvents(taskId, 'desc', MAX_EVENTS_PAGE, beforeId);
    if (page.length === 0) break;
    newestFirst.push(...page);
    if (page.length < MAX_EVENTS_PAGE) break;
    beforeId = page[page.length - 1]!.id;
  }
  return newestFirst.slice().reverse();
}
