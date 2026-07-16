import { ResetInterval } from "@prisma/client";
import { addCalendarMonths } from "../common/utils/date.util";

export interface CreditPolicySpec {
  creditAmount: number;
  resetInterval: ResetInterval;
  intervalDays: number | null;
}

export class MissingCreditPolicyError extends Error {
  constructor(planId: string) {
    super(`Plan ${planId} has no CreditPolicy – cannot resolve credit entitlement`);
  }
}

export function nextCreditResetFrom(from: Date, policy: CreditPolicySpec): Date {
  if (policy.resetInterval === ResetInterval.MONTHLY) {
    return addCalendarMonths(from, 1);
  }

  if (policy.intervalDays === null || policy.intervalDays < 1) {
    throw new Error(
      `CreditPolicy resetInterval=EVERY_N_DAYS requires intervalDays >= 1, got ${policy.intervalDays}`,
    );
  }

  const result = new Date(from);
  result.setDate(result.getDate() + policy.intervalDays);
  return result;
}
