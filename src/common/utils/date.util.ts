/**
 * Cộng N tháng vào một ngày theo calendar-month.
 *
 * Xử lý edge case khi ngày gốc > ngày cuối tháng đích:
 *   - 31/1 + 1 tháng = 28/2 (hoặc 29/2 năm nhuận)
 *   - 29/2 + 12 tháng = 28/2 (năm không nhuận) hoặc 29/2 (năm nhuận)
 *
 * Giống cách Stripe tính billing cycle.
 */
export function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const originalDay = result.getDate();

  result.setMonth(result.getMonth() + months);

  // Nếu ngày bị tràn (ví dụ: 31/1 → setMonth(1) → 3/3),
  // lùi về ngày cuối cùng của tháng đích bằng cách set date = 0
  if (result.getDate() !== originalDay) {
    result.setDate(0);
  }

  return result;
}
