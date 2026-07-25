import type { SQLiteAdapter } from '@invoker/data-store';
import {
  hasActivePrRepairLease,
  type RepairKind,
  type PrRepairLeaseContext,
} from '@invoker/execution-engine';

export function assertActiveBabysitPrRepairLease(
  lease: PrRepairLeaseContext | undefined,
  persistence: Pick<SQLiteAdapter, 'getPrRepairLease' | 'getPrRepairLeaseById'>,
  command: string,
  expectedHolderKind?: RepairKind,
): void {
  if (!hasActivePrRepairLease(lease, persistence)) {
    throw new Error(
      `Rejected babysit ${command} command because its PR repair lease is missing, expired, or does not match the PR head.`,
    );
  }
  const holderKind = persistence.getPrRepairLease(lease!.repo, lease!.prNumber, lease!.headSha)?.holderKind;
  if (expectedHolderKind && holderKind !== expectedHolderKind) {
    throw new Error(
      `Rejected babysit ${command} command because its PR repair lease is held for ${holderKind ?? 'an unknown'} repair, not ${expectedHolderKind}.`,
    );
  }
}
