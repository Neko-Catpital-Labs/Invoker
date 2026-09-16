import type { CodexSpendGateStatus } from '@invoker/contracts';
import {
  codexSpendGateBlockMessage,
  defaultCodexSpendGatePath,
  loadCodexSpendGateTrip,
} from '@invoker/execution-engine';

export function readCodexSpendGateStatus(
  statePath: string = defaultCodexSpendGatePath(),
): { codexSpendGate?: CodexSpendGateStatus } {
  let trip;
  try {
    trip = loadCodexSpendGateTrip(statePath);
  } catch (error) {
    return {
      codexSpendGate: {
        state: 'unreadable',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (!trip) return {};
  return {
    codexSpendGate: {
      state: 'tripped',
      trippedAt: trip.trippedAt,
      dayKey: trip.dayKey,
      message: codexSpendGateBlockMessage(trip, statePath),
    },
  };
}
