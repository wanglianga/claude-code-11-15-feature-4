/** 日期工具：业务日期一律用本地 'YYYY-MM-DD' 字符串，避免时区漂移 */

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return toDateStr(new Date());
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

export function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
export function weekdayLabel(dateStr: string): string {
  return `周${WEEKDAY_CN[weekdayOf(dateStr)]}`;
}

/** 报损补录窗口截止时刻：营业日次日 wasteWindowHour 点 */
export function wasteWindowDeadline(businessDate: string, wasteWindowHour: number): Date {
  const d = new Date(`${businessDate}T00:00:00`);
  d.setDate(d.getDate() + 1);
  d.setHours(wasteWindowHour, 0, 0, 0);
  return d;
}
