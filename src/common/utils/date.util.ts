export const MS_PER_SECOND = 1000;

export function fromUnixSeconds(seconds: number): Date {
  return new Date(seconds * MS_PER_SECOND);
}

export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_SECOND);
}

export function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const originalDay = result.getDate();

  result.setMonth(result.getMonth() + months);

  if (result.getDate() !== originalDay) {
    result.setDate(0);
  }

  return result;
}

export function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}
