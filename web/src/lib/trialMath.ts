/**
 * 前端实时复算：与后端同一口径（参照+实售合算 → 泊松整日需求分位 → 向上取整）。
 * 页面每次改动参照/观测都在本地立即重算，再以服务端版本落库；两者口径一致，
 * 任何差异都会在"服务端版本"对照里显示出来。
 */
import { poissonPmf, poissonQuantile } from './poisson';

export type PeriodKey = 'morning' | 'midday' | 'evening';

export interface PeriodDef {
  key: PeriodKey;
  label: string;
  start: string;
  end: string;
  hours: number;
}

export const STANDARD_PERIODS: PeriodDef[] = [
  { key: 'morning', label: '早市', start: '08:00', end: '12:00', hours: 4 },
  { key: 'midday', label: '日市', start: '12:00', end: '17:00', hours: 5 },
  { key: 'evening', label: '晚市', start: '17:00', end: '21:00', hours: 4 },
];

export type ObservationStatus = 'operating' | 'sold_out' | 'no_stock' | 'closed' | 'missing';

export const STATUS_LABEL: Record<ObservationStatus, string> = {
  operating: '正常营业',
  sold_out: '售罄',
  no_stock: '无货（售罄后）',
  closed: '停业',
  missing: '漏报',
};

export function countsObservation(status: ObservationStatus): boolean {
  return status === 'operating' || status === 'sold_out';
}

export function periodsFor(keys: string[] | null | undefined): PeriodDef[] {
  const picked = keys && keys.length > 0 ? keys : STANDARD_PERIODS.map((p) => p.key);
  return STANDARD_PERIODS.filter((p) => picked.includes(p.key));
}

export function openHoursPerDay(periods: PeriodDef[]): number {
  return periods.reduce((s, p) => s + p.hours, 0);
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function soldOutHours(period: PeriodDef, selloutTime: string | null | undefined): number {
  if (!selloutTime) return 0;
  const raw = (minutesOf(selloutTime) - minutesOf(period.start)) / 60;
  return Math.max(0, Math.min(period.hours, Number(raw.toFixed(2))));
}

export function criticalQuantile(cu: number, co: number): number {
  if (!(cu > 0) || !(co > 0)) throw new Error(`非法成本参数 cu=${cu} co=${co}`);
  return cu / (cu + co);
}

export function roundUpToUnit(qty: number, unit: number): number {
  if (!(unit > 0)) return Math.ceil(qty);
  return Math.ceil(qty / unit - 1e-9) * unit;
}

export interface RefLine { period: string; salesQty: number; inStockHours: number }
export interface ObsLine {
  businessDate: string;
  period: string;
  status: ObservationStatus;
  actualSales: number;
  inStockHours: number;
}

export interface DemandBlock {
  salesQty: number;
  inStockHours: number;
  hourlyRate: number;
  lambda: number;
  demandQuantile: number;
  suggestedQty: number;
  intervalLow: number;
  intervalHigh: number;
  expectedShortageUnits: number;
  expectedWasteUnits: number;
  shortageCost: number;
  wasteCost: number;
  expectedTotalCost: number;
}

export interface TrialEstimate {
  openHoursPerDay: number;
  tau: number;
  cu: number;
  co: number;
  minOrderUnit: number;
  actual: { salesQty: number; inStockHours: number; hourlyRate: number; observedDays: number };
  reference: { salesQty: number; inStockHours: number; hourlyRate: number; lineCount: number };
  withRef: DemandBlock;
  withoutRef: DemandBlock;
  deltaQty: number;
  explanation: string;
}

const round2 = (n: number) => Number(n.toFixed(2));

function poissonShortage(mu: number, Q: number): number {
  if (mu <= 0) return 0;
  if (Q <= 0) return mu;
  let kSum = 0;
  let cdf = 0;
  for (let k = 0; k <= Q; k++) {
    const p = poissonPmf(mu, k);
    cdf += p;
    kSum += k * p;
  }
  return Math.max(0, mu - kSum - Q * Math.max(0, 1 - cdf));
}

function poissonWaste(mu: number, Q: number): number {
  if (mu <= 0) return Math.max(0, Q);
  if (Q <= 0) return 0;
  let cdf = 0;
  let kSum = 0;
  for (let k = 0; k < Q; k++) {
    const p = poissonPmf(mu, k);
    cdf += p;
    kSum += k * p;
  }
  return Math.max(0, Q * cdf - kSum);
}

function block(
  salesQty: number, inStockHours: number, openHours: number,
  tau: number, minUnit: number, cu: number, co: number,
): DemandBlock {
  const hourlyRate = inStockHours > 0 ? salesQty / inStockHours : 0;
  const lambda = hourlyRate * openHours;
  const demandQuantile = lambda > 0 ? poissonQuantile(lambda, tau) : 0;
  const suggestedQty = demandQuantile > 0 ? roundUpToUnit(demandQuantile, minUnit) : 0;
  const shortage = poissonShortage(lambda, suggestedQty);
  const waste = poissonWaste(lambda, suggestedQty);
  return {
    salesQty: round2(salesQty),
    inStockHours: round2(inStockHours),
    hourlyRate: round2(hourlyRate),
    lambda: round2(lambda),
    demandQuantile,
    suggestedQty,
    intervalLow: lambda > 0 ? poissonQuantile(lambda, 0.05) : 0,
    intervalHigh: lambda > 0 ? poissonQuantile(lambda, 0.95) : 0,
    expectedShortageUnits: round2(shortage),
    expectedWasteUnits: round2(waste),
    shortageCost: round2(shortage * cu),
    wasteCost: round2(waste * co),
    expectedTotalCost: round2(shortage * cu + waste * co),
  };
}

export function computeTrialEstimate(input: {
  periods: PeriodDef[];
  referenceLines: RefLine[];
  observations: ObsLine[];
  cu: number;
  co: number;
  minOrderUnit: number;
}): TrialEstimate {
  const openHours = openHoursPerDay(input.periods);
  const tau = criticalQuantile(input.cu, input.co);
  const minUnit = input.minOrderUnit > 0 ? input.minOrderUnit : 1;

  let refSales = 0;
  let refHours = 0;
  let refLines = 0;
  for (const r of input.referenceLines) {
    if (!(r.inStockHours > 0) || !(r.salesQty >= 0)) continue;
    refSales += r.salesQty;
    refHours += r.inStockHours;
    refLines += 1;
  }

  let actualSales = 0;
  let actualHours = 0;
  const dates = new Set<string>();
  for (const o of input.observations) {
    if (!countsObservation(o.status)) continue;
    if (!(o.inStockHours > 0)) continue;
    actualSales += Math.max(0, o.actualSales);
    actualHours += o.inStockHours;
    dates.add(o.businessDate);
  }

  const withRef = block(actualSales + refSales, actualHours + refHours, openHours, tau, minUnit, input.cu, input.co);
  const withoutRef = block(actualSales, actualHours, openHours, tau, minUnit, input.cu, input.co);
  const deltaQty = Number((withRef.suggestedQty - withoutRef.suggestedQty).toFixed(2));
  const pct = actualHours + refHours > 0 ? (actualHours / (actualHours + refHours)) * 100 : 0;
  const explanation = actualHours <= 0
    ? `尚无新品实售：取消参照后无可估数据，保守建议 0；合算参照建议 ${withRef.suggestedQty}，差 ${deltaQty}。`
    : `取消参照只剩 ${round2(actualHours)} 个有货小时（占总时长 ${pct.toFixed(1)}%），λ ${withoutRef.lambda} → τ=${tau.toFixed(2)} 分位 ${withoutRef.demandQuantile} → 保守建议 ${withoutRef.suggestedQty}；比合算建议少订 ${deltaQty}。`;

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
      observedDays: dates.size,
    },
    reference: {
      salesQty: round2(refSales),
      inStockHours: round2(refHours),
      hourlyRate: refHours > 0 ? round2(refSales / refHours) : 0,
      lineCount: refLines,
    },
    withRef,
    withoutRef,
    deltaQty,
    explanation,
  };
}

/* ---------------- 转正检查（与后端同一规则） ---------------- */

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

export interface GraduationCheck {
  days: DayCoverage[];
  validDays: number;
  consecutiveValidDays: number;
  consecutiveFrom: string | null;
  consecutiveTo: string | null;
  coverage: number;
  meanDeviation: number;
  missingDays: string[];
  totalActualSales: number;
  wasteQty: number;
  wasteRate: number;
  rule: typeof GRADUATION_RULES;
  passed: boolean;
  reasons: string[];
}

function prevDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function evaluateGraduation(input: {
  periods: PeriodDef[];
  observations: ObsLine[];
  hourlyRate: number;
  wasteQty: number;
}): GraduationCheck {
  const byDate = new Map<string, Map<string, ObsLine>>();
  for (const o of input.observations) {
    if (!byDate.has(o.businessDate)) byDate.set(o.businessDate, new Map());
    byDate.get(o.businessDate)!.set(o.period, o);
  }
  const dates = [...byDate.keys()].sort();
  const days: DayCoverage[] = dates.map((date) => {
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
    return {
      date,
      actualSales: round2(actualSales),
      observedHours: round2(observedHours),
      lambdaDay: round2(lambdaDay),
      intervalLow,
      intervalHigh,
      covered: lambdaDay > 0 && actualSales >= intervalLow && actualSales <= intervalHigh,
      deviation: lambdaDay > 0 ? Number((Math.abs(actualSales - lambdaDay) / lambdaDay).toFixed(3)) : 0,
      complete,
      missingPeriods,
      closedPeriods,
    };
  });

  const valid = days.filter((d) => d.complete && d.observedHours > 0);
  const missingDays = days.filter((d) => !d.complete).map((d) => d.date);

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
  const totalActualSales = round2(days.reduce((s, d) => s + d.actualSales, 0));
  const wasteQty = Math.max(0, input.wasteQty);
  const wasteRate = totalActualSales + wasteQty > 0 ? wasteQty / (totalActualSales + wasteQty) : 0;
  const rules = GRADUATION_RULES;
  const reasons: string[] = [];
  if (consecutive < rules.minValidDays) {
    reasons.push(`连续有效营业日 ${consecutive} < ${rules.minValidDays}（缺报/停业不计入观察时长）`);
  }
  if (missingDays.length > 0) reasons.push(`存在漏报营业日 ${missingDays.join('、')}，继续观察`);
  if (coverage < rules.minCoverage) {
    reasons.push(`预测区间覆盖率 ${(coverage * 100).toFixed(1)}% < ${(rules.minCoverage * 100).toFixed(0)}%`);
  }
  if (wasteRate > rules.maxWasteRate) {
    reasons.push(`实际损耗率 ${(wasteRate * 100).toFixed(1)}% > ${(rules.maxWasteRate * 100).toFixed(0)}%`);
  }
  if (meanDeviation > rules.maxMeanDeviation) {
    reasons.push(`平均偏差 ${(meanDeviation * 100).toFixed(1)}% > ${(rules.maxMeanDeviation * 100).toFixed(0)}%，偏差持续过大`);
  }

  return {
    days,
    validDays: valid.length,
    consecutiveValidDays: consecutive,
    consecutiveFrom: from,
    consecutiveTo: to,
    coverage: Number(coverage.toFixed(3)),
    meanDeviation: Number(meanDeviation.toFixed(3)),
    missingDays,
    totalActualSales,
    wasteQty: round2(wasteQty),
    wasteRate: Number(wasteRate.toFixed(3)),
    rule: rules,
    passed: reasons.length === 0,
    reasons,
  };
}
