export const DEFAULT_INVESTIGATION_COOLDOWN_MS = 60 * 60_000;

export interface InvestigationPlanThrottle {
  isThrottled(externalKey: string, now?: number): boolean;
  mark(externalKey: string, now?: number): void;
}

export function createInvestigationPlanThrottle(
  cooldownMs: number,
  entries?: Map<string, number>,
): InvestigationPlanThrottle {
  const lastInvestigationAt = entries ?? new Map<string, number>();

  return {
    isThrottled(externalKey: string, now = Date.now()): boolean {
      if (cooldownMs <= 0) return false;
      const last = lastInvestigationAt.get(externalKey);
      return last !== undefined && now - last < cooldownMs;
    },
    mark(externalKey: string, now = Date.now()): void {
      if (cooldownMs > 0) {
        lastInvestigationAt.set(externalKey, now);
      }
    },
  };
}
