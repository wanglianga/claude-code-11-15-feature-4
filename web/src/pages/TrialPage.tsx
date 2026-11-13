import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../store';
import {
  computeTrialEstimate,
  evaluateGraduation,
  countsObservation,
  periodsFor,
  STATUS_LABEL,
  type ObservationStatus,
} from '../lib/trialMath';
import type {
  Meta,
  TrialCatalog,
  TrialConfirmation,
  TrialDetail,
  TrialObservation,
  TrialPlanListItem,
  TrialReferenceSet,
} from '../types';
import {
  TRIAL_ACTION,
  TRIAL_DECISION_STATUS,
  TRIAL_ESTIMATE_TRIGGER,
  TRIAL_STATUS,
} from '../types';

function newKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function todayStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const money = (n: number) => `¥${n.toFixed(1)}`;

export default function TrialPage({ meta }: { meta: Meta | null }) {
  const { filters, user, showToast } = useApp();
  const storeId = filters.storeId;
  const [plans, setPlans] = useState<TrialPlanListItem[]>([]);
  const [planId, setPlanId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TrialDetail | null>(null);
  const [catalog, setCatalog] = useState<TrialCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const reqSeq = useRef(0);

  const [createForm, setCreateForm] = useState({ skuId: '', arrivalDate: todayStr() });
  const [refDraft, setRefDraft] = useState<Record<string, { refSkuId: string; hours: string }>>({});
  const [obsForm, setObsForm] = useState({
    businessDate: todayStr(), period: 'morning', status: 'operating' as ObservationStatus,
    actualSales: '', selloutTime: '', inStockHours: '', wasteQty: '0',
  });
  const [addQty, setAddQty] = useState('');
  const [confirmQty, setConfirmQty] = useState('');
  const [stopReason, setStopReason] = useState('');
  const [refSpec, setRefSpec] = useState('');

  const isManager = user?.role === 'manager';

  /* ---------- 载入：每次请求带序号，切换门店后迟到结果直接丢弃 ---------- */
  const loadPlans = useCallback(async () => {
    if (!storeId) return;
    const seq = ++reqSeq.current;
    try {
      const [pl, cat] = await Promise.all([
        api<{ plans: TrialPlanListItem[] }>(`/api/trials?storeId=${storeId}`),
        api<TrialCatalog>(`/api/trials/catalog?storeId=${storeId}`),
      ]);
      if (seq !== reqSeq.current) return; // 迟到的旧门店结果不覆盖当前门店
      setPlans(pl.plans);
      setCatalog(cat);
    } catch (e) {
      if (seq === reqSeq.current) showToast(e instanceof Error ? e.message : '加载失败');
    }
  }, [storeId]);

  const loadDetail = useCallback(
    async (id: number) => {
      const seq = ++reqSeq.current;
      try {
        const d = await api<TrialDetail>(`/api/trials/${id}`);
        if (seq !== reqSeq.current) return; // 重算尚未完成又切店 → 丢弃迟到结果
        setDetail(d);
        const init: Record<string, { refSkuId: string; hours: string }> = {};
        const cur = d.currentReferenceSet;
        for (const p of d.periods) {
          const line = cur?.lines.find((l) => l.period === p.key);
          init[p.key] = { refSkuId: line ? String(line.ref_sku_id) : '', hours: line ? String(Number(line.ref_in_stock_hours)) : '' };
        }
        setRefDraft(init);
        setRefSpec(d.plan.spec);
        setConfirmQty(String(d.currentEstimate?.computed.withRef.suggestedQty ?? ''));
      } catch (e) {
        if (seq === reqSeq.current) showToast(e instanceof Error ? e.message : '加载失败');
      }
    },
    [],
  );

  useEffect(() => {
    setPlanId(null);
    setDetail(null);
    setPlans([]);
    setCatalog(null);
    loadPlans();
  }, [storeId, loadPlans]);

  useEffect(() => {
    // 门店切换时计划列表变化，若当前计划不属于该门店则清空
    if (planId && !plans.some((p) => p.id === planId)) setPlanId(null);
  }, [plans, planId]);

  useEffect(() => {
    if (planId) loadDetail(planId);
  }, [planId, loadDetail]);

  const reload = useCallback(async () => {
    await loadPlans();
    if (planId) await loadDetail(planId);
  }, [loadPlans, loadDetail, planId]);

  /* ---------- 前端实时复算（与后端同口径） ---------- */
  const sku = detail ? meta?.skus.find((s) => s.id === detail.plan.sku_id) : null;
  const costParams = useMemo(() => {
    if (!detail || !sku || !meta) return { cu: 0, co: 0 };
    const over = meta.costParams.find((c) => c.store_id === detail.plan.store_id && c.category_id === sku.category_id);
    const cat = meta.categories.find((c) => c.id === sku.category_id);
    return {
      cu: Number(over?.cu ?? cat?.default_cu ?? 0),
      co: Number(over?.co ?? cat?.default_co ?? 0),
    };
  }, [detail, sku, meta]);

  const currentObs = useMemo(() => (detail?.observations ?? []).filter((o) => o.is_current), [detail]);

  const refLinesForMath = useMemo(() => {
    if (!detail) return [];
    const set: TrialReferenceSet | null = detail.currentReferenceSet;
    if (!set || set.invalidated) return [];
    return set.lines.map((l) => ({
      period: l.period,
      salesQty: Number(l.ref_sales_qty),
      inStockHours: Number(l.ref_in_stock_hours),
    }));
  }, [detail]);

  const liveEstimate = useMemo(() => {
    if (!detail) return null;
    const periods = periodsFor(detail.plan.periods);
    return computeTrialEstimate({
      periods,
      referenceLines: refLinesForMath,
      observations: currentObs.map((o) => ({
        businessDate: o.business_date,
        period: o.period,
        status: o.status,
        actualSales: Number(o.actual_sales),
        inStockHours: Number(o.in_stock_hours),
      })),
      cu: costParams.cu,
      co: costParams.co,
      minOrderUnit: Number(detail.plan.min_order_unit || 1),
    });
  }, [detail, refLinesForMath, currentObs, costParams]);

  const liveCoverage = useMemo(() => {
    if (!detail || !liveEstimate) return null;
    const waste = currentObs.reduce((s, o) => s + Number(o.waste_qty), 0);
    return evaluateGraduation({
      periods: periodsFor(detail.plan.periods),
      observations: currentObs.map((o) => ({
        businessDate: o.business_date,
        period: o.period,
        status: o.status,
        actualSales: Number(o.actual_sales),
        inStockHours: Number(o.in_stock_hours),
      })),
      hourlyRate: liveEstimate.withRef.hourlyRate,
      wasteQty: waste,
    });
  }, [detail, liveEstimate, currentObs]);

  /* ---------- 参照草稿预览（未保存也能看到等价小时与差异） ---------- */
  const specForDraft = refSpec || detail?.plan.spec || '';
  const draftRefLines = useMemo(() => {
    if (!detail || !catalog) return [];
    const out: { period: string; salesQty: number; inStockHours: number; refName: string }[] = [];
    for (const p of periodsFor(detail.plan.periods)) {
      const draft = refDraft[p.key];
      if (!draft?.refSkuId) continue;
      const stat = catalog.stats.find(
        (s) => s.ref_sku_id === Number(draft.refSkuId) && s.period === p.key && s.spec === specForDraft,
      );
      if (!stat) continue;
      out.push({
        period: p.key,
        salesQty: Number(stat.ref_sales_qty),
        inStockHours: draft.hours !== '' ? Number(draft.hours) : Number(stat.ref_in_stock_hours),
        refName: stat.sku_name,
      });
    }
    return out;
  }, [detail, catalog, refDraft, specForDraft]);

  const draftEstimate = useMemo(() => {
    if (!detail) return null;
    return computeTrialEstimate({
      periods: periodsFor(detail.plan.periods),
      referenceLines: draftRefLines.map((l) => ({ period: l.period, salesQty: l.salesQty, inStockHours: l.inStockHours })),
      observations: currentObs.map((o) => ({
        businessDate: o.business_date, period: o.period, status: o.status,
        actualSales: Number(o.actual_sales), inStockHours: Number(o.in_stock_hours),
      })),
      cu: costParams.cu,
      co: costParams.co,
      minOrderUnit: Number(detail.plan.min_order_unit || 1),
    });
  }, [detail, draftRefLines, currentObs, costParams]);

  /* ---------- 操作 ---------- */
  const createPlan = async () => {
    if (!storeId || !createForm.skuId) {
      showToast('请选择新品与首批到货日');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ planId: number; idempotent: boolean }>('/api/trials', {
        method: 'POST',
        body: { storeId, skuId: Number(createForm.skuId), arrivalDate: createForm.arrivalDate },
      });
      showToast(r.idempotent ? '该店该 SKU 到货日已有计划，已打开' : '试销计划已创建');
      await loadPlans();
      setPlanId(r.planId);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const saveReferences = async () => {
    if (!detail) return;
    const lines = periodsFor(detail.plan.periods)
      .filter((p) => refDraft[p.key]?.refSkuId)
      .map((p) => ({
        period: p.key,
        refSkuId: Number(refDraft[p.key].refSkuId),
        hours: refDraft[p.key].hours === '' ? undefined : Number(refDraft[p.key].hours),
      }));
    if (lines.length === 0) {
      showToast('请至少为一个时段选择参照商品');
      return;
    }
    setBusy(true);
    try {
      const r = await api(`/api/trials/${detail.plan.id}/references`, {
        method: 'POST',
        body: { lines, idempotencyKey: newKey('ref') },
      });
      showToast(`参照已保存（修订 r${(r as { revisionNo: number }).revisionNo}），估计已重算`);
      await reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const invalidateRefs = async () => {
    if (!detail) return;
    const reason = window.prompt('参照失效原因（例：参照商品改版下架）', '参照商品改版下架');
    if (!reason) return;
    setBusy(true);
    try {
      const r = await api<{ recomputed: boolean; retainedConfirmations: number }>(
        `/api/trials/${detail.plan.id}/references/invalidate`,
        { method: 'POST', body: { reason } },
      );
      showToast(
        r.recomputed
          ? '参照已失效：未确认计划已按实售重估，对照结果已更新'
          : `参照已失效：已有 ${r.retainedConfirmations} 条确认记录，不再重估，确认快照原样保留`,
      );
      await reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const submitObservation = async () => {
    if (!detail) return;
    if (obsForm.actualSales === '') {
      showToast('请填写实销');
      return;
    }
    const body: Record<string, unknown> = {
      businessDate: obsForm.businessDate,
      period: obsForm.period,
      status: obsForm.status,
      actualSales: Number(obsForm.actualSales),
      wasteQty: Number(obsForm.wasteQty || 0),
    };
    if (obsForm.status === 'sold_out') body.selloutTime = obsForm.selloutTime || null;
    if (obsForm.status === 'operating' && obsForm.inStockHours !== '') body.inStockHours = Number(obsForm.inStockHours);
    setBusy(true);
    try {
      const r = await api<{ idempotent: boolean; superseded: boolean; revisionNo: number }>(
        `/api/trials/${detail.plan.id}/observations`,
        { method: 'POST', body },
      );
      showToast(
        r.idempotent
          ? '相同观测已存在，重复导入不重复累加'
          : r.superseded
            ? `观测修订至 r${r.revisionNo}：旧修订贡献已撤掉，按新值计入`
            : `观测已录入（r${r.revisionNo}）`,
      );
      setObsForm({ ...obsForm, actualSales: '', selloutTime: '', inStockHours: '' });
      await reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '录入失败');
    } finally {
      setBusy(false);
    }
  };

  const deleteObservation = async (obsId: number) => {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/trials/${detail.plan.id}/observations/${obsId}`, { method: 'DELETE' });
      showToast('当前观测已撤掉，估计已重算');
      await reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (action: 'add' | 'observe' | 'stop') => {
    if (!detail) return;
    const body: Record<string, unknown> = { action, idempotencyKey: newKey('dec') };
    if (action === 'add') {
      const q = Number(addQty);
      if (!(q > 0)) {
        showToast('请填写加订数量');
        return;
      }
      body.batchQty = q;
      body.note = '按当前估计加订';
      body.estimateId = detail.currentEstimate?.id ?? null;
    }
    if (action === 'stop') {
      if (!stopReason.trim()) {
        showToast('请填写停止原因');
        return;
      }
      body.note = stopReason.trim();
    }
    setBusy(true);
    try {
      const r = await api<{ status: string }>(`/api/trials/${detail.plan.id}/decisions`, { method: 'POST', body });
      showToast(
        action === 'stop'
          ? '已停止试销：未确认加订作废，已确认数量转入待处理'
          : action === 'add'
            ? '加订决策待店长确认'
            : '已记继续观察',
      );
      void r;
      setAddQty('');
      setStopReason('');
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        showToast(`冲突：${e.message}`);
        await reload();
      } else {
        showToast(e instanceof Error ? e.message : '决策失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmOrder = async (kind: 'initial' | 'add') => {
    if (!detail) return;
    const q = Number(confirmQty);
    if (!Number.isFinite(q) || q < 0) {
      showToast('确认数量非法');
      return;
    }
    const pendingAdd = detail.decisions.find((d) => d.status === 'pending_confirm');
    if (kind === 'add' && !pendingAdd) {
      showToast('没有待确认的加订决策');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/trials/${detail.plan.id}/confirmations`, {
        method: 'POST',
        body: { kind, qty: q, decisionId: kind === 'add' ? pendingAdd?.id : null, idempotencyKey: newKey('conf') },
      });
      showToast('订货记录已确认；确认时的估计快照已冻结保留');
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const details = e.details as { pendingConfirmations?: { qty: string }[] } | null;
        const pend = details?.pendingConfirmations;
        showToast(`冲突：${e.message}${pend?.length ? `（已确认 ${pend.length} 笔转入待处理）` : ''}`);
        await reload();
      } else {
        showToast(e instanceof Error ? e.message : '确认失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const graduate = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await api<{ graduated: boolean; reasons: string[] }>(`/api/trials/${detail.plan.id}/graduate`, {
        method: 'POST',
      });
      if (r.graduated) showToast('已转入正式预测：参照、观测、决定与覆盖检查已冻结留存');
      else showToast(`暂不转正：${r.reasons.join('；')}`);
      await reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '转正失败');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 渲染 ---------- */
  const newSkus = useMemo(
    () => (meta?.skus ?? []).filter((s) => s.is_new || !plans.some((p) => p.sku_id === s.id)),
    [meta, plans],
  );
  const planList = plans.filter((p) => !filters.categoryId || meta?.skus.find((s) => s.id === p.sku_id)?.category_id === filters.categoryId);
  const est = liveEstimate;
  const cov = liveCoverage;
  const stoppedPending = detail?.confirmations.filter((c) => c.status === 'stopped_pending') ?? [];
  const active = detail?.plan.status === 'selling';

  return (
    <>
      <div className="card">
        <h3>
          新店新品试销 <span className="sub">无销售历史时先定首批量；每日按售出情况判断加订 / 继续观察 / 停止试销</span>
        </h3>
        <div className="row">
          <label className="muted">新品
            <select value={createForm.skuId} onChange={(e) => setCreateForm({ ...createForm, skuId: e.target.value })}>
              <option value="">选择 SKU</option>
              {newSkus.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.spec ?? '规格'}·{s.is_new ? '新品' : '无计划'}）
                </option>
              ))}
            </select>
          </label>
          <label className="muted">首批到货日
            <input type="date" value={createForm.arrivalDate} onChange={(e) => setCreateForm({ ...createForm, arrivalDate: e.target.value })} />
          </label>
          <button className="primary" disabled={busy || !storeId} onClick={createPlan}>创建试销计划</button>
          <span className="muted small">
            店型 {catalog?.storeType ?? '—'} · 商圈 {catalog?.district ?? '—'} · 参照目录按规格与营业时段匹配
          </span>
        </div>
      </div>

      <div className="card">
        <h3>试销计划 <span className="sub">参照设定 / 每日观测 / 试销决策分别保存；确认记录永久保留</span></h3>
        {planList.length === 0 && <div className="muted">该门店暂无试销计划</div>}
        {planList.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>新品</th><th>到货日</th><th>状态</th>
                <th className="num">合算建议</th><th className="num">取消参照对照</th>
                <th className="num">待确认加订</th><th className="num">已确认待处理</th><th></th>
              </tr>
            </thead>
            <tbody>
              {planList.map((p) => {
                const e = p.latestEstimate?.computed;
                return (
                  <tr key={p.id} style={p.id === planId ? { background: '#f0f8f3' } : undefined}>
                    <td>{p.sku_name} <span className="muted small">{p.spec}</span></td>
                    <td>{p.arrival_date}</td>
                    <td>
                      <span className={`badge ${p.status === 'selling' ? 'green' : p.status === 'stopped' ? 'amber' : 'blue'}`}>
                        {TRIAL_STATUS[p.status]}
                      </span>
                    </td>
                    <td className="num"><b>{e ? e.withRef.suggestedQty : '—'}</b></td>
                    <td className="num muted">
                      {e ? `${e.withoutRef.suggestedQty}（${e.deltaQty >= 0 ? '少订' : '多订'} ${Math.abs(e.deltaQty)}）` : '—'}
                    </td>
                    <td className="num">{p.pendingAddDecisions > 0 ? <span className="badge blue">{p.pendingAddDecisions}</span> : '—'}</td>
                    <td className="num">{p.stoppedPendingCount > 0 ? <span className="badge red">{p.stoppedPendingQty}</span> : '—'}</td>
                    <td><button onClick={() => setPlanId(p.id)}>{p.id === planId ? '已打开' : '打开'}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <>
          <div className="card">
            <h3>
              {detail.plan.sku_name} · {detail.plan.store_name} 试销
              <span className="sub">
                首批到货 {detail.plan.arrival_date} · {detail.plan.store_type}/{detail.plan.district}/{detail.plan.spec} ·
                τ={est?.tau.toFixed(2)}（Cu={costParams.cu}/Co={costParams.co}）· 最小订货单位 {Number(detail.plan.min_order_unit)}
              </span>
              <span className={`badge ${detail.plan.status === 'selling' ? 'green' : detail.plan.status === 'stopped' ? 'amber' : 'blue'}`}>
                {TRIAL_STATUS[detail.plan.status]}
              </span>
            </h3>
            {detail.plan.status === 'stopped' && (
              <div className="badge amber mb8">已停止试销：{detail.plan.stop_reason}（停止当时的参照/观测/决定已冻结）</div>
            )}
            {detail.plan.status === 'graduated' && (
              <div className="badge blue mb8">已转入正式预测：转正时的参照、观测、决定与覆盖检查已冻结留存</div>
            )}
            {est && (
              <div className="stat mb8">
                <div><b>{est.withRef.suggestedQty}</b><span>合算建议（参照+实售）</span></div>
                <div><b>{est.withoutRef.suggestedQty}</b><span>取消参照（只用实售）</span></div>
                <div><b>{Math.abs(est.deltaQty)}</b><span>{est.deltaQty >= 0 ? '取消参照少订' : '取消参照多订'}</span></div>
                <div><b>{est.withRef.lambda.toFixed(1)}</b><span>整日需求均值 λ</span></div>
                <div><b>{est.withRef.demandQuantile}</b><span>泊松分位（τ）</span></div>
                <div><b>{money(est.withRef.shortageCost)} / {money(est.withRef.wasteCost)}</b><span>缺货损失 / 报损成本期望</span></div>
              </div>
            )}
            <div className="kv">
              <span>合算：{est?.withRef.salesQty} 件 / {est?.withRef.inStockHours} 有货小时 → {est?.withRef.hourlyRate}/h</span>
              <span>实售：{est?.actual.salesQty} 件 / {est?.actual.inStockHours}h（{est?.actual.observedDays} 个交易日）</span>
              <span>参照：{est?.reference.salesQty} 件 / {est?.reference.inStockHours}h（{est?.reference.lineCount} 段）</span>
              <span>区间 90%：{est?.withRef.intervalLow} ~ {est?.withRef.intervalHigh}</span>
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>{est?.explanation}</p>
          </div>

          <div className="card">
            <h3>
              参照设定 <span className="sub">按店型/商圈/规格/营业时段选参照商品；每个时段设定"参照数据相当于多少个有货小时"</span>
            </h3>
            <div className="row mb8">
              <label className="muted">参照规格
                <select value={specForDraft} onChange={(e) => { setRefSpec(e.target.value); setRefDraft({}); }} disabled={!active}>
                  {(catalog?.specs ?? []).map((sp) => <option key={sp} value={sp}>{sp}</option>)}
                </select>
              </label>
              <span className="muted small">
                店型 {detail.plan.store_type} · 商圈 {detail.plan.district} · 新品规格 {detail.plan.spec}
                {specForDraft !== detail.plan.spec && ' · 当前选了不同规格的参照（跨规格需自行改等价小时）'}
              </span>
            </div>
            <table className="grid">
              <thead>
                <tr>
                  <th>营业时段</th><th>参考商品</th><th className="num">参照销量</th>
                  <th className="num">等价有货小时</th><th className="num">对照小时强度</th><th>状态</th>
                </tr>
              </thead>
              <tbody>
                {periodsFor(detail.plan.periods).map((p) => {
                  const draft = refDraft[p.key] ?? { refSkuId: '', hours: '' };
                  const options = catalog?.stats.filter((s) => s.period === p.key && s.spec === specForDraft) ?? [];
                  const stat = options.find((s) => s.ref_sku_id === Number(draft.refSkuId));
                  return (
                    <tr key={p.key}>
                      <td>{p.label} <span className="muted small">{p.start}-{p.end}（{p.hours}h）</span></td>
                      <td>
                        <select
                          value={draft.refSkuId}
                          disabled={!active}
                          onChange={(e) => {
                            const st = options.find((s) => s.ref_sku_id === Number(e.target.value));
                            setRefDraft({
                              ...refDraft,
                              [p.key]: { refSkuId: e.target.value, hours: st ? String(Number(st.ref_in_stock_hours)) : '' },
                            });
                          }}
                        >
                          <option value="">不设参照</option>
                          {options.map((s) => (
                            <option key={s.id} value={s.ref_sku_id}>{s.sku_name}（{s.spec}）</option>
                          ))}
                        </select>
                      </td>
                      <td className="num">{stat ? Number(stat.ref_sales_qty) : '—'}</td>
                      <td className="num">
                        <input
                          type="number" min={0} step={0.5} style={{ width: 80, textAlign: 'right' }}
                          disabled={!active || !draft.refSkuId}
                          value={draft.hours}
                          onChange={(e) => setRefDraft({ ...refDraft, [p.key]: { ...draft, hours: e.target.value } })}
                        />
                      </td>
                      <td className="num muted">
                        {stat && Number(draft.hours) > 0 ? (Number(stat.ref_sales_qty) / Number(draft.hours)).toFixed(2) : '—'}
                      </td>
                      <td>
                        {currentObs.filter((o) => o.period === p.key && countsObservation(o.status)).length > 0
                          ? <span className="badge green">已有实售观测</span>
                          : <span className="muted small">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="row mt8">
              <button className="primary" disabled={busy || !active} onClick={saveReferences}>保存参照设定（新修订）</button>
              <button className="danger" disabled={busy || !active || !detail.currentReferenceSet || detail.currentReferenceSet.invalidated} onClick={invalidateRefs}>
                判定参照失效
              </button>
              {draftEstimate && (
                <span className="muted small">
                  草稿预览：合算建议 {draftEstimate.withRef.suggestedQty} · 取消参照 {draftEstimate.withoutRef.suggestedQty}（{draftEstimate.deltaQty >= 0 ? '少订' : '多订'} {Math.abs(draftEstimate.deltaQty)}）
                </span>
              )}
            </div>
            {detail.referenceSets.length > 0 && (
              <div className="mt8 small muted">
                参照版本：
                {detail.referenceSets.map((s) => (
                  <span key={s.id} style={{ marginRight: 10 }}>
                    r{s.revision_no}{s.invalidated ? '（已失效）' : ''} · {s.created_by} · {new Date(s.created_at).toLocaleString('zh-CN')}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3>
              每日观测 <span className="sub">修订号管理：后补有货时长会撤掉旧观测贡献再计入新值；重复导入不重复累加；售罄后/停业/漏报不计观察时长</span>
            </h3>
            <div className="row">
              <label className="muted">营业日
                <input type="date" value={obsForm.businessDate} onChange={(e) => setObsForm({ ...obsForm, businessDate: e.target.value })} />
              </label>
              <label className="muted">时段
                <select value={obsForm.period} onChange={(e) => setObsForm({ ...obsForm, period: e.target.value })}>
                  {periodsFor(detail.plan.periods).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </label>
              <label className="muted">状态
                <select value={obsForm.status} onChange={(e) => setObsForm({ ...obsForm, status: e.target.value as ObservationStatus })}>
                  {(Object.keys(STATUS_LABEL) as ObservationStatus[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
                </select>
              </label>
              <label className="muted">实销
                <input type="number" min={0} style={{ width: 80 }} value={obsForm.actualSales}
                  onChange={(e) => setObsForm({ ...obsForm, actualSales: e.target.value })} />
              </label>
              {obsForm.status === 'sold_out' && (
                <label className="muted">售罄时点
                  <input type="time" value={obsForm.selloutTime} onChange={(e) => setObsForm({ ...obsForm, selloutTime: e.target.value })} />
                </label>
              )}
              {obsForm.status === 'operating' && (
                <label className="muted">有货小时（留空=整段）
                  <input type="number" min={0} step={0.5} style={{ width: 80 }} value={obsForm.inStockHours}
                    onChange={(e) => setObsForm({ ...obsForm, inStockHours: e.target.value })} />
                </label>
              )}
              <label className="muted">报损
                <input type="number" min={0} style={{ width: 70 }} value={obsForm.wasteQty}
                  onChange={(e) => setObsForm({ ...obsForm, wasteQty: e.target.value })} />
              </label>
              <button className="primary" disabled={busy || !active} onClick={submitObservation}>录入 / 修订观测</button>
            </div>

            <table className="grid mt8">
              <thead>
                <tr>
                  <th>营业日</th><th>时段</th><th>状态</th><th className="num">实销</th>
                  <th className="num">有货小时</th><th className="num">报损</th><th className="num">修订</th><th>说明</th><th></th>
                </tr>
              </thead>
              <tbody>
                {currentObs.length === 0 && (
                  <tr><td colSpan={9} className="muted">尚无观测</td></tr>
                )}
                {currentObs
                  .slice()
                  .sort((a, b) => (a.business_date === b.business_date ? a.period.localeCompare(b.period) : b.business_date.localeCompare(a.business_date)))
                  .map((o: TrialObservation) => {
                    const p = periodsFor(detail.plan.periods).find((x) => x.key === o.period);
                    // 有效有货时长以服务端折算值为准（售罄时点已换算成小时）
                    const effectiveHours = Number(o.in_stock_hours);
                    return (
                      <tr key={o.id}>
                        <td>{o.business_date}</td>
                        <td>{p?.label ?? o.period}</td>
                        <td>
                          <span className={`badge ${o.status === 'sold_out' ? 'amber' : o.status === 'operating' ? 'green' : 'red'}`}>
                            {STATUS_LABEL[o.status]}
                          </span>
                        </td>
                        <td className="num">{Number(o.actual_sales)}</td>
                        <td className="num">{effectiveHours}</td>
                        <td className="num">{Number(o.waste_qty)}</td>
                        <td className="num">r{o.revision_no}</td>
                        <td className="small muted">{o.revision_reason ?? ''}</td>
                        <td>
                          {active && <button className="danger" disabled={busy} onClick={() => deleteObservation(o.id)}>撤销</button>}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {detail.observations.some((o) => !o.is_current) && (
              <details className="mt8 small muted">
                <summary>历史修订（已撤掉贡献）</summary>
                {detail.observations.filter((o) => !o.is_current).map((o) => (
                  <div key={o.id}>
                    {o.business_date} {o.period} r{o.revision_no} · 实销 {Number(o.actual_sales)} · 有货 {Number(o.in_stock_hours)}h
                    {o.superseded_by ? ` → 被 #${o.superseded_by} 取代` : ''}
                  </div>
                ))}
              </details>
            )}
          </div>

          <div className="card">
            <h3>试销决策 <span className="sub">加订 / 继续观察 / 停止试销分别保存；停止与追加确认冲突时拒绝旧计划</span></h3>
            <div className="row">
              <label className="muted">加订数量
                <input type="number" min={1} style={{ width: 90 }} value={addQty} onChange={(e) => setAddQty(e.target.value)} />
              </label>
              <button disabled={busy || !active} onClick={() => decide('add')}>提交加订（待确认）</button>
              <button disabled={busy || !active} onClick={() => decide('observe')}>继续观察</button>
              <label className="muted">停止原因
                <input style={{ width: 220 }} value={stopReason} onChange={(e) => setStopReason(e.target.value)} placeholder="例：损耗过高" />
              </label>
              <button className="danger" disabled={busy || !active} onClick={() => decide('stop')}>停止试销</button>
            </div>
            <table className="grid mt8">
              <thead>
                <tr><th>时间</th><th>动作</th><th className="num">建议量</th><th className="num">本批数量</th><th>状态</th><th>备注</th><th>操作人</th></tr>
              </thead>
              <tbody>
                {detail.decisions.length === 0 && <tr><td colSpan={7} className="muted">尚无决策</td></tr>}
                {detail.decisions.map((d) => (
                  <tr key={d.id}>
                    <td className="small">{new Date(d.created_at).toLocaleString('zh-CN')}</td>
                    <td>{TRIAL_ACTION[d.action]}</td>
                    <td className="num">{Number(d.suggested_qty)}</td>
                    <td className="num">{Number(d.batch_qty) || '—'}</td>
                    <td>
                      <span className={`badge ${d.status === 'pending_confirm' ? 'blue' : d.status === 'rejected_stale' ? 'red' : 'green'}`}>
                        {TRIAL_DECISION_STATUS[d.status]}
                      </span>
                    </td>
                    <td className="small muted">{d.note ?? ''}</td>
                    <td className="small">{d.created_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>店长确认与订货记录 <span className="sub">确认时冻结估计快照；此后参照失效或观测修订都不改写确认记录</span></h3>
            <div className="row">
              <label className="muted">确认数量
                <input type="number" min={0} style={{ width: 90 }} value={confirmQty} onChange={(e) => setConfirmQty(e.target.value)} />
              </label>
              <button className="primary" disabled={busy || !isManager || !active} onClick={() => confirmOrder('initial')}>
                确认首批订货
              </button>
              <button disabled={busy || !isManager || !active || !detail.decisions.some((d) => d.status === 'pending_confirm')} onClick={() => confirmOrder('add')}>
                确认待处理加订
              </button>
              {!isManager && <span className="muted small">确认操作需门店账号</span>}
            </div>

            {stoppedPending.length > 0 && (
              <div className="mt8">
                <span className="badge red">已确认但待处理（停止试销后原样保留）</span>
                {stoppedPending.map((c: TrialConfirmation) => (
                  <div key={c.id} className="small" style={{ marginTop: 4 }}>
                    {c.kind === 'initial' ? '首批' : '加订'} × {Number(c.qty)} · {c.confirmed_by} · {new Date(c.confirmed_at).toLocaleString('zh-CN')}
                    {c.estimate_snapshot?.estimate && ` · 当时合算建议 ${c.estimate_snapshot.estimate.withRef.suggestedQty}`}
                  </div>
                ))}
              </div>
            )}

            <table className="grid mt8">
              <thead>
                <tr>
                  <th>时间</th><th>类型</th><th className="num">数量</th><th className="num">当时建议</th>
                  <th>状态</th><th>确认人</th><th>估计快照</th>
                </tr>
              </thead>
              <tbody>
                {detail.confirmations.length === 0 && <tr><td colSpan={7} className="muted">尚无确认记录</td></tr>}
                {detail.confirmations.map((c) => (
                  <tr key={c.id}>
                    <td className="small">{new Date(c.confirmed_at).toLocaleString('zh-CN')}</td>
                    <td>{c.kind === 'initial' ? '首批' : '加订'}</td>
                    <td className="num"><b>{Number(c.qty)}</b></td>
                    <td className="num muted">{c.estimate_snapshot?.estimate?.withRef?.suggestedQty ?? '—'}</td>
                    <td>
                      <span className={`badge ${c.status === 'pending' ? 'green' : 'amber'}`}>
                        {c.status === 'pending' ? '已确认' : '待处理'}
                      </span>
                    </td>
                    <td className="small">{c.confirmed_by}</td>
                    <td className="small muted">
                      {c.estimate_snapshot?.estimateRevision != null ? `估计 r${c.estimate_snapshot.estimateRevision}` : '—'}
                      {c.estimate_snapshot?.basis?.referenceInvalidated ? ' · 参照当时已失效' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>
              转正检查 <span className="sub">按连续有效营业日检查预测区间覆盖率与实际损耗；缺报或偏差过大的继续观察</span>
            </h3>
            {cov && (
              <>
                <div className="stat mb8">
                  <div><b>{cov.consecutiveValidDays}</b><span>连续有效营业日（≥{cov.rule.minValidDays}）</span></div>
                  <div><b>{(cov.coverage * 100).toFixed(1)}%</b><span>区间覆盖率（≥{(cov.rule.minCoverage * 100).toFixed(0)}%）</span></div>
                  <div><b>{(cov.wasteRate * 100).toFixed(1)}%</b><span>实际损耗率（≤{(cov.rule.maxWasteRate * 100).toFixed(0)}%）</span></div>
                  <div><b>{(cov.meanDeviation * 100).toFixed(1)}%</b><span>平均偏差（≤{(cov.rule.maxMeanDeviation * 100).toFixed(0)}%）</span></div>
                  <div>
                    <b>{cov.passed ? '通过' : '继续观察'}</b>
                    <span>{cov.consecutiveFrom ?? '—'} ~ {cov.consecutiveTo ?? '—'}</span>
                  </div>
                </div>
                {cov.reasons.length > 0 && (
                  <div className="small" style={{ color: 'var(--warn)' }}>{cov.reasons.join('；')}</div>
                )}
                <table className="grid mt8">
                  <thead>
                    <tr>
                      <th>营业日</th><th className="num">实际</th><th className="num">λ</th>
                      <th>90% 预测区间</th><th className="num">偏差</th><th>覆盖</th><th>完整性</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cov.days.slice().reverse().map((d) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td className="num">{d.actualSales}</td>
                        <td className="num">{d.lambdaDay}</td>
                        <td>{d.intervalLow} ~ {d.intervalHigh}</td>
                        <td className="num">{(d.deviation * 100).toFixed(1)}%</td>
                        <td>{d.covered ? <span className="badge green">覆盖</span> : <span className="badge red">未覆盖</span>}</td>
                        <td>
                          {d.complete
                            ? d.closedPeriods.length > 0
                              ? <span className="badge amber">含停业时段（不计时长）</span>
                              : <span className="badge green">完整</span>
                            : <span className="badge red">缺报 {d.missingPeriods.length} 段</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <div className="row mt16">
              <button className="primary" disabled={busy || !active || !cov?.passed} onClick={graduate}>
                转入正式预测
              </button>
              <span className="muted small">转正会冻结当时的参照、观测、决定与覆盖检查，后续正式预测可追溯</span>
            </div>
          </div>

          <div className="card">
            <h3>估计版本 <span className="sub">参照/观测每次变更产生新版本；确认过的版本冻结，历史版本可回溯</span></h3>
            <table className="grid">
              <thead>
                <tr>
                  <th>版本</th><th>触发</th><th className="num">合算建议</th><th className="num">取消参照</th>
                  <th className="num">λ</th><th>参照版本</th><th>冻结</th><th>时间</th>
                </tr>
              </thead>
              <tbody>
                {detail.estimates.map((e) => (
                  <tr key={e.id}>
                    <td>r{e.revision_no}</td>
                    <td>{TRIAL_ESTIMATE_TRIGGER[e.trigger] ?? e.trigger}</td>
                    <td className="num">{e.computed.withRef.suggestedQty}</td>
                    <td className="num muted">{e.computed.withoutRef.suggestedQty}</td>
                    <td className="num">{e.computed.withRef.lambda}</td>
                    <td className="small muted">
                      {e.basis_snapshot.referenceRevision != null ? `r${e.basis_snapshot.referenceRevision}` : '无'}
                      {e.basis_snapshot.referenceInvalidated ? '（已失效）' : ''}
                      {' · '}{e.basis_snapshot.observationRows} 条观测
                    </td>
                    <td>{e.frozen ? <span className="badge blue">已冻结</span> : <span className="muted small">—</span>}</td>
                    <td className="small">{new Date(e.created_at).toLocaleString('zh-CN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.plan.status !== 'selling' && detail.plan.graduated_snapshot != null && (
              <details className="mt8 small muted">
                <summary>查看冻结快照（{detail.plan.status === 'stopped' ? '停止时' : '转正时'}）</summary>
                <pre style={{ maxHeight: 240, overflow: 'auto', background: '#fafbfa', padding: 8 }}>
                  {JSON.stringify(detail.plan.graduated_snapshot, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </>
      )}
      {!detail && planList.length > 0 && <div className="card muted">选择上方计划查看参照、观测、决策与转正检查</div>}
    </>
  );
}
