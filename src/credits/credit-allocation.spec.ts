import { allocateCredits } from './credit-allocation';
import { CreditBucket, AllocationSource } from './credit.types';
import { ReferenceType } from '@prisma/client';

describe('allocateCredits', () => {
  it('should allocate fully from the first source if sufficient', () => {
    const sources: AllocationSource[] = [
      { bucket: ReferenceType.SUBSCRIPTION, available: 100 },
      { bucket: ReferenceType.ADDON_PURCHASE, available: 50 },
    ];

    const result = allocateCredits(sources, 30);
    expect(result.totalAllocated).toBe(30);
    expect(result.shortfall).toBe(0);
    expect(result.allocations).toEqual([
      { bucket: ReferenceType.SUBSCRIPTION, amount: 30 },
    ]);
  });

  it('should spill over to the second source if the first is insufficient', () => {
    const sources: AllocationSource[] = [
      { bucket: ReferenceType.SUBSCRIPTION, available: 20 },
      { bucket: ReferenceType.ADDON_PURCHASE, available: 50 },
    ];

    const result = allocateCredits(sources, 50);
    expect(result.totalAllocated).toBe(50);
    expect(result.shortfall).toBe(0);
    expect(result.allocations).toEqual([
      { bucket: ReferenceType.SUBSCRIPTION, amount: 20 },
      { bucket: ReferenceType.ADDON_PURCHASE, amount: 30 },
    ]);
  });

  it('should return shortfall > 0 if all sources are insufficient', () => {
    const sources: AllocationSource[] = [
      { bucket: ReferenceType.SUBSCRIPTION, available: 10 },
      { bucket: ReferenceType.ADDON_PURCHASE, available: 15 },
    ];

    const result = allocateCredits(sources, 50);
    expect(result.totalAllocated).toBe(25);
    expect(result.shortfall).toBe(25);
    expect(result.allocations).toEqual([
      { bucket: ReferenceType.SUBSCRIPTION, amount: 10 },
      { bucket: ReferenceType.ADDON_PURCHASE, amount: 15 },
    ]);
  });

  it('should return empty allocations if amount is 0', () => {
    const sources: AllocationSource[] = [
      { bucket: ReferenceType.SUBSCRIPTION, available: 10 },
    ];

    const result = allocateCredits(sources, 0);
    expect(result.totalAllocated).toBe(0);
    expect(result.shortfall).toBe(0);
    expect(result.allocations).toEqual([]);
  });

  it('should handle empty sources correctly', () => {
    const result = allocateCredits([], 50);
    expect(result.totalAllocated).toBe(0);
    expect(result.shortfall).toBe(50);
    expect(result.allocations).toEqual([]);
  });

  it('should ignore sources with 0 available', () => {
    const sources: AllocationSource[] = [
      { bucket: ReferenceType.SUBSCRIPTION, available: 0 },
      { bucket: ReferenceType.ADDON_PURCHASE, available: 50 },
    ];

    const result = allocateCredits(sources, 30);
    expect(result.totalAllocated).toBe(30);
    expect(result.shortfall).toBe(0);
    expect(result.allocations).toEqual([
      { bucket: ReferenceType.ADDON_PURCHASE, amount: 30 },
    ]);
  });
});
