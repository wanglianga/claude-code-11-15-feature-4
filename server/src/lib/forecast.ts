/**
 * 分位预测核心：
 * - 建议量取临界分位 τ = Cu / (Cu + Co)，Cu=缺货单位损失（毛利+客流损失），Co=报损单位成本。
 *   叶菜 Co 相对 Cu 小（报损虽狠，但缺货会把顾客推去别家、损失整单毛利）→ 高分位；
 *   根茎类默认 Cu=Co → 中位。同品类不同门店允许覆盖（cost_params 表）。
 * - 不用期望值给数：期望掩盖尾部风险，且单价比标定错会让历史订单损耗归因整体偏移。
 * - 建议量向上取整到最小订货单位。
 */

export function criticalQuantile(cu: number, co: number): number {
  if (!(cu > 0) || !(co > 0)) throw new Error(`非法成本参数 cu=${cu} co=${co}`);
  return cu / (cu + co);
}

/** 经验分位数（线性插值，与 numpy 默认一致） */
export function empiricalQuantile(samples: number[], tau: number): number {
  if (samples.length === 0) throw new Error('无样本无法求分位');
  const s = [...samples].sort((a, b) => a - b);
  const idx = tau * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function median(samples: number[]): number {
  return empiricalQuantile(samples, 0.5);
}

/** 向上取整到最小订货单位的整数倍（带浮点保护） */
export function roundUpToUnit(qty: number, unit: number): number {
  if (!(unit > 0)) return Math.ceil(qty);
  return Math.ceil(qty / unit - 1e-9) * unit;
}

/** 特征因子（写死的业务规则；现行"上周同期×品类系数"在这些场景失效，故显式建模） */
export const FEATURE_FACTORS = {
  promotion: 1.25,   // 促销
  holiday: 1.15,     // 节假日
  tempDrop: 0.9,     // 降温超出预报
  competitor: 0.9,   // 隔壁新开一家店
} as const;

export interface FeatureInput {
  promotion?: boolean;
  holiday?: boolean;
  tempDrop?: boolean;
  competitor?: boolean;
  deliveryDelayHours?: number; // 配送车延误：压缩当日可售时长，按比例缩放
}

export function combinedFactor(
  f: FeatureInput,
  openHours = 13,
): { factor: number; applied: Record<string, number> } {
  const applied: Record<string, number> = {};
  let factor = 1;
  if (f.promotion) { factor *= FEATURE_FACTORS.promotion; applied.promotion = FEATURE_FACTORS.promotion; }
  if (f.holiday) { factor *= FEATURE_FACTORS.holiday; applied.holiday = FEATURE_FACTORS.holiday; }
  if (f.tempDrop) { factor *= FEATURE_FACTORS.tempDrop; applied.tempDrop = FEATURE_FACTORS.tempDrop; }
  if (f.competitor) { factor *= FEATURE_FACTORS.competitor; applied.competitor = FEATURE_FACTORS.competitor; }
  if (f.deliveryDelayHours && f.deliveryDelayHours > 0) {
    const r = Math.max(openHours - f.deliveryDelayHours, 1) / openHours;
    factor *= r;
    applied.deliveryDelay = Number(r.toFixed(4));
  }
  return { factor, applied };
}
