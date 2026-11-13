import { describe, expect, it } from 'vitest';
import {
  STANDARD_PERIODS,
  computeTrialEstimate,
  evaluateCoverage,
  evaluateGraduation,
  openHoursPerDay,
  periodsFor,
  soldOutHours,
  countsObservation,
  poissonExpectedShortage,
  poissonExpectedWaste,
} from '../src/lib/trialMath';
import { poissonCdf, poissonPmf, poissonQuantile } from '../src/lib/poisson';

describe('泊松计数分布（整日需求分位）', () => {
  it('泊松 PMF/CDF 取值正确', () => {
    expect(poissonPmf(2, 0)).toBeCloseTo(Math.exp(-2), 10);
    expect(poissonPmf(2, 1)).toBeCloseTo(2 * Math.exp(-2), 10);
    expect(poissonCdf(2, 0)).toBeCloseTo(Math.exp(-2), 10);
    expect(poissonCdf(2, 1)).toBeCloseTo(3 * Math.exp(-2), 10);
    expect(poissonCdf(2, 100)).toBeCloseTo(1, 12);
    expect(poissonCdf(2, -1)).toBe(0);
  });

  it('分位是最小整数 k 使 P(X<=k)>=tau（与参考值一致）', () => {
    expect(poissonQuantile(26, 0.8)).toBe(30);
    expect(poissonQuantile(27, 0.8)).toBe(31);
    expect(poissonQuantile(10, 0.5)).toBe(10);
    expect(poissonQuantile(10, 0.9)).toBe(14);
    expect(poissonQuantile(2, 0.8)).toBe(3);
    expect(poissonQuantile(2, 0.5)).toBe(2);
    // 分位定义自证
    for (const [mu, tau] of [[26, 0.8], [3.5, 0.5], [45, 0.9], [0.7, 0.8]] as const) {
      const q = poissonQuantile(mu, tau);
      expect(poissonCdf(mu, q)).toBeGreaterThanOrEqual(tau - 1e-9);
      if (q > 0) expect(poissonCdf(mu, q - 1)).toBeLessThan(tau);
    }
  });

  it('非法分位与零均值', () => {
    expect(() => poissonQuantile(5, 0)).toThrow();
    expect(() => poissonQuantile(5, 1)).toThrow();
    expect(poissonQuantile(0, 0.8)).toBe(0);
  });

  it('缺货/报损期望件数', () => {
    const Q = 30;
    const mu = 26;
    expect(poissonExpectedShortage(mu, Q)).toBeLessThan(1); // 高分位下少量缺货
    expect(poissonExpectedShortage(mu, 0)).toBeCloseTo(mu, 6);
    expect(poissonExpectedWaste(mu, 0)).toBe(0);
    expect(poissonExpectedWaste(mu, Q)).toBeGreaterThan(0);
    // 报损期望的闭式校验：Q·P(X<Q) - E[X;X<Q]
    let cdf = 0;
    let kSum = 0;
    for (let k = 0; k < Q; k++) {
      cdf += poissonPmf(mu, k);
      kSum += k * poissonPmf(mu, k);
    }
    expect(poissonExpectedWaste(mu, Q)).toBeCloseTo(Q * cdf - kSum, 6);
  });

  it('极大均值走正态兜底且不产生负数量', () => {
    expect(poissonQuantile(2_000_000, 0.9)).toBeGreaterThan(2_000_000);
    expect(poissonQuantile(1_500_000, 0.05)).toBeGreaterThan(0);
  });
});

describe('营业时段与有货时长折算', () => {
  it('标准时段共 13 小时；按时段键过滤', () => {
    expect(openHoursPerDay(STANDARD_PERIODS)).toBe(13);
    expect(periodsFor(['morning', 'evening']).map((p) => p.key)).toEqual(['morning', 'evening']);
    expect(periodsFor(undefined)).toHaveLength(3);
  });

  it('售罄时点折算有效有货时长，夹在时段内', () => {
    const morning = STANDARD_PERIODS[0];
    expect(soldOutHours(morning, '10:00')).toBe(2);
    expect(soldOutHours(morning, '07:00')).toBe(0);
    expect(soldOutHours(morning, '12:30')).toBe(4);
    expect(soldOutHours(morning, null)).toBe(0);
  });

  it('只有 operating / sold_out 计入观察；停业/漏报/无货一律不计', () => {
    expect(countsObservation('operating')).toBe(true);
    expect(countsObservation('sold_out')).toBe(true);
    expect(countsObservation('no_stock')).toBe(false);
    expect(countsObservation('closed')).toBe(false);
    expect(countsObservation('missing')).toBe(false);
  });
});

describe('参照与实售合算：泊松整日需求分位 → 订货建议', () => {
  const refLines = [
    { period: 'morning', salesQty: 13, inStockHours: 4 },
    { period: 'midday', salesQty: 17, inStockHours: 5 },
    { period: 'evening', salesQty: 9, inStockHours: 4 },
  ];
  const day1 = [
    { businessDate: '2026-11-10', period: 'morning', status: 'operating' as const, actualSales: 10, inStockHours: 4 },
    { businessDate: '2026-11-10', period: 'midday', status: 'sold_out' as const, actualSales: 11, inStockHours: 3 },
    { businessDate: '2026-11-10', period: 'evening', status: 'no_stock' as const, actualSales: 0, inStockHours: 0 },
  ];

  it('合算强度 = (参照销量 + 实售) / (参照有货小时 + 实有有货小时)', () => {
    const r = computeTrialEstimate({ periods: STANDARD_PERIODS, referenceLines: refLines, observations: day1, cu: 8, co: 2, minOrderUnit: 1 });
    // 参照 39 件 / 13h；实售 21 件 / 7h → 60/20 = 3/h → λ = 39
    expect(r.withRef.salesQty).toBeCloseTo(60);
    expect(r.withRef.inStockHours).toBeCloseTo(20);
    expect(r.withRef.hourlyRate).toBeCloseTo(3);
    expect(r.withRef.lambda).toBeCloseTo(39);
    expect(r.tau).toBeCloseTo(0.8);
    expect(r.withRef.demandQuantile).toBe(poissonQuantile(39, 0.8));
    expect(r.withRef.suggestedQty).toBe(r.withRef.demandQuantile);
  });

  it('售罄时段按有效有货时长计入，售罄后/停业/漏报不按 0 销量也不计时长', () => {
    const withZeroAfterSellout = computeTrialEstimate({
      periods: STANDARD_PERIODS,
      referenceLines: refLines,
      observations: [
        { businessDate: '2026-11-10', period: 'morning', status: 'sold_out', actualSales: 8, inStockHours: 2.5 },
        { businessDate: '2026-11-10', period: 'midday', status: 'no_stock', actualSales: 0, inStockHours: 0 },
        { businessDate: '2026-11-10', period: 'evening', status: 'closed', actualSales: 0, inStockHours: 0 },
      ],
      cu: 8, co: 2, minOrderUnit: 1,
    });
    // 实售只算 8，有货只算 2.5h：若把售罄后当 0 销量，分母不变会让强度被稀释
    expect(withZeroAfterSellout.actual.salesQty).toBe(8);
    expect(withZeroAfterSellout.actual.inStockHours).toBe(2.5);
  });

  it('取消参照的对照：只剩实售，清楚解释少订多少', () => {
    const r = computeTrialEstimate({ periods: STANDARD_PERIODS, referenceLines: refLines, observations: day1, cu: 8, co: 2, minOrderUnit: 1 });
    expect(r.withoutRef.salesQty).toBeCloseTo(21);
    expect(r.withoutRef.inStockHours).toBeCloseTo(7);
    expect(r.withoutRef.lambda).toBeCloseTo(39);
    expect(r.deltaQty).toBe(r.withRef.suggestedQty - r.withoutRef.suggestedQty);
    expect(r.explanation).toContain('少订');
  });

  it('无参照时对照结果与合算一致；无实售时对照为 0，且解释说明', () => {
    const noRef = computeTrialEstimate({ periods: STANDARD_PERIODS, referenceLines: [], observations: day1, cu: 8, co: 2, minOrderUnit: 1 });
    expect(noRef.withRef.suggestedQty).toBe(noRef.withoutRef.suggestedQty);
    const noActual = computeTrialEstimate({ periods: STANDARD_PERIODS, referenceLines: refLines, observations: [], cu: 8, co: 2, minOrderUnit: 1 });
    expect(noActual.withoutRef.suggestedQty).toBe(0);
    expect(noActual.withRef.suggestedQty).toBeGreaterThan(0);
    expect(noActual.deltaQty).toBe(noActual.withRef.suggestedQty);
    expect(noActual.explanation).toContain('尚无新品实售');
  });

  it('新数据随有效观察时长逐渐占优（转变慢），但方向是更快贴近实售', () => {
    const small = computeTrialEstimate({ periods: STANDARD_PERIODS, referenceLines: refLines, observations: day1, cu: 8, co: 2, minOrderUnit: 1 });
    const more = computeTrialEstimate({
      periods: STANDARD_PERIODS,
      referenceLines: refLines,
      observations: [
        ...day1,
        ...Array.from({ length: 6 }, (_, i) => ({
          businessDate: `2026-11-${11 + i}`, period: 'morning', status: 'operating' as const,
          actualSales: 6, inStockHours: 4,
        })),
      ],
      cu: 8, co: 2, minOrderUnit: 1,
    });
    // 实际强度 21+36=57 / 7+24=31 ≈ 1.84，随观察时长增加，实际数据占比上升
    const smallPct = small.actual.inStockHours / (small.actual.inStockHours + small.reference.inStockHours);
    const morePct = more.actual.inStockHours / (more.actual.inStockHours + more.reference.inStockHours);
    expect(morePct).toBeGreaterThan(smallPct);
    expect(more.withRef.hourlyRate).toBeLessThan(small.withRef.hourlyRate);
  });

  it('最小订货单位向上取整（袋装 5 的倍数）', () => {
    const r = computeTrialEstimate({ periods: STANDARD_PERIODS, referenceLines: refLines, observations: day1, cu: 2, co: 2, minOrderUnit: 5 });
    expect(r.withRef.suggestedQty % 5).toBe(0);
    expect(r.withRef.suggestedQty).toBeGreaterThanOrEqual(r.withRef.demandQuantile);
  });
});

describe('转正前的覆盖检查与实际损耗', () => {
  const periods = STANDARD_PERIODS;
  const rate = 3;

  it('漏报营业日使当日无效，连续有效营业日从最近日期往前数', () => {
    const obs = [
      { businessDate: '2026-11-08', period: 'morning', status: 'operating' as const, actualSales: 12, inStockHours: 4 },
      { businessDate: '2026-11-08', period: 'midday', status: 'operating' as const, actualSales: 15, inStockHours: 5 },
      { businessDate: '2026-11-08', period: 'evening', status: 'operating' as const, actualSales: 12, inStockHours: 4 },
      { businessDate: '2026-11-09', period: 'morning', status: 'operating' as const, actualSales: 12, inStockHours: 4 },
      { businessDate: '2026-11-09', period: 'midday', status: 'missing' as const, actualSales: 0, inStockHours: 0 },
      { businessDate: '2026-11-10', period: 'morning', status: 'operating' as const, actualSales: 12, inStockHours: 4 },
      { businessDate: '2026-11-10', period: 'midday', status: 'operating' as const, actualSales: 15, inStockHours: 5 },
      { businessDate: '2026-11-10', period: 'evening', status: 'operating' as const, actualSales: 12, inStockHours: 4 },
    ];
    const c = evaluateCoverage({ periods, observations: obs, hourlyRate: rate });
    expect(c.validDays).toBe(2);
    expect(c.missingDays).toContain('2026-11-09');
    expect(c.consecutiveValidDays).toBe(1);
    expect(c.consecutiveFrom).toBe('2026-11-10');
  });

  it('覆盖率不足/损耗过高 → 不通过并给出原因', () => {
    const obs = Array.from({ length: 5 }, (_, i) => ({
      businessDate: `2026-11-${String(i + 1).padStart(2, '0')}`,
      period: 'morning', status: 'operating' as const, actualSales: i < 2 ? 4 : 30, inStockHours: 4,
    }));
    const g = evaluateGraduation({ periods: [periods[0]], observations: obs, hourlyRate: 3, wasteQty: 40 });
    expect(g.passed).toBe(false);
    expect(g.missingDays).toHaveLength(0);
    expect(g.wasteRate).toBeGreaterThan(0.15);
    expect(g.reasons.join()).toContain('损耗');
  });

  it('连续有效且覆盖达标 → 通过（从最近观测日往前数满 5 天）', () => {
    const obs = Array.from({ length: 6 }, (_, i) =>
      ['morning', 'midday', 'evening'].map((period) => ({
        businessDate: `2026-11-${String(i + 1).padStart(2, '0')}`,
        period, status: 'operating' as const,
        actualSales: period === 'morning' ? 12 : period === 'midday' ? 15 : 10,
        inStockHours: period === 'morning' ? 4 : period === 'midday' ? 5 : 4,
      })),
    ).flat();
    const g = evaluateGraduation({ periods: STANDARD_PERIODS, observations: obs, hourlyRate: 3, wasteQty: 4 });
    expect(g.consecutiveValidDays).toBe(6);
    expect(g.coverage).toBe(1);
    expect(g.passed).toBe(true);
    expect(g.reasons).toHaveLength(0);
  });
});
