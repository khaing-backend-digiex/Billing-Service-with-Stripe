import {
  AllocationSource,
  AllocationResult,
  CreditBucket,
} from './credit.types';

export function allocateCredits(
  sources: AllocationSource[],
  amount: number,
): AllocationResult {
  const allocations: { bucket: CreditBucket; amount: number }[] = [];
  let remaining = amount;

  for (const source of sources) {
    if (remaining <= 0) break;

    const take = Math.min(remaining, source.available);
    if (take > 0) {
      allocations.push({ bucket: source.bucket, amount: take });
      remaining -= take;
    }
  }

  return {
    allocations,
    totalAllocated: amount - remaining,
    shortfall: remaining,
  };
}
