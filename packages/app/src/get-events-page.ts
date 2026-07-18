import {
  normalizeGetEventsOptions,
  type GetEventsOptions,
  type TaskEvent,
} from '@invoker/contracts';

export interface GetEventsPagePersistence {
  getEvents(
    taskId: string,
    sortBy: 'asc' | 'desc',
    limit: number,
    beforeId?: number,
  ): TaskEvent[];
}

/** Public get-events path: always paginated. Rejects missing/oversized limits. */
export function getEventsPage(
  persistence: GetEventsPagePersistence,
  taskId: string,
  options: unknown,
): TaskEvent[] {
  const normalized = normalizeGetEventsOptions(options);
  return persistence.getEvents(
    taskId,
    normalized.sortBy,
    normalized.limit,
    normalized.beforeId,
  );
}

export type { GetEventsOptions };
