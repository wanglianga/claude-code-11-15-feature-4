import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import TrialPage from '../src/pages/TrialPage';
import type { Meta, TrialDetail, TrialPlanListItem } from '../src/types';

/**
 * 页面挂载测试（happy-dom）：
 * - 页面真实渲染试销明细，建议数量与取消参照对照来自前端本地计算；
 * - 重算尚未完成就切换门店时，迟到结果不覆盖当前门店（竞态保护）。
 */

const meta: Meta = {
  stores: [{ id: 1, code: 'BJ01', name: '朝阳门店', store_type: '社区店', district: '住宅区' },
           { id: 2, code: 'BJ02', name: '海淀店', store_type: '商务区', district: '写字楼' }],
  categories: [{ id: 1, code: 'LEAFY', name: '叶菜', default_cu: '8', default_co: '2' }],
  skus: [
    { id: 1, category_id: 1, code: 'BOC01', name: '菠菜', unit: '份', min_order_unit: '1', price: '6.5', cost: '2.5', spec: '500g装', is_new: false },
    { id: 4, category_id: 1, code: 'XBC04', name: '小白菜', unit: '份', min_order_unit: '1', price: '5', cost: '2', spec: '500g装', is_new: true },
  ],
  costParams: [],
  params: {},
};

const plan: TrialPlanListItem['id'] extends number ? TrialPlanListItem : never = {
  id: 1, store_id: 1, sku_id: 4, arrival_date: '2026-11-10', status: 'selling',
  periods: ['morning', 'midday', 'evening'], store_type: '社区店', district: '住宅区', spec: '500g装',
  stopped_at: null, stop_reason: null, stopped_estimate_id: null, graduated_at: null, graduated_snapshot: null,
  created_by: 'hq', created_at: '2026-11-10T00:00:00Z',
  sku_name: '小白菜', sku_code: 'XBC04', unit: '份', min_order_unit: '1', store_name: '朝阳门店',
  latestEstimate: null, pendingConfirmQty: 0, pendingConfirmCount: 0, pendingAddDecisions: 0,
  stoppedPendingQty: 0, stoppedPendingCount: 0,
} as unknown as TrialPlanListItem;

const detail: TrialDetail = {
  plan: { ...plan, category_name: '叶菜' },
  periods: [
    { key: 'morning', label: '早市', start: '08:00', end: '12:00', hours: 4 },
    { key: 'midday', label: '日市', start: '12:00', end: '17:00', hours: 5 },
    { key: 'evening', label: '晚市', start: '17:00', end: '21:00', hours: 4 },
  ],
  referenceSets: [],
  currentReferenceSet: {
    id: 1, plan_id: 1, revision_no: 1, invalidated: false, invalidated_reason: null,
    created_by: 'hq', created_at: '2026-11-10T00:00:00Z',
    lines: [
      { id: 1, set_id: 1, period: 'morning', ref_sku_id: 1, ref_sales_qty: '13', ref_in_stock_hours: '4', sku_name: '菠菜', sku_code: 'BOC01' },
      { id: 2, set_id: 1, period: 'midday', ref_sku_id: 1, ref_sales_qty: '17', ref_in_stock_hours: '5', sku_name: '菠菜', sku_code: 'BOC01' },
      { id: 3, set_id: 1, period: 'evening', ref_sku_id: 1, ref_sales_qty: '9', ref_in_stock_hours: '4', sku_name: '菠菜', sku_code: 'BOC01' },
    ],
  },
  observations: [
    { id: 1, plan_id: 1, business_date: '2026-11-10', period: 'morning', revision_no: 1, is_current: true, superseded_by: null,
      status: 'operating', actual_sales: '10', in_stock_hours: '4', waste_qty: '0', import_key: null, revision_reason: null, created_by: 's1', created_at: '' },
    { id: 2, plan_id: 1, business_date: '2026-11-10', period: 'midday', revision_no: 1, is_current: true, superseded_by: null,
      status: 'sold_out', actual_sales: '11', in_stock_hours: '3', waste_qty: '0', import_key: null, revision_reason: null, created_by: 's1', created_at: '' },
    { id: 3, plan_id: 1, business_date: '2026-11-10', period: 'evening', revision_no: 1, is_current: true, superseded_by: null,
      status: 'no_stock', actual_sales: '0', in_stock_hours: '0', waste_qty: '0', import_key: null, revision_reason: null, created_by: 's1', created_at: '' },
  ],
  estimates: [],
  currentEstimate: null,
  decisions: [],
  confirmations: [],
  coverage: { days: [], validDays: 0, consecutiveValidDays: 0, consecutiveFrom: null, consecutiveTo: null, coverage: 0, meanDeviation: 1, missingDays: [], totalActualSales: 0, wasteQty: 0, wasteRate: 0, rule: { minValidDays: 5, minCoverage: 0.8, maxWasteRate: 0.15, maxMeanDeviation: 0.35 }, passed: false, reasons: [] },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: JSX.Element) {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => { root!.render(node); });
}

const clickByText = async (needle: string) => {
  const btn = Array.from(container!.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(needle));
  if (!btn) throw new Error(`button not found: ${needle}`);
  await act(async () => { (btn as HTMLButtonElement).click(); });
};

const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

beforeEach(() => {
  // 模拟后端：参照 39 件/13h + 实售 21 件/7h → 60/20 = 3/h → λ=39 → τ=0.8 分位 39
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/api/trials/catalog')
      ? { storeType: '社区店', district: '住宅区', specs: ['500g装'], periods: [], stats: [] }
      : url.includes('/api/trials?')
        ? { plans: [plan] }
        : url.includes('/api/trials/1')
          ? detail
          : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container?.remove();
  container = null;
});

// 页面依赖全局筛选状态（zustand），这里直接设置
import { useApp } from '../src/store';

describe('试销页面', () => {
  it('渲染计划明细，并且合算建议来自前端实时计算', async () => {
    useApp.setState({ filters: { storeId: 1, categoryId: null, arrivalDate: '2026-11-11' } });
    render(<TrialPage meta={meta} />);
    await flush();
    await clickByText('打开');
    await flush();
    const text = container!.textContent ?? '';
    expect(text).toContain('新店新品试销');
    expect(text).toContain('小白菜');
    // 前端本地计算的结果必须出现在页面上（而不是只显示"加载中"）
    expect(text).toMatch(/合算建议（参照\+实售）/);
    // 60 件 / 20h → 3/h → λ 39 → 泊松分位 39（τ=0.8）
    expect(text).toContain('39');
    expect(text).toMatch(/取消参照（只用实售）/);
  });

  it('切换门店后迟到的重算结果不覆盖当前门店', async () => {
    useApp.setState({ filters: { storeId: 1, categoryId: null, arrivalDate: '2026-11-11' } });
    let releaseFirst: (() => void) | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/trials/catalog')) {
        return new Response(JSON.stringify({ storeType: '社区店', district: '住宅区', specs: [], periods: [], stats: [] }), { status: 200 });
      }
      if (url.includes('/api/trials?')) {
        // 海淀店没有试销计划：切换后列表应为空，旧门店明细不得残留
        const store2 = url.includes('storeId=2');
        return new Response(JSON.stringify({
          plans: store2 ? [] : [{ ...plan, store_name: '朝阳门店' }],
        }), { status: 200 });
      }
      if (url.includes('/api/trials/1')) {
        // 第一个门店的明细请求挂起：模拟"重算尚未完成"
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return new Response(JSON.stringify({ ...detail, plan: { ...detail.plan, sku_name: '迟到的旧门店数据' } }), { status: 200 });
      }
      return new Response(JSON.stringify(detail), { status: 200 });
    }) as unknown as typeof fetch;

    render(<TrialPage meta={meta} />);
    await flush();
    // 打开计划 → 明细请求挂起
    await clickByText('打开');
    await flush();

    // 重算未完成时切换到另一门店
    act(() => { useApp.setState({ filters: { storeId: 2, categoryId: null, arrivalDate: '2026-11-11' } }); });
    await flush();

    // 放行迟到的旧门店结果
    await act(async () => { releaseFirst?.(); });
    await flush();

    const text = container!.textContent ?? '';
    expect(text).toContain('该门店暂无试销计划');
    expect(text).not.toContain('迟到的旧门店数据');
    expect(text).not.toContain('合算建议（参照+实售）');
  });
});
