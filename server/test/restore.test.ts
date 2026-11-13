import { describe, expect, it } from 'vitest';
import { restoreDemand } from '../src/lib/restore';

describe('需求还原（截断观测样本）', () => {
  it('全天有货：实销即需求，非截断', () => {
    const r = restoreDemand({ salesQty: 40, openHours: 13, stockoutFlag: false });
    expect(r.restoredDemand).toBe(40);
    expect(r.isCensored).toBe(false);
    expect(r.degraded).toBe(false);
    expect(r.inStockRate).toBeCloseTo(40 / 13);
  });

  it('售罄日：按有货时段速率外推全天（右删失点估计）', () => {
    // 08:00 开店，15:30 售罄 → 有货 7.5h，实销 30 → 速率 4/h → 全天需求 52
    const r = restoreDemand({ salesQty: 30, openHours: 13, stockoutFlag: true, selloutTime: '15:30' });
    expect(r.inStockHours).toBeCloseTo(7.5);
    expect(r.inStockRate).toBeCloseTo(4);
    expect(r.restoredDemand).toBeCloseTo(52);
    expect(r.isCensored).toBe(true);
    expect(r.degraded).toBe(false);
  });

  it('断货标记缺失：降级为保守估计（实销为需求下界，不外推）', () => {
    const r = restoreDemand({ salesQty: 30, openHours: 13, stockoutFlag: null });
    expect(r.restoredDemand).toBe(30);
    expect(r.isCensored).toBe(false);
    expect(r.degraded).toBe(true);
  });

  it('有断货标记但无售罄时点：按全天有货时段保守处理，仍标记截断', () => {
    const r = restoreDemand({ salesQty: 30, openHours: 13, stockoutFlag: true, selloutTime: null });
    expect(r.restoredDemand).toBe(30);
    expect(r.isCensored).toBe(true);
    expect(r.degraded).toBe(false);
  });

  it('售罄时点异常贴近开店：有货时段保底 0.5h 防止除零', () => {
    const r = restoreDemand({ salesQty: 5, openHours: 13, stockoutFlag: true, selloutTime: '08:00' });
    expect(r.inStockHours).toBe(0.5);
    expect(r.restoredDemand).toBeCloseTo((5 / 0.5) * 13);
  });
});
