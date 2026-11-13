import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../store';
import { REASON_CODES, TRIGGER_EVENTS } from '../types';
import type { Meta, SuggestionItem, SuggestionResponse } from '../types';

function newKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 建议与订货：
 * - 总部生成/事件重算 → 新修订版本（旧版本不可变）；同一到货日重复提交按幂等键并表；
 * - 门店只在当前版本上改量、记原因码并确认；确认与总部修订同时落库按落库先后裁定，败方收 409。
 */
export default function SuggestionsPage({ meta }: { meta: Meta | null }) {
  const { filters, user, draft, setDraft, clearDraft, showToast } = useApp();
  const [data, setData] = useState<SuggestionResponse | null>(null);
  const [viewVersionId, setViewVersionId] = useState<number | null>(null);
  const [viewItems, setViewItems] = useState<SuggestionItem[]>([]);
  const [event, setEvent] = useState('manual');
  const [features, setFeatures] = useState({ promotion: false, holiday: false, tempDrop: false, competitor: false, deliveryDelayHours: 0 });
  const [genKey, setGenKey] = useState(() => newKey('gen'));
  const [confirmKey, setConfirmKey] = useState(() => newKey('confirm'));
  const [busy, setBusy] = useState(false);

  const isHq = user?.role === 'hq';
  const isManager = user?.role === 'manager';

  const load = useCallback(async () => {
    if (!filters.storeId) return;
    try {
      const r = await api<SuggestionResponse>(
        `/api/suggestions?storeId=${filters.storeId}&arrivalDate=${filters.arrivalDate}`,
      );
      setData(r);
      setViewVersionId(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败');
    }
  }, [filters.storeId, filters.arrivalDate]);

  useEffect(() => { load(); }, [load]);

  // 查看历史版本（只读）
  useEffect(() => {
    if (!viewVersionId || !data?.currentVersion || viewVersionId === data.currentVersion.id) {
      setViewItems([]);
      return;
    }
    api<{ items: SuggestionItem[] }>(`/api/suggestions/versions/${viewVersionId}`)
      .then((r) => setViewItems(r.items))
      .catch((e) => showToast(e.message));
  }, [viewVersionId, data]);

  const viewingOld = viewVersionId !== null && data?.currentVersion && viewVersionId !== data.currentVersion.id;
  const items = viewingOld ? viewItems : (data?.items ?? []);
  const shownItems = useMemo(
    () => items.filter((i) => !filters.categoryId || i.category_id === filters.categoryId),
    [items, filters.categoryId],
  );

  const generate = async () => {
    if (!filters.storeId) return;
    setBusy(true);
    try {
      const r = await api<{ versionNo: number; idempotent: boolean }>('/api/suggestions/generate', {
        method: 'POST',
        body: {
          storeId: filters.storeId,
          arrivalDate: filters.arrivalDate,
          idempotencyKey: genKey,
          triggerEvent: event,
          features: { ...features, deliveryDelayHours: features.deliveryDelayHours || undefined },
        },
      });
      showToast(r.idempotent ? '重复提交已幂等合并，未产生新版本' : `已生成建议版本 v${r.versionNo}`);
      setGenKey(newKey('gen'));
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        showToast(`冲突：${e.message}`);
        await load(); // 落库先后裁定：本落败，刷新看对方结果
      } else {
        showToast(e instanceof Error ? e.message : '生成失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!data?.currentVersion) return;
    const payload = (data.items ?? []).map((i) => ({
      skuId: i.sku_id,
      qty: Number(draft[i.sku_id]?.qty ?? i.suggested_qty),
      reasonCode: draft[i.sku_id]?.reasonCode || undefined,
    }));
    if (payload.some((p) => !Number.isFinite(p.qty) || p.qty < 0)) {
      showToast('存在非法数量，请检查改量');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/versions/${data.currentVersion.id}/confirm`, {
        method: 'POST',
        body: { idempotencyKey: confirmKey, items: payload },
      });
      showToast('订单已确认，版本锁定');
      setConfirmKey(newKey('confirm'));
      clearDraft();
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        showToast(`冲突：${e.message}`);
        await load();
      } else {
        showToast(e instanceof Error ? e.message : '确认失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmed = !!data?.order;
  const canEdit = isManager && !confirmed && !viewingOld && !!data?.currentVersion;

  return (
    <>
      {isHq && (
        <div className="card">
          <h3>总部：生成 / 事件重算 <span className="sub">事件触发只产生新修订版本，不改写旧版本与已确认订单</span></h3>
          <div className="row">
            <label className="muted">触发事件
              <select value={event} onChange={(e) => setEvent(e.target.value)}>
                {Object.entries(TRIGGER_EVENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            {(['promotion', 'holiday', 'tempDrop', 'competitor'] as const).map((k) => (
              <label key={k} className="muted">
                <input
                  type="checkbox"
                  checked={features[k]}
                  onChange={(e) => setFeatures({ ...features, [k]: e.target.checked })}
                />
                {{ promotion: '促销', holiday: '节假日', tempDrop: '降温', competitor: '竞品新店' }[k]}
              </label>
            ))}
            <label className="muted">配送延误h
              <input
                type="number" min={0} max={12} style={{ width: 64 }}
                value={features.deliveryDelayHours}
                onChange={(e) => setFeatures({ ...features, deliveryDelayHours: Number(e.target.value) })}
              />
            </label>
            <button className="primary" disabled={busy || !filters.storeId} onClick={generate}>
              {data?.currentVersion ? '重算生成修订版本' : '生成建议表'}
            </button>
          </div>
        </div>
      )}

      {!data?.table && (
        <div className="card muted">
          {filters.storeId ? '该到货日暂无建议表' + (isHq ? '，请先生成' : '，总部尚未下发') : '请选择门店'}
        </div>
      )}

      {data?.table && (
        <div className="card">
          <div className="tabs">
            {data.versions.map((v) => (
              <button
                key={v.id}
                className={(viewVersionId ?? data.currentVersion?.id) === v.id ? 'active' : ''}
                onClick={() => setViewVersionId(v.id)}
              >
                v{v.version_no} · {TRIGGER_EVENTS[v.trigger_event] ?? v.trigger_event}
                {v.status === 'locked' ? ' · 已锁定' : v.status === 'superseded' ? ' · 已修订' : ''}
              </button>
            ))}
          </div>
          {viewingOld && <div className="badge amber">正在查看历史版本（只读，不可变）</div>}
          {data.currentVersion && !viewingOld && (
            <div className="kv mb8">
              <span>口径：观测需求（还原后）</span>
              <span>样本窗口：{data.currentVersion.feature_snapshot.sampleWindowDays} 天</span>
              {Object.entries(data.currentVersion.cost_snapshot.categories).map(([code, c]) => (
                <span key={code}>{code === 'LEAFY' ? '叶菜' : '根茎'} τ={c.tau.toFixed(2)}（Cu={c.cu}/Co={c.co}）</span>
              ))}
              <span>取整：向上到最小订货单位</span>
            </div>
          )}
          <table className="grid mt8">
            <thead>
              <tr>
                <th>SKU</th><th>品类</th><th className="num">分位 τ</th>
                <th className="num">系统建议</th><th className="num">取整前</th><th>模型备注</th>
                {isManager && !confirmed && !viewingOld && <th className="num">门店改量</th>}
                {isManager && !confirmed && !viewingOld && <th>原因码</th>}
              </tr>
            </thead>
            <tbody>
              {shownItems.map((i) => (
                <tr key={i.sku_id}>
                  <td>{i.sku_name}{i.is_new && <span className="badge blue"> 新品</span>}</td>
                  <td>{i.category_name}</td>
                  <td className="num">{Number(i.quantile).toFixed(2)}</td>
                  <td className="num"><b>{Number(i.suggested_qty)}</b> {i.unit}</td>
                  <td className="num muted">{Number(i.raw_qty).toFixed(1)}</td>
                  <td className="small muted">{i.model_note ?? ''}</td>
                  {canEdit && (
                    <td className="num">
                      <input
                        type="number" min={0} style={{ width: 80, textAlign: 'right' }}
                        value={draft[i.sku_id]?.qty ?? String(i.suggested_qty)}
                        onChange={(e) => setDraft(i.sku_id, { qty: e.target.value })}
                      />
                    </td>
                  )}
                  {canEdit && (
                    <td>
                      <select
                        value={draft[i.sku_id]?.reasonCode ?? ''}
                        onChange={(e) => setDraft(i.sku_id, { reasonCode: e.target.value })}
                      >
                        <option value="">（无调整）</option>
                        {REASON_CODES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {canEdit && (
            <div className="mt16 row">
              <button className="primary" disabled={busy} onClick={confirm}>确认订单（锁定当前版本）</button>
              <span className="muted small">重复提交按幂等键合并；若总部修订先落库，将收到冲突提示</span>
            </div>
          )}
        </div>
      )}

      {data?.order && (
        <div className="card">
          <h3>
            已确认订单 <span className="sub">版本 v{data.versions.find((v) => v.id === data.order?.version_id)?.version_no} · {data.order.confirmed_by} · {new Date(data.order.confirmed_at).toLocaleString('zh-CN')} · 原样保留供复盘归因</span>
          </h3>
          <table className="grid">
            <thead>
              <tr><th>SKU</th><th className="num">确认量</th><th className="num">当时建议</th><th>原因码</th></tr>
            </thead>
            <tbody>
              {(data.orderItems ?? [])
                .filter((i) => {
                  const sku = meta?.skus.find((s) => s.id === i.sku_id);
                  return !filters.categoryId || sku?.category_id === filters.categoryId;
                })
                .map((i) => (
                  <tr key={i.sku_id}>
                    <td>{i.sku_name}</td>
                    <td className="num"><b>{Number(i.qty)}</b></td>
                    <td className="num muted">{Number(i.suggested_qty)}</td>
                    <td>{i.reason_code ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
