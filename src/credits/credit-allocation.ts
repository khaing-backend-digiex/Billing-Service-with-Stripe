import {
  AllocationSource,
  AllocationResult,
} from './credit.types';
import { CreditGrantSourceType } from '@prisma/client';

export function allocateCredits(
  sources: AllocationSource[],
  amount: number,
): AllocationResult {
  const allocations: { grantId: string; sourceType: CreditGrantSourceType; amount: number }[] = [];
  let remaining = amount;

  for (const source of sources) {
    if (remaining <= 0) break;

    const take = Math.min(remaining, source.available);
    if (take > 0) {
      allocations.push({ grantId: source.grantId, sourceType: source.sourceType, amount: take });
      remaining -= take;
    }
  }

  return {
    allocations,
    totalAllocated: amount - remaining,
    shortfall: remaining,
  };
}
