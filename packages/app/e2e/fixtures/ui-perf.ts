import type { Page } from '@playwright/test';

export type UiPerfPayload = Record<string, unknown>;

export function parseActivityPayload(message: string): UiPerfPayload | null {
  try {
    return JSON.parse(message) as UiPerfPayload;
  } catch {
    return null;
  }
}

export function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function maxPayloadNumber(
  payloads: readonly UiPerfPayload[],
  metric: string,
  field: string,
): number {
  let max = 0;
  for (const payload of payloads) {
    if (payload.metric !== metric) continue;
    max = Math.max(max, numberOrZero(payload[field]));
  }
  return max;
}

export async function activityLogWatermark(page: Page): Promise<number> {
  const rows = await page.evaluate(async () => window.invoker.getActivityLogs(0, 100000));
  return rows.at(-1)?.id ?? 0;
}

export async function uiPerfPayloadsSince(page: Page, sinceId: number): Promise<UiPerfPayload[]> {
  const rows = await page.evaluate(async (watermark) => window.invoker.getActivityLogs(watermark, 5000), sinceId);
  return rows
    .filter((row) => row.source === 'ui-perf')
    .map((row) => parseActivityPayload(row.message))
    .filter((payload): payload is UiPerfPayload => payload !== null);
}
