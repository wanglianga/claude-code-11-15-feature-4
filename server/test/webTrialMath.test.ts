import { describe, expect, it } from 'vitest';
import { computeTrialEstimate } from '../src/lib/trialMath';
import { STANDARD_PERIODS } from '../src/lib/trialMath';
import { evaluateGraduation as serverGraduation } from '../src/lib/trialMath';
import * as web from '../../web/src/lib/trialMath';

/**
 * 前端复算必须与后端权威计算同口径：
 * 页面上的建议数量、取消参照对照、转正覆盖检查都由前端本地计算展示，
 * 一旦口径漂移，用户看到的数与落库的数就会对不上。此测试直接跑两份实现对比。
 */

const refs = [
  { period: 'morning', salesQty: 13, inStockHours: 4 },
  { period: 'midday', salesQty: 17, inStockHours: 5 },
  { period: 'evening', salesQty: 9, inStockHours: 4 },
];
const obs = [
  { businessDate: '2026-11-10', period: 'morning', status: 'operating' as const, actualSales: 10, inStockHours: 4 },
  { businessDate: '2026-11-10', period: 'midday', status: 'sold_out' as const, actualSales: 11, inStockHours: 3 },
  { businessDate: '2026-11-10', period: 'evening', status: 'no_stock' as const, actualSales: 0, inStockHours: 0 },
  { businessDate: '2026-11-11', period: 'morning', status: 'operating' as const, actualSales: 9, inStockHours: 4 },
  { businessDate: '2026-11-11', period: 'midday', status: 'operating' as const, actualSales: 12, inStockHours: 5 },
  { businessDate: '2026-11-11', period: 'evening', status: 'closed' as const, actualSales: 0, inStockHours: 0 },
];

describe('前端复算与后端口径一致', () => {
  it('合算建议、取消参照对照、分位与成本期望逐项一致', () => {
    const input = {
      periods: STANDARD_PERIODS, referenceLines: refs, observations: obs, cu: 8, co: 2, minOrderUnit: 1,
    };
    const server = computeTrialEstimate(input as never);
    const client = web.computeTrialEstimate(input as never);

    expect(client.withRef.suggestedQty).toBe(server.withRef.suggestedQty);
    expect(client.withoutRef.suggestedQty).toBe(server.withoutRef.suggestedQty);
    expect(client.withRef.demandQuantile).toBe(server.withRef.demandQuantile);
    expect(client.withRef.lambda).toBeCloseTo(server.withRef.lambda, 6);
    expect(client.withRef.expectedShortageUnits).toBeCloseTo(server.withRef.expectedShortageUnits, 6);
    expect(client.withRef.expectedWasteUnits).toBeCloseTo(server.withRef.expectedWasteUnits, 6);
    expect(client.actual.inStockHours).toBe(server.actual.inStockHours);
    expect(client.deltaQty).toBe(server.deltaQty);
    expect(client.tau).toBe(server.tau);
  });

  it('转正覆盖检查一致（漏报日不计、区间覆盖判定相同）', () => {
    const input = {
      periods: web.STANDARD_PERIODS,
      observations: [
        ...obs,
        { businessDate: '2026-11-12', period: 'morning', status: 'missing' as const, actualSales: 0, inStockHours: 0 },
        { businessDate: '2026-11-12', period: 'midday', status: 'operating' as const, actualSales: 11, inStockHours: 5 },
        { businessDate: '2026-11-12', period: 'evening', status: 'operating' as const, actualSales: 9, inStockHours: 4 },
      ],
      hourlyRate: 2.6,
      wasteQty: 3,
    };
    const server = serverGraduation(input as never);
    const client = web.evaluateGraduation(input as never);
    expect(client.consecutiveValidDays).toBe(server.consecutiveValidDays);
    expect(client.consecutiveFrom).toBe(server.consecutiveFrom);
    expect(client.coverage).toBe(server.coverage);
    expect(client.missingDays).toEqual(server.missingDays);
    expect(client.wasteRate).toBe(server.wasteRate);
    expect(client.passed).toBe(server.passed);
    expect(client.reasons).toEqual(server.reasons);
  });

  it('取整与泊松分位在袋装单位上一致', () => {
    const input = { periods: STANDARD_PERIODS, referenceLines: refs, observations: obs, cu: 2, co: 2, minOrderUnit: 5 };
    const server = computeTrialEstimate(input as never);
    const client = web.computeTrialEstimate(input as never);
    expect(client.withRef.suggestedQty).toBe(server.withRef.suggestedQty);
    expect(client.withRef.suggestedQty % 5).toBe(0);
  });
});
