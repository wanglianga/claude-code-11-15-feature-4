/**
 * 需求还原：把当日实销 + 断货信息还原成"截断观测样本"。
 *
 * 写死的取舍（口径中途不能换）：
 * - 不直接拿实销当需求训练。缺货日实销被货架截断，直接训练会让模型越缺越保守。
 * - 售罄/断货日：用有货时段销售速率外推全天，得到右删失需求的点估计（is_censored=true）。
 * - 断货标记缺失（null）：无法判断是否截断，只能降级为保守估计（restored = 实销，degraded=true）。
 * - 该口径同时决定收市复盘以"观测需求"而非"实销"为归因基准。
 */

export interface ObservationInput {
  salesQty: number;              // 实销
  openHours: number;             // 当日营业时长（小时）
  stockoutFlag: boolean | null;  // 断货标记；null = 门店未回传 → 降级
  selloutTime?: string | null;   // 售罄时点 'HH:MM'
  openTime?: string;             // 开店时间，默认 08:00
}

export interface RestoredObservation {
  inStockHours: number;    // 有货时段时长
  inStockRate: number;     // 有货时段销售速率
  restoredDemand: number;  // 还原后需求
  isCensored: boolean;     // 是否截断观测
  degraded: boolean;       // 断货标记缺失 → 保守降级
}

export const DEFAULT_OPEN_TIME = '08:00';

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function restoreDemand(input: ObservationInput): RestoredObservation {
  const openTime = input.openTime ?? DEFAULT_OPEN_TIME;
  const { salesQty, openHours } = input;
  const safeOpenHours = Math.max(openHours, 0.5);

  // 断货标记缺失：只能降级为保守估计（以实销为需求下界，不外推）
  if (input.stockoutFlag === null || input.stockoutFlag === undefined) {
    return {
      inStockHours: safeOpenHours,
      inStockRate: salesQty / safeOpenHours,
      restoredDemand: salesQty,
      isCensored: false,
      degraded: true,
    };
  }

  const hasSellout = input.stockoutFlag === true || !!input.selloutTime;
  if (!hasSellout) {
    // 全天有货：实销即需求
    return {
      inStockHours: safeOpenHours,
      inStockRate: salesQty / safeOpenHours,
      restoredDemand: salesQty,
      isCensored: false,
      degraded: false,
    };
  }

  // 截断观测：售罄时点前为有货时段，用有货时段速率外推全天营业时长
  if (!input.selloutTime) {
    // 有断货标记但无售罄时点：无法定位截断点，保守取实销（需求下界），仍标记截断
    return {
      inStockHours: safeOpenHours,
      inStockRate: salesQty / safeOpenHours,
      restoredDemand: salesQty,
      isCensored: true,
      degraded: false,
    };
  }
  const inStockHours = Math.max((toMinutes(input.selloutTime) - toMinutes(openTime)) / 60, 0.5);
  const rate = salesQty / inStockHours;
  return {
    inStockHours,
    inStockRate: rate,
    restoredDemand: rate * safeOpenHours,
    isCensored: true,
    degraded: false,
  };
}
