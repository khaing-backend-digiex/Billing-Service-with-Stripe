import { ResetInterval } from '@prisma/client';
import { DAYS_PER_MONTH } from '../common/constants/plan.constants';

const MIN_RESET_MONTHS = 1;

export interface CreditPolicyInterval {
  resetInterval: ResetInterval;
  intervalDays: number | null;
}

export function resolveResetMonths(
  policy?: CreditPolicyInterval | null,
): number {
  if (policy?.resetInterval === ResetInterval.MONTHLY) {
    return MIN_RESET_MONTHS;
  }

  return Math.max(
    MIN_RESET_MONTHS,
    Math.round((policy?.intervalDays || DAYS_PER_MONTH) / DAYS_PER_MONTH),
  );
}
