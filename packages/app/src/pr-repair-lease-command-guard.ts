import type { SQLiteAdapter } from '@invoker/data-store';
import {
  hasActivePrRepairLease,
  type PrRepairLeaseContext,
} from '@invoker/execution-engine';

export function assertActiveBabysitPrRepairLease(
  lease: PrRepairLeaseContext | undefined,
  persistence: Pick<SQLiteAdapter, 'getPrRepairLeaseById'>,
  command: string,
): void {
  if (!hasActivePrRepairLease(lease, persistence)) {
    throw new Error(
      `Rejected babysit ${command} command because its PR repair lease is missing, expired, or does not match the PR head.`,
    );
  }
}
