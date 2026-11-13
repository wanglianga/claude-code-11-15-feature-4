import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import type { Meta, Review, Stocktake, WasteRecord } from '../types';

interface EntryForm {
  actualSales: string;
  stockoutFlag: '' | 'true' | 'false' | 'null';
  selloutTime: string;
  wasteQty: string;
}

const emptyEntry: EntryForm = { actualSales: '', stockoutFlag: '', selloutTime: '', wasteQty: '0' };

/**
 * 收市复盘：按订单版本归因实销/报损/缺货损失（基准：观测需求）；
 * 当日样本回流需求还原；报损单窗口内结转重算、过窗单独存档；
 * 盘点差异以盘点为准，差异批次从训练样本剔除。
 */
export default function ReviewPage({ meta }: { meta: Meta | null }) {
  const { filters, showToast } = useApp();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [orderId, setOrderId] = useState<number | null>(null);
  const [wasteRecords, setWasteRecords] = useState<WasteRecord[]>([]);
  const [stocktakes, setStocktakes] = useState<Stocktake[]>([]);
  const [forms, setForms] = useState<Record<number, EntryForm>>({});
  const [wasteForm, setWasteForm] = useState({ skuId: '', qty: '' });
  const [stockForm, setStockForm] = useState({ skuId: '', actualQty: '' });

  const storeId = filters.storeId;
  const date = filters.arrivalDate;

  const load = useCallback(async () => {
    if (!storeId) return;
    try {
      const [r, w, st, o] = await Promise.all([
        api<{ reviews: Review[] }>(`/api/reviews?storeId=${storeId}&arrivalDate=${date}`),
        api<{ records: WasteRecord[] }>(`/api/waste-records?storeId=${storeId}&businessDate=${date}`),
        api<{ stocktakes: Stocktake[] }>(`/api/stocktakes?storeId=${storeId}&businessDate=${date}`),
        api<{ orders: { id: number }[] }>(`/api/orders?storeId=${storeId}&arrivalDate=${date}`),
      ]);
      setReviews(r.reviews);
      setWasteRecords(w.records);
      setStocktakes(st.stocktakes);
      setOrderId(o.orders[0]?.id ?? null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败');
    }
  }, [storeId, date]);

  useEffect(() => { load(); }, [load]);

  const formOf = (skuId: number): EntryForm => forms[skuId] ?? emptyEntry;
  const setForm = (skuId: number, patch: Partial<EntryForm>) =>
    setForms((f) => ({ ...f, [skuId]: { ...emptyEntry, ...f[skuId], ...patch } }));

  const createReview = async () => {
    if (!orderId) return;
    await api(`/api/orders/${orderId}/review`, { method: 'POST' }).catch((e) => showToast(e.message));
    await load();
  };

  const submitEntry = async (reviewId: number, skuId: number) => {
    const f = formOf(skuId);
    if (f.actualSales === '') {
      showToast('请填写实销');
      return;
    }
    try {
      await api(`/api/reviews/${reviewId}/entry`, {
        method: 'POST',
        body: {
          skuId,
          actualSales: Number(f.actualSales),
          stockoutFlag: f.stockoutFlag === '' ? null : f.stockoutFlag === 'null' ? null : f.stockoutFlag === 'true',
          selloutTime: f.selloutTime || null,
          wasteQty: Number(f.wasteQty || 0),
        },
      });
      showToast('复盘已录入，当日样本已回流需求还原');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '录入失败');
    }
  };

  const submitWaste = async () => {
    if (!wasteForm.skuId || !wasteForm.qty || !storeId) return;
    try {
      const r = await api<{ disposition: string }>('/api/waste-records', {
        method: 'POST',
        body: { storeId, skuId: Number(wasteForm.skuId), businessDate: date, qty: Number(wasteForm.qty) },
      });
      showToast(r.disposition === 'recalc' ? '窗口内补录：已触发结转重算' : '过窗补录：单独存档，复盘归因保持原样');
      setWasteForm({ skuId: '', qty: '' });
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '报损失败');
    }
  };

  const submitStocktake = async () => {
    if (!stockForm.skuId || stockForm.actualQty === '' || !storeId) return;
    try {
      const r = await api<{ difference: number; excluded: boolean }>('/api/stocktakes', {
        method: 'POST',
        body: { storeId, skuId: Number(stockForm.skuId), businessDate: date, actualQty: Number(stockForm.actualQty) },
      });
      showToast(
        r.difference === 0
          ? '账实相符'
          : `差异 ${r.difference}：以盘点为准，差异批次样本已${r.excluded ? '剔除' : '标记'}`,
      );
      setStockForm({ skuId: '', actualQty: '' });
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '盘点失败');
    }
  };

  const review = reviews[0];
  const skuOptions = meta?.skus ?? [];
  const filteredItems = review?.items.filter(
    (i) => !filters.categoryId || skuOptions.find((s) => s.id === i.sku_id)?.category_id === filters.categoryId,
  );

  return (
    <>
      {!review && (
        <div className="card muted">
          {orderId
            ? <>该到货日订单尚未生成复盘。<button className="primary" onClick={createReview}>生成复盘</button></>
            : '该到货日无已确认订单，请在「建议与订货」页确认订单后再复盘'}
        </div>
      )}

      {review && (
        <div className="card">
          <h3>
            复盘归因 <span className="sub">订单版本 v{review.version_no} · 基准口径：观测需求（restored_demand）· 金额按下单版本标定的 Cu/Co 快照计算</span>
          </h3>
          <table className="grid">
            <thead>
              <tr>
                <th>SKU</th><th className="num">订货</th>
                <th className="num">实销</th><th>断货标记</th><th>售罄时点</th><th className="num">报损</th>
                <th className="num">观测需求</th><th className="num">缺货损失</th><th className="num">报损金额</th>
                <th>样本回流</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filteredItems?.map((i) => {
                const entered = i.actual_sales !== null;
                return (
                  <tr key={i.sku_id}>
                    <td>{i.sku_name}</td>
                    <td className="num">{Number(i.order_qty)}</td>
                    <td className="num">
                      <input
                        type="number" min={0} style={{ width: 70, textAlign: 'right' }}
                        placeholder={entered ? String(Number(i.actual_sales)) : '实销'}
                        value={formOf(i.sku_id).actualSales}
                        onChange={(e) => setForm(i.sku_id, { actualSales: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        value={formOf(i.sku_id).stockoutFlag}
                        onChange={(e) => setForm(i.sku_id, { stockoutFlag: e.target.value as EntryForm['stockoutFlag'] })}
                      >
                        <option value="">（未回传→降级）</option>
                        <option value="false">全天有货</option>
                        <option value="true">发生断货</option>
                        <option value="null">标记缺失</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="time" style={{ width: 96 }}
                        value={formOf(i.sku_id).selloutTime}
                        onChange={(e) => setForm(i.sku_id, { selloutTime: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        type="number" min={0} style={{ width: 60, textAlign: 'right' }}
                        value={formOf(i.sku_id).wasteQty}
                        placeholder={entered ? String(Number(i.waste_qty ?? 0)) : '0'}
                        onChange={(e) => setForm(i.sku_id, { wasteQty: e.target.value })}
                      />
                    </td>
                    <td className="num">{entered ? Number(i.restored_demand).toFixed(1) : '—'}</td>
                    <td className="num">
                      {entered && Number(i.stockout_loss_amount) > 0
                        ? <span className="badge red">{Number(i.stockout_loss_amount).toFixed(0)} 元</span>
                        : '—'}
                    </td>
                    <td className="num">
                      {entered && Number(i.waste_cost) > 0
                        ? <span className="badge amber">{Number(i.waste_cost).toFixed(0)} 元</span>
                        : '—'}
                    </td>
                    <td>
                      {entered
                        ? i.sample_excluded
                          ? <span className="badge red">盘点差异剔除</span>
                          : <span className="badge green">已回流</span>
                        : <span className="muted small">未录入</span>}
                    </td>
                    <td>
                      <button onClick={() => submitEntry(review.id, i.sku_id)}>
                        {entered ? '重录' : '录入'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>报损单 <span className="sub">次日补录：窗口内（次日 12:00 前）触发结转重算；过窗单独存档并注明出处，已锁定建议量保持原样</span></h3>
        <div className="row">
          <select value={wasteForm.skuId} onChange={(e) => setWasteForm({ ...wasteForm, skuId: e.target.value })}>
            <option value="">选择 SKU</option>
            {skuOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input
            type="number" min={0} placeholder="报损量" style={{ width: 90 }}
            value={wasteForm.qty}
            onChange={(e) => setWasteForm({ ...wasteForm, qty: e.target.value })}
          />
          <button className="primary" onClick={submitWaste}>补录报损（{date}）</button>
        </div>
        {wasteRecords.length > 0 && (
          <table className="grid mt8">
            <thead><tr><th>SKU</th><th>营业日</th><th className="num">数量</th><th>录入时间</th><th>处置</th><th>说明</th></tr></thead>
            <tbody>
              {wasteRecords.map((w) => (
                <tr key={w.id}>
                  <td>{w.sku_name}</td><td>{w.business_date}</td>
                  <td className="num">{Number(w.qty)}</td>
                  <td className="small">{new Date(w.recorded_at).toLocaleString('zh-CN')}</td>
                  <td>{w.disposition === 'recalc'
                    ? <span className="badge green">结转重算</span>
                    : <span className="badge amber">过窗存档</span>}</td>
                  <td className="small muted">{w.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>盘点 <span className="sub">库存与盘点对不上以盘点为准并留差异记录；差异批次从训练样本剔除，避免污染需求还原</span></h3>
        <div className="row">
          <select value={stockForm.skuId} onChange={(e) => setStockForm({ ...stockForm, skuId: e.target.value })}>
            <option value="">选择 SKU</option>
            {skuOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input
            type="number" min={0} placeholder="实盘数量" style={{ width: 90 }}
            value={stockForm.actualQty}
            onChange={(e) => setStockForm({ ...stockForm, actualQty: e.target.value })}
          />
          <button className="primary" onClick={submitStocktake}>提交盘点（{date}）</button>
        </div>
        {stocktakes.length > 0 && (
          <table className="grid mt8">
            <thead><tr><th>SKU</th><th>营业日</th><th className="num">系统库存</th><th className="num">实盘</th><th className="num">差异</th><th>处置</th></tr></thead>
            <tbody>
              {stocktakes.map((s) => (
                <tr key={s.id}>
                  <td>{s.sku_name}</td><td>{s.business_date}</td>
                  <td className="num">{Number(s.system_qty)}</td>
                  <td className="num">{Number(s.actual_qty)}</td>
                  <td className="num">{Number(s.difference) === 0 ? '0' : <b>{Number(s.difference)}</b>}</td>
                  <td>{Number(s.difference) === 0
                    ? <span className="badge green">账实相符</span>
                    : <span className="badge red">以盘点为准 · 样本剔除</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
