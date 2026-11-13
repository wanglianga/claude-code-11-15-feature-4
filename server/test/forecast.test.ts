import { describe, expect, it } from 'vitest';
import {
  combinedFactor,
  criticalQuantile,
  empiricalQuantile,
  roundUpToUnit,
} from '../src/lib/forecast';

describe('临界分位与取整', () => {
  it('临界分位 τ = Cu/(Cu+Co)：叶菜高分位、根茎中位', () => {
    expect(criticalQuantile(8, 2)).toBeCloseTo(0.8); // 叶菜默认
    expect(criticalQuantile(2, 2)).toBeCloseTo(0.5); // 根茎默认
    expect(criticalQuantile(6, 2)).toBeCloseTo(0.75); // 门店覆盖
  });

  it('非法成本参数直接报错（单价比必须标定）', () => {
    expect(() => criticalQuantile(0, 2)).toThrow();
    expect(() => criticalQuantile(8, 0)).toThrow();
  });

  it('经验分位数线性插值', () => {
    const s = [10, 12, 14, 16, 18, 20, 22, 24];
    expect(empiricalQuantile(s, 0.5)).toBeCloseTo(17);
    expect(empiricalQuantile(s, 0.8)).toBeCloseTo(21.2);
    expect(empiricalQuantile([7], 0.8)).toBe(7);
  });

  it('向上取整到最小订货单位', () => {
    expect(roundUpToUnit(21.2, 5)).toBe(25);
    expect(roundUpToUnit(20, 5)).toBe(20); // 恰好整数倍不重复进位
    expect(roundUpToUnit(0.4, 1)).toBe(1);
    expect(roundUpToUnit(41.2, 1)).toBe(42);
  });

  it('特征因子：促销/节假日/降温/竞品/配送延误', () => {
    expect(combinedFactor({}).factor).toBe(1);
    expect(combinedFactor({ promotion: true }).factor).toBeCloseTo(1.25);
    expect(combinedFactor({ tempDrop: true }).factor).toBeCloseTo(0.9);
    // 配送延误 3h：可售时长 13→10，按 10/13 缩放
    expect(combinedFactor({ deliveryDelayHours: 3 }).factor).toBeCloseTo(10 / 13);
    const combo = combinedFactor({ promotion: true, holiday: true });
    expect(combo.factor).toBeCloseTo(1.25 * 1.15);
    expect(combo.applied).toMatchObject({ promotion: 1.25, holiday: 1.15 });
  });
});
