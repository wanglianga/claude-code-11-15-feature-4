/**
 * 试销估计核心（后端权威计算）：
 *
 * - 经理按 店型/商圈/规格/营业时段 选参照商品，每个时段把参照数据折算成"相当于多少个有货小时"；
 * - 估计时把参照销量与新品实售累加、除以对应有货时长 → 小时需求强度 λ_hour；
 * - 整日需求 = λ_hour × 当日营业时长，用泊松计数分位 τ=Cu/(Cu+Co) 取整日需求分位，
 *   再向上取整到最小订货单位，得到订货建议；同时给出缺货损失/报损成本期望；
 * - 参照是"固定一天"的等价时长：新品实售随观察时长累积，逐渐在分母与分子中占优（转变慢）；
 * - 同时给出"取消参照"的对照结果，量化保守建议少订多少。
 *
 * 售罄后的时段（no_stock）不计入观察时长，也不按 0 销量计入；停业（closed）、漏报（missing）
 * 同样不计入观察时长。
 */

import { criticalQuantile, roundUpToUnit } from './forecast';
import { poissonQuantile, poissonPmf } from './poisson';

export interface PeriodDef {
  key: string;
  label: string;
  start: string;
  end: string;
  hours: number;
}

/** 标准营业时段：08:00-21:00，共 13 小时，与分位预测口径一致 */
export const STANDARD_PERIODS: PeriodDef[] = [
  { key: 'morning', label: '早市', start: '08:00', end: '12:00', hours: 4 },
  { key: 'midday', label: '日市', start: '12:00', end: '17:00', hours: 5 },
  { key: 'evening', label: '晚市', start: '17:00', end: '21:00', hours: 4 },
];

export function periodsFor(keys: string[] | null | undefined): PeriodDef[] {
  const picked = keys && keys.length > 0 ? keys : STANDARD_PERIODS.map((p) => p.key);
  return STANDARD_PERIODS.filter((p) => picked.includes(p.key));
}

export function openHoursPerDay(periods: PeriodDef[]): number {
  return periods.reduce((s, p) => s + p.hours, 0);
}

export type ObservationStatus = 'operating' | 'sold_out' | 'no_stock' | 'closed' | 'missing';

/** 只有 operating / sold_out 计入观察时长与实售；其余状态的贡献一律为 0 */
export function countsObservation(status: ObservationStatus): boolean {
  return status === 'operating' || status === 'sold_out';
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** 售罄时段的有效有货时长：时段起点 → 售罄时点，夹在 [0, 时段时长] */
export function soldOutHours(period: PeriodDef, selloutTime: string | null | undefined): number {
  if (!selloutTime) return 0;
  const raw = (minutesOf(selloutTime) - minutesOf(period.start)) / 60;
  return Math.max(0, Math.min(period.hours, Number(raw.toFixed(2))));
}

export interface RefLine {
  period: string;
  salesQty: number;
  inStockHours: number;
}

export interface ObsLine {
  businessDate: string;
  period: string;
  status: ObservationStatus;
  actualSales: number;
  inStockHours: number;
}

export interface TrialInput {
  periods: PeriodDef[];
  referenceLines: RefLine[];
  observations: ObsLine[];
  cu: number;
  co: number;
  minOrderUnit: number;
}

export interface DemandBlock {
  /** 用于估计的销量合计与有货时长合计 */
  salesQty: number;
  inStockHours: number;
  hourlyRate: number;
  /** 整日需求均值 λ = 小时强度 × 每日营业时长 */
  lambda: number;
  quantile: number;
  /** 整日需求分位（泊松计数） */
  demandQuantile: number;
  /** 向上取整到最小订货单位后的建议量 */
  suggestedQty: number;
  rawQty: number;
  /** 90% 预测区间 [q05, q95] */
  intervalLow: number;
  intervalHigh: number;
  expectedShortageUnits: number;
  expectedWasteUnits: number;
  shortageCost: number;
  wasteCost: number;
  expectedTotalCost: number;
}

export interface EstimateResult {
  openHoursPerDay: number;
  tau: number;
  cu: number;
  co: number;
  minOrderUnit: number;
  actual: { salesQty: number; inStockHours: number; hourlyRate: number; observedDays: number };
  reference: { salesQty: number; inStockHours: number; hourlyRate: number; lineCount: number };
  withRef: DemandBlock;
  withoutRef: DemandBlock;
  /** 合算建议 − 取消参照建议：正数为保守（无参照）少订，负数为无参照样本少导致虚高多订 */
  deltaQty: number;
  explanation: string;
}

const round2 = (n: number) => Number(n.toFixed(2));

/** E[(X-Q)+] 泊松：缺货期望件数 */
export function poissonExpectedShortage(mu: number, Q: number): number {
  if (mu <= 0) return 0;
  if (Q <= 0) return mu;
  let kSum = 0;
  for (let k = 1; k <= Q; k++) kSum += k * poissonPmf(mu, k);
  // 尾部期望：mu - Σ_{k<=Q} k p_k - Q * P(X>Q)
  let cdf = 0;
  for (let k = 0; k <= Q; k++) cdf += poissonPmf(mu, k);
  return Math.max(0, mu - kSum - Q * Math.max(0, 1 - cdf));
}

/** E[(Q-X)+] 泊松：报损期望件数 */
export function poissonExpectedWaste(mu: number, Q: number): number {
  if (mu <= 0) return Math.max(0, Q);
  if (Q <= 0) return 0;
  let cdf = 0;
  let kSum = 0;
  for (let k = 0; k < Q; k++) {
    cdf += poissonPmf(mu, k);
    kSum += k * poissonPmf(mu, k);
  }
  return Math.max(0, Q * cdf - kSum);
}

function demandBlock(
  salesQty: number,
  inStockHours: number,
  openHours: number,
  tau: number,
  minUnit: number,
  cu: number,
  co: number,
): DemandBlock {
  const hourlyRate = inStockHours > 0 ? salesQty / inStockHours : 0;
  const lambda = hourlyRate * openHours;
  const demandQuantile = lambda > 0 ? poissonQuantile(lambda, tau) : 0;
  const rawQty = lambda > 0 ? demandQuantile : 0;
  const suggestedQty = rawQty > 0 ? roundUpToUnit(rawQty, minUnit) : 0;
  const intervalLow = lambda > 0 ? poissonQuantile(lambda, 0.05) : 0;
  const intervalHigh = lambda > 0 ? poissonQuantile(lambda, 0.95) : 0;
  const expectedShortageUnits = poissonExpectedShortage(lambda, suggestedQty);
  const expectedWasteUnits = poissonExpectedWaste(lambda, suggestedQty);
  return {
    salesQty: round2(salesQty),
    inStockHours: round2(inStockHours),
    hourlyRate: round2(hourlyRate),
    lambda: round2(lambda),
    quantile: Number(tau.toFixed(4)),
    demandQuantile,
    suggestedQty,
    rawQty,
    intervalLow,
    intervalHigh,
    expectedShortageUnits: round2(expectedShortageUnits),
    expectedWasteUnits: round2(expectedWasteUnits),
    shortageCost: round2(expectedShortageUnits * cu),
    wasteCost: round2(expectedWasteUnits * co),
    expectedTotalCost: round2(expectedShortageUnits * cu + expectedWasteUnits * co),
  };
}

/**
 * 试销需求估计：参照 + 实售合算，并给出取消参照的保守对照。
 */
export function computeTrialEstimate(input: TrialInput): EstimateResult {
  const openHours = openHoursPerDay(input.periods);
  const tau = criticalQuantile(input.cu, input.co);
  const minUnit = input.minOrderUnit > 0 ? input.minOrderUnit : 1;

  let refSales = 0;
  let refHours = 0;
  for (const r of input.referenceLines) {
    if (!(r.inStockHours > 0) || !(r.salesQty >= 0)) continue;
    refSales += r.salesQty;
    refHours += r.inStockHours;
  }

  let actualSales = 0;
  let actualHours = 0;
  const observedDates = new Set<string>();
  for (const o of input.observations) {
    if (!countsObservation(o.status)) continue;
    if (!(o.inStockHours > 0)) continue;
    actualSales += Math.max(0, o.actualSales);
    actualHours += o.inStockHours;
    observedDates.add(o.businessDate);
  }

  const withRef = demandBlock(actualSales + refSales, actualHours + refHours, openHours, tau, minUnit, input.cu, input.co);
  const withoutRef = demandBlock(actualSales, actualHours, openHours, tau, minUnit, input.cu, input.co);
  const deltaQty = Number((withRef.suggestedQty - withoutRef.suggestedQty).toFixed(2));

  const actualPct = actualHours + refHours > 0 ? (actualHours / (actualHours + refHours)) * 100 : 0;
  let explanation: string;
  if (actualHours <= 0) {
    explanation = `尚无新品实售：取消参照后无可估数据，保守建议 0；合算参照建议 ${withRef.suggestedQty}，少订 ${deltaQty}。`;
  } else if (deltaQty > 0) {
    explanation = `取消参照只剩 ${round2(actualHours)} 个有货小时（占总时长 ${actualPct.toFixed(1)}%），λ ${withoutRef.lambda} → τ=${tau.toFixed(2)} 分位 ${withoutRef.demandQuantile} → 保守建议 ${withoutRef.suggestedQty}；比合算建议少订 ${deltaQty}。转变较慢：实售要累积到与参照相当的有效观察时长才会占优。`;
  } else if (deltaQty < 0) {
    explanation = `取消参照只剩 ${round2(actualHours)} 个有货小时（占 ${actualPct.toFixed(1)}%），样本少且速率偏高（λ ${withoutRef.lambda}），单段外推反而不稳 → 建议 ${withoutRef.suggestedQty}，比合算建议多订 ${Math.abs(deltaQty)}；这正是合算参照能压住的首日团购式虚高。`;
  } else {
    explanation = `取消参照只剩 ${round2(actualHours)} 个有货小时（占 ${actualPct.toFixed(1)}%），λ ${withoutRef.lambda} → 建议 ${withoutRef.suggestedQty}，与合算建议相同（少订 0）。`;
  }

  return {
    openHoursPerDay: openHours,
    tau: Number(tau.toFixed(4)),
    cu: input.cu,
    co: input.co,
    minOrderUnit: minUnit,
    actual: {
      salesQty: round2(actualSales),
      inStockHours: round2(actualHours),
      hourlyRate: actualHours > 0 ? round2(actualSales / actualHours) : 0,
      observedDays: observedDates.size,
    },
    reference: {
      salesQty: round2(refSales),
      inStockHours: round2(refHours),
      hourlyRate: refHours > 0 ? round2(refSales / refHours) : 0,
      lineCount: input.referenceLines.filter((r) => r.inStockHours > 0).length,
    },
    withRef,
    withoutRef,
    deltaQty,
    explanation,
  };
}

/* ------------------------------------------------------------------ */
/* 转正检查：连续有效营业日的预测区间覆盖率 + 实际损耗                  */
/* ------------------------------------------------------------------ */

export const GRADUATION_RULES = {
  minValidDays: 5,
  minCoverage: 0.8,
  maxWasteRate: 0.15,
  maxMeanDeviation: 0.35,
} as const;

export interface DayCoverage {
  date: string;
  actualSales: number;
  observedHours: number;
  lambdaDay: number;
  intervalLow: number;
  intervalHigh: number;
  covered: boolean;
  deviation: number;
  complete: boolean;
  missingPeriods: string[];
  closedPeriods: string[];
}

export interface CoverageCheck {
  days: DayCoverage[];
  validDays: number;
  consecutiveValidDays: number;
  consecutiveFrom: string | null;
  consecutiveTo: string | null;
  coverage: number;
  meanDeviation: number;
  missingDays: string[];
}

function dstr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function prevDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return dstr(d);
}

/**
 * 按日检查：营业日各时段都有当前观测（漏报则当日无效），
 * 有效日的实际销售是否落在当时强度外推的 90% 预测区间内。
 * 连续有效营业日 = 从最近观测日向前连续无缺报的有效日天数。
 */
export function evaluateCoverage(input: {
  periods: PeriodDef[];
  observations: ObsLine[];
  hourlyRate: number;
}): CoverageCheck {
  const byDate = new Map<string, Map<string, ObsLine>>();
  for (const o of input.observations) {
    if (!byDate.has(o.businessDate)) byDate.set(o.businessDate, new Map());
    byDate.get(o.businessDate)!.set(o.period, o);
  }
  const dates = [...byDate.keys()].sort();
  const days: DayCoverage[] = [];
  for (const date of dates) {
    const map = byDate.get(date)!;
    const missingPeriods: string[] = [];
    const closedPeriods: string[] = [];
    let complete = true;
    let actualSales = 0;
    let observedHours = 0;
    for (const p of input.periods) {
      const o = map.get(p.key);
      if (!o || o.status === 'missing') {
        missingPeriods.push(p.key);
        complete = false;
        continue;
      }
      if (o.status === 'closed') {
        closedPeriods.push(p.key);
        continue;
      }
      if (countsObservation(o.status) && o.inStockHours > 0) {
        actualSales += Math.max(0, o.actualSales);
        observedHours += o.inStockHours;
      }
    }
    const lambdaDay = input.hourlyRate * observedHours;
    const intervalLow = lambdaDay > 0 ? poissonQuantile(lambdaDay, 0.05) : 0;
    const intervalHigh = lambdaDay > 0 ? poissonQuantile(lambdaDay, 0.95) : 0;
    const covered = lambdaDay > 0 && actualSales >= intervalLow && actualSales <= intervalHigh;
    const deviation = lambdaDay > 0 ? Math.abs(actualSales - lambdaDay) / lambdaDay : 0;
    days.push({
      date,
      actualSales: round2(actualSales),
      observedHours: round2(observedHours),
      lambdaDay: round2(lambdaDay),
      intervalLow,
      intervalHigh,
      covered,
      deviation: Number(deviation.toFixed(3)),
      complete,
      missingPeriods,
      closedPeriods,
    });
  }

  const valid = days.filter((d) => d.complete && d.observedHours > 0);
  const missingDays = days.filter((d) => !d.complete).map((d) => d.date);

  // 连续有效营业日：从最近一个观测日往前数
  let consecutive = 0;
  let from: string | null = null;
  let to: string | null = null;
  if (dates.length > 0) {
    const cursor = new Map(days.map((d) => [d.date, d]));
    let cur = dates[dates.length - 1];
    while (cursor.has(cur)) {
      const d = cursor.get(cur)!;
      if (!d.complete || d.observedHours <= 0) break;
      consecutive++;
      to = to ?? cur;
      from = cur;
      cur = prevDate(cur);
    }
  }

  const coverage = valid.length > 0 ? valid.filter((d) => d.covered).length / valid.length : 0;
  const meanDeviation = valid.length > 0 ? valid.reduce((s, d) => s + d.deviation, 0) / valid.length : 1;

  return {
    days,
    validDays: valid.length,
    consecutiveValidDays: consecutive,
    consecutiveFrom: from,
    consecutiveTo: to,
    coverage: Number(coverage.toFixed(3)),
    meanDeviation: Number(meanDeviation.toFixed(3)),
    missingDays,
  };
}

export interface GraduationCheck extends CoverageCheck {
  totalActualSales: number;
  wasteQty: number;
  wasteRate: number;
  rule: typeof GRADUATION_RULES;
  passed: boolean;
  reasons: string[];
}

export function evaluateGraduation(input: {
  periods: PeriodDef[];
  observations: ObsLine[];
  hourlyRate: number;
  wasteQty: number;
}): GraduationCheck {
  const cov = evaluateCoverage(input);
  const totalActualSales = round2(cov.days.reduce((s, d) => s + d.actualSales, 0));
  const wasteQty = Math.max(0, input.wasteQty);
  const wasteRate = totalActualSales + wasteQty > 0 ? wasteQty / (totalActualSales + wasteQty) : 0;
  const rules = GRADUATION_RULES;
  const reasons: string[] = [];
  if (cov.consecutiveValidDays < rules.minValidDays) {
    reasons.push(`连续有效营业日 ${cov.consecutiveValidDays} < ${rules.minValidDays}（缺报/停业不计入观察时长）`);
  }
  if (cov.missingDays.length > 0) {
    reasons.push(`存在漏报营业日 ${cov.missingDays.join('、')}，继续观察`);
  }
  if (cov.coverage < rules.minCoverage) {
    reasons.push(`预测区间覆盖率 ${(cov.coverage * 100).toFixed(1)}% < ${(rules.minCoverage * 100).toFixed(0)}%`);
  }
  if (wasteRate > rules.maxWasteRate) {
    reasons.push(`实际损耗率 ${(wasteRate * 100).toFixed(1)}% > ${(rules.maxWasteRate * 100).toFixed(0)}%`);
  }
  if (cov.meanDeviation > rules.maxMeanDeviation) {
    reasons.push(`平均偏差 ${(cov.meanDeviation * 100).toFixed(1)}% > ${(rules.maxMeanDeviation * 100).toFixed(0)}%，偏差持续过大`);
  }
  return {
    ...cov,
    totalActualSales,
    wasteQty: round2(wasteQty),
    wasteRate: Number(wasteRate.toFixed(3)),
    rule: rules,
    passed: reasons.length === 0,
    reasons,
  };
}
