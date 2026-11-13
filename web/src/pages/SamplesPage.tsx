import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import type { DemandSample, Meta } from '../types';

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 需求还原：截断观测样本。
 * 缺货日实销被货架截断，按有货时段速率外推全天；断货标记缺失只能降级为保守估计；
 * 盘点差异批次从训练样本剔除，避免污染需求还原。
 */
export default function SamplesPage({ meta }: { meta: Meta | null }) {
  const { filters, showToast } = useApp();
  const [samples, setSamples] = useState<DemandSample[]>([]);
  const [loading, setLoading] = useState(false);

  const dateTo = addDays(filters.arrivalDate, -1);
  const dateFrom = addDays(filters.arrivalDate, -7);

  useEffect(() => {
    if (!filters.storeId) return;
    setLoading(true);
    const q = new URLSearchParams({
      storeId: String(filters.storeId),
      dateFrom, dateTo,
      ...(filters.categoryId ? { categoryId: String(filters.categoryId) } : {}),
    });
    api<{ samples: DemandSample[] }>(`/api/samples?${q}`)
      .then((r) => setSamples(r.samples))
      .catch((e) => showToast(e.message))
      .finally(() => setLoading(false));
  }, [filters.storeId, filters.categoryId, filters.arrivalDate]);

  const stats = useMemo(() => ({
    total: samples.length,
    censored: samples.filter((s) => s.is_censored).length,
    degraded: samples.filter((s) => s.degraded).length,
    excluded: samples.filter((s) => s.excluded_from_training).length,
  }), [samples]);

  return (
    <>
      <div className="card">
        <h3>
          截断观测样本
          <span className="sub">
            支撑到货日 {filters.arrivalDate} 预测的近 7 日样本（{dateFrom} ~ {dateTo}）·
            复盘口径：观测需求（还原后），中途不换
          </span>
        </h3>
        <div className="stat">
          <div><b>{stats.total}</b><span>样本数</span></div>
          <div><b>{stats.censored}</b><span>截断观测（售罄外推）</span></div>
          <div><b>{stats.degraded}</b><span>断货标记缺失（降级保守）</span></div>
          <div><b>{stats.excluded}</b><span>盘点差异剔除</span></div>
        </div>
      </div>
      <div className="card">
        {loading && <div className="muted">加载中…</div>}
        {!loading && samples.length === 0 && <div className="muted">该区间暂无样本</div>}
        {samples.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>营业日</th><th>SKU</th><th>品类</th>
                <th className="num">实销</th><th>断货标记</th><th>售罄时点</th>
                <th className="num">有货时长h</th><th className="num">有货速率/h</th>
                <th className="num">还原需求</th><th>样本状态</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s) => (
                <tr key={s.id}>
                  <td>{s.business_date}</td>
                  <td>{s.sku_name}</td>
                  <td>{s.category_name}</td>
                  <td className="num">{Number(s.sales_qty)}</td>
                  <td>
                    {s.stockout_flag === null
                      ? <span className="badge amber">缺失</span>
                      : s.stockout_flag
                        ? <span className="badge red">断货</span>
                        : <span className="badge green">有货</span>}
                  </td>
                  <td>{s.sellout_time ?? '—'}</td>
                  <td className="num">{Number(s.in_stock_hours).toFixed(1)}</td>
                  <td className="num">{Number(s.in_stock_rate).toFixed(2)}</td>
                  <td className="num"><b>{Number(s.restored_demand).toFixed(1)}</b></td>
                  <td>
                    {s.excluded_from_training
                      ? <span className="badge red">已剔除 · {s.exclude_reason}</span>
                      : s.degraded
                        ? <span className="badge amber">降级保守估计</span>
                        : s.is_censored
                          ? <span className="badge blue">截断观测</span>
                          : <span className="badge green">正常</span>}
                    {' '}<span className="muted small">{s.source === 'review_reflow' ? '复盘回流' : '历史'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
